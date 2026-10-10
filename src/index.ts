#!/usr/bin/env node
/** MCP stdio entry point. Clients run `node` with this file's installed path as `args`; see README.md
 * for the configuration block. Client-facing instructions are published below. */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getSession } from './browser.ts';
import { describe } from './errors.ts';
import { TOOLS } from './tools.ts';

    // Read the handshake version from package.json to keep it in sync with releases. This path works
    // from both src/ and dist/, and npm includes package.json in the published package.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const mcp = new McpServer({ name: 'xianyu', version }, {
  instructions: 'Read-only access to Xianyu/Goofish with NO Xianyu account required. All ten tools -- capabilities, browse_feed, search_count, search_suggest, search_items, related_items, item_view, recommendations, seller_profile, seller_items -- work logged out. Search is a keystroke rather than a URL and is declined by goofish on some page loads, so search_items retries and refuses to return the recommendation rail as results; item_view and search_items read the calls the page makes for itself, which is the only way those two answer. The mtop-only tools run on their own page and do not queue behind a search. seller_profile and seller_items take either a seller id (one cheap mtop call) or a listing id, meaning the seller of that listing, which costs one page load and also yields their city, tenure and sales history. Call capabilities for the current verified picture.',
});

for (const t of TOOLS) {
  mcp.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args: any) => {
    // DOM tools lock the shared navigating page in tools.ts. Mtop-only calls remain concurrent so a
    // slow search does not block feed requests.
    let envelope: any;
    try {
      envelope = { ok: true, data: await t.run(args) };
    } catch (e) {
      envelope = { ok: false, ...describe(e) };
    }
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope };
  });
}

    // Warm the browser in the background so the first tool call does not pay the cold-load delay.
    // Session.warmUp uses a separate page and is intentionally not awaited.
void getSession().warmUp().catch(() => {});

if (process.stdin.isTTY) {
  process.stderr.write('xianyu-mcp is an MCP stdio server and cannot be used interactively.\nConfigure it in an MCP client instead (see README.md).\n');
  process.exit(2);
}
const transport = new StdioServerTransport();
    // stdin may emit both end and close. Ignore the second shutdown call so it cannot exit while
    // browser.close() is still running.
let closing = false;
const shutdown = (code: number): void => {
  if (closing) return;                 // a teardown is already running and will exit when it is done
  closing = true;
  void getSession().close().catch(() => {}).finally(() => process.exit(code));
};
transport.onclose = () => shutdown(0);
// The stdio transport does not handle stdin's end event, so close the browser when the client exits.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('close', () => shutdown(0));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(signal, () => shutdown(0));
// The exit hook cannot await teardown; kill Chromium synchronously if the process exits unexpectedly.
process.on('exit', () => { getSession().killBrowser(); });
await mcp.connect(transport);
