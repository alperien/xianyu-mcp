#!/usr/bin/env node
/** MCP stdio entry point. Register it with an MCP client exactly as README.md shows it -- `node /path/to/xianyu-mcp/dist/index.js` as `command` + `args`; this file used to carry an inline config snippet of its own and it was not valid MCP config. No Xianyu account, no cookies, no stored credentials, no write tools: the server launches its own Chromium and reads goofish the way an anonymous visitor's browser does. */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getSession } from './browser.ts';
import { describe } from './errors.ts';
import { TOOLS } from './tools.ts';

// The version the MCP handshake advertises is package.json's, read rather than written down a second
// time. It used to be a literal here, and the two drifted without anything noticing: `npm version`
// moved package.json and the server went on claiming the old number to every client that asked.
// `../package.json` is one level up from src/ (run straight from a checkout) and from dist/ (the
// prebuilt tarball) alike, and npm always ships package.json even though `files` does not list it.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const mcp = new McpServer({ name: 'xianyu', version }, {
  instructions: 'Read-only access to Xianyu/Goofish with NO Xianyu account required. All eight tools -- capabilities, browse_feed, search_count, search_suggest, search_items, related_items, item_view, recommendations -- work logged out. Search is a keystroke rather than a URL and is declined by goofish on some page loads, so search_items retries and refuses to return the recommendation rail as results; item_view and search_items read the calls the page makes for itself, which is the only way those two answer. The four mtop-only tools run on their own page and do not queue behind a search. Call capabilities for the current verified picture.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: any) => {
    // Nothing is serialised here. The three DOM tools (`search_items`, `item_view`, `recommendations`)
    // take the shared-page lock themselves, in tools.ts, because only they read the one navigating
    // page; the four mtop-only tools must stay free so a 70s search does not hold up a 1.5s feed call.
    // Wrapping every tool here -- which this used to do -- re-imposed exactly that queue.
    // Anything unexpected is still reported under its own error type rather than being allowed to kill
    // the MCP call.
    let envelope: any;
    try {
      envelope = { ok: true, data: await t.run(args) };
    } catch (e) {
      envelope = { ok: false, ...describe(e) };
    }
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope };
  });
}

if (process.stdin.isTTY) {
  process.stderr.write('xianyu-mcp is an MCP stdio server and cannot be used interactively.\nConfigure it in an MCP client instead (see README.md).\n');
  process.exit(2);
}
const transport = new StdioServerTransport();
// One shutdown path for every way out, because this process holds a real windowed Chromium and the
// browser has to be torn down deliberately rather than left for the OS. Four things reach it: the
// client closing stdin (the normal case -- a client that just goes away never sends a signal), a
// supervisor, and a crash.
//
// Re-entrancy here was a leak, not a safety net. Closing stdin emits BOTH `end` and `close`, so the
// second call reached the guard and called `process.exit` while the first call's teardown was still
// in flight -- the node process died mid-`browser.close()` and left the windowed Chromium running,
// reparented to init. Measured: 15 orphaned processes after one audit run. So the guard returns and
// lets the in-flight teardown finish; `Session.close` is bounded at 5s and escalates to SIGKILL, so
// it cannot be the thing that hangs.
let closing = false;
const shutdown = (code: number): void => {
  if (closing) return;                 // a teardown is already running and will exit when it is done
  closing = true;
  void getSession().close().catch(() => {}).finally(() => process.exit(code));
};
transport.onclose = () => shutdown(0);
// The SDK's stdio transport listens for `data` and `error` on stdin but not for its *end*, so a client
// that closes stdin -- the ordinary way a client goes away -- never triggers `onclose` and this
// process sits there holding a windowed Chromium until someone notices. Watch for it here.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(signal, () => shutdown(0));
// The `exit` hook cannot await, so it does the one thing that is synchronous and guaranteed to land:
// SIGKILL the browser process itself. It covers the path none of the above do -- a crash handler or an
// unhandled rejection taking the process down -- where an awaited teardown would simply never run.
process.on('exit', () => { getSession().killBrowser(); });
await mcp.connect(transport);
