/**
 * Where item_view's time actually goes, and what a decline costs. `probe7.mjs` established that the
 * item page cannot be route-changed (0/8 answered; the app is an ICE micro-frontend with no reachable
 * router and no item links on the page), so the full page load is not avoidable and the honest
 * question becomes: of the ~11s a warm load takes, how much is the document, and how much is
 * goofish's own detail call -- and how long does a *declined* load take to be recognised?
 *
 * The decline arm is the one TARGET 5 turns on. Today a decline is noticed when the detail poll runs
 * out, so every declined load costs the whole wait; this measures how early the response itself gives
 * it away, which is the ceiling on what an early check can save.
 *
 *   node probe9.mjs
 */
import { chromium } from 'playwright';
import { getSession, HOME } from './src/browser.ts';
import { TOOLS } from './src/tools.ts';

const DETAIL_API = 'mtop.taobao.idle.pc.detail';
// The markers `extract.ts` already scrapes for: the risk-control page and goofish's own error page.
const DECLINED_JS = () => {
  const text = document.body?.innerText ?? '';
  return { risk_control: /非法访问|使用正常浏览器|访问闲鱼/.test(text), site_error: /网络不见了|服务异常|页面不存在|网络异常/.test(text), chars: text.length, title: document.title };
};
const s = (ms) => (ms / 1000).toFixed(1) + 's';

const feed = await TOOLS.find((t) => t.name === 'browse_feed').run({ page_number: 1, pages: 1, limit: 30 });
const ids = (feed.items || []).map((i) => String(i.item_id)).filter(Boolean).slice(0, 10);
console.log(`ids: ${ids.join(' ')}\n`);

const browser = await chromium.launch({ headless: process.env.XIANYU_HEADLESS === '1', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-default-browser-check', '--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

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
for (const [i, item] of ids.entries()) {
  const pending = awaitDetail(item, 32_000);
  const began = Date.now();
  await page.goto(`${HOME}item?id=${item}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  const tGoto = Date.now();
  // How early does the response itself say "you have been declined"? Polled on the same clock as the
  // detail reply, so the two are directly comparable.
  let seen = null, tSeen = 0;
  for (let poll = 0; poll < 16; poll++) {
    const verdict = await page.evaluate(DECLINED_JS).catch(() => null);
    if (verdict && (verdict.risk_control || verdict.site_error)) { seen = verdict; tSeen = Date.now(); break; }
    await page.waitForTimeout(250);
  }
  const tSeenAt = tSeen || Date.now();
  const reply = await pending;
  const row = {
    item, n: i, goto_ms: tGoto - began, declined: seen ? (seen.risk_control ? 'risk_control' : 'site_error') : 'no',
    declined_at_ms: seen ? tSeenAt - began : null, declined_chars: seen?.chars ?? null,
    answered: reply.ok, detail_ms: Date.now() - began, detail_after_goto_ms: Date.now() - tGoto, ret: reply.ret,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const ok = rows.filter((r) => r.answered);
const num = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
console.log(`\nanswered ${ok.length}/${rows.length}`);
if (ok.length) {
  console.log(`  document load (domcontentloaded)  median ${s(num(ok.map((r) => r.goto_ms)))}   [${s(Math.min(...ok.map((r) => r.goto_ms)))}-${s(Math.max(...ok.map((r) => r.goto_ms)))}]`);
  console.log(`  detail reply, total              median ${s(num(ok.map((r) => r.detail_ms)))}   [${s(Math.min(...ok.map((r) => r.detail_ms)))}-${s(Math.max(...ok.map((r) => r.detail_ms)))}]`);
  console.log(`  detail reply, after the document  median ${s(num(ok.map((r) => r.detail_after_goto_ms)))}`);
}
const declined = rows.filter((r) => r.declined !== 'no');
if (declined.length) console.log(`  declined loads: ${declined.length}/${rows.length}, named by the response at median ${s(num(declined.map((r) => r.declined_at_ms)))} against a ${s(32_000)} detail wait`);
await browser.close();
await getSession().close().catch(() => {});
process.exit(0);