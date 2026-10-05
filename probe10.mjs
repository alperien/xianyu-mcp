/**
 * For TARGET 5: does a retry have to pay a cold load? `reloadFresh` used to make the cache-busted load
 * its first choice and the plain reload its fallback, which is backwards for a retry -- a URL with a
 * fresh nonce is one the HTTP cache has never seen, so every byte comes back from the network over a
 * fresh request, while a plain reload revalidates over the connection and cache the session already
 * has open. This measures the two against the same URL, alternating, so the answer is not drift.
 *
 *   node probe10.mjs
 */
import { chromium } from 'playwright';
import { getSession, HOME } from './src/browser.ts';
import { TOOLS } from './src/tools.ts';

const WAIT_MS = 32_000;
const DETAIL_API = 'mtop.taobao.idle.pc.detail';
const s = (ms) => (ms / 1000).toFixed(1) + 's';
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

const feed = await TOOLS.find((t) => t.name === 'browse_feed').run({ page_number: 1, pages: 1, limit: 30 });
const id = (feed.items || []).map((i) => String(i.item_id)).filter(Boolean)[0];
const url = `${HOME}item?id=${id}`;
console.log(`item ${id}\n`);

const browser = await chromium.launch({ headless: process.env.XIANYU_HEADLESS === '1', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-default-browser-check', '--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
console.log(`first load, nothing cached: ${s(0)}\n`);

const awaitDetail = (item, budgetMs) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
  const timer = setTimeout(() => done({ ok: false, ret: 'none' }), budgetMs);
  page.on('response', (res) => {
    if (res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/)?.[1] !== DETAIL_API) return;
    res.json().then((j) => done({ ok: String(j?.ret ?? '').includes('SUCCESS'), ret: String(j?.ret ?? ''), item_id: String(j?.data?.itemDO?.itemId ?? '') }), () => {});
  });
});

const rows = [];
// The first pass warms the document for both arms; the medians below are the passes after that,
// because "warm" is the state a retry actually happens in.
for (let i = 0; i < 8; i++) {
  for (const arm of i % 2 ? ['bust', 'reload'] : ['reload', 'bust']) {
    const pending = awaitDetail(id, WAIT_MS);
    const began = Date.now();
    const target = arm === 'reload' ? null : `${url}&_r${Date.now()}`;
    if (target === null) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    else await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    const doc = Date.now() - began;
    const reply = await pending;
    rows.push({ arm, n: i, doc_ms: doc, detail_ms: Date.now() - began, answered: reply.ok });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
const warm = rows.filter((r) => r.n > 0);
for (const arm of ['reload', 'bust']) {
  const mine = warm.filter((r) => r.arm === arm);
  console.log(`${arm.padEnd(6)} n=${mine.length}  document median ${s(median(mine.map((r) => r.doc_ms)))}  [${s(Math.min(...mine.map((r) => r.doc_ms)))}-${s(Math.max(...mine.map((r) => r.doc_ms)))}]  detail-answer median ${s(median(mine.filter((r) => r.answered).map((r) => r.detail_ms)))}  answered ${mine.filter((r) => r.answered).length}/${mine.length}`);
}
await browser.close();
await getSession().close().catch(() => {});
process.exit(0);