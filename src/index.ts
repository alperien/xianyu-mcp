#!/usr/bin/env node
/** MCP stdio entry point. Register it with an MCP client exactly as README.md shows it -- `node /path/to/xianyu-mcp/dist/index.js` as `command` + `args`; this file used to carry an inline config snippet of its own and it was not valid MCP config. No Xianyu account, no cookies, no stored credentials, no write tools: the server launches its own Chromium and reads goofish the way an anonymous visitor's browser does. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { exclusive, getSession } from './browser.ts';
import { describe } from './errors.ts';
import { TOOLS } from './tools.ts';

const mcp = new McpServer({ name: 'xianyu', version: '0.1.0' }, {
  instructions: 'Read-only access to Xianyu/Goofish with NO Xianyu account required. All eight tools -- capabilities, browse_feed, search_count, search_suggest, search_items, related_items, item_view, recommendations -- work logged out. Anonymous search is declined by goofish on some page loads, so search_items retries and refuses to return the recommendation rail as results. Call capabilities for the current verified picture.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: any) => {
    // Calls are serialised: the session is one browser and one page, so two tools in flight at once would navigate it out from under each other and one would report the other's page as its own data. Anything unexpected is reported under its own error type rather than being allowed to kill the MCP call.
    let envelope: any;
    try {
      envelope = { ok: true, data: await exclusive(() => t.run(args)) };
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
transport.onclose = () => { void getSession().close(); };   // do not leave a Chromium process running
// A client that stops reading, or a supervisor that sends a signal, closes neither the transport nor
// stdin -- and this process holds a real windowed Chromium, so the browser has to be torn down on the
// way out rather than left for the OS. `once`, and re-entrant, because SIGINT then SIGTERM within a
// second of each other is the normal shape of a Ctrl-C and a supervisor following it.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void getSession().close().catch(() => {}).finally(() => process.exit(0));
  });
}
// The browser dies with us either way; this only makes it prompt rather than incidental, and covers
// the case where a crash handler or an unhandled rejection takes the process down instead of a signal.
process.on('exit', () => { void getSession().close(); });
await mcp.connect(transport);
