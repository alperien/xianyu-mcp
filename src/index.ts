#!/usr/bin/env node
/**
 * MCP stdio entry point. An MCP client runs `node` as `command` and this file's installed path as
 * `args`; README.md spells the block out. This file used to carry a config snippet of its own and it
 * was not valid MCP config, so it went. The account-free pitch lives in the `instructions` string
 * below and in the README, where it belongs.
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getSession } from './browser.ts';
import { describe } from './errors.ts';
import { TOOLS } from './tools.ts';

    // The version the MCP handshake advertises is package.json's, read rather than written a second
    // time. It used to be a literal here and the two drifted unnoticed: `npm version` moved package.json
    // and the server went on claiming the old number. `../package.json` resolves from src/ and from
    // dist/ alike, and npm ships package.json even though `files` does not list it.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const mcp = new McpServer({ name: 'xianyu', version }, {
  instructions: 'Read-only access to Xianyu/Goofish with NO Xianyu account required. All ten tools -- capabilities, browse_feed, search_count, search_suggest, search_items, related_items, item_view, recommendations, seller_profile, seller_items -- work logged out. Search is a keystroke rather than a URL and is declined by goofish on some page loads, so search_items retries and refuses to return the recommendation rail as results; item_view and search_items read the calls the page makes for itself, which is the only way those two answer. The mtop-only tools run on their own page and do not queue behind a search. seller_profile and seller_items take either a seller id (one cheap mtop call) or a listing id, meaning the seller of that listing, which costs one page load and also yields their city, tenure and sales history. Call capabilities for the current verified picture.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: any) => {
    // Nothing is serialised here. The three DOM tools (`search_items`, `item_view`, `recommendations`)
    // take the shared-page lock themselves in tools.ts, because only they read the one navigating page;
    // the mtop-only tools must stay free so a 70s search does not hold up a 1.5s feed call. Wrapping
    // every tool here -- which this used to do -- re-imposed exactly that queue.
    let envelope: any;
    try {
      envelope = { ok: true, data: await t.run(args) };
    } catch (e) {
      envelope = { ok: false, ...describe(e) };
    }
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope };
  });
}

    // The one thing this server does before it has been asked for anything: pay the session's first
    // load. That load is 12.4s for an item page and 15-41s for the first search against ~1.6s warm,
    // and it lands on whoever asks first -- for an MCP client, the user's first question. So it starts
    // here, in the background, on a page no tool will ever see (`Session.warmUp`), never awaited.
void getSession().warmUp().catch(() => {});

if (process.stdin.isTTY) {
  process.stderr.write('xianyu-mcp is an MCP stdio server and cannot be used interactively.\nConfigure it in an MCP client instead (see README.md).\n');
  process.exit(2);
}
const transport = new StdioServerTransport();
    // One shutdown path for every way out: stdin closing (a client that just goes away never sends a
    // signal), a supervisor, and a crash. Re-entrancy here was a leak, not a safety net -- closing
    // stdin emits BOTH `end` and `close`, so the second call called `process.exit` mid-`browser.close()`
    // and orphaned the windowed Chromium (15 after one audit). The guard returns and lets it finish.
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
