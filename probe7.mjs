/**
 * The two measurements xi-x8x asks for, against the live site:
 *
 *   node probe7.mjs spa       -- is an item's detail cheaper on a same-document SPA route change
 *                                 than on a full page load? Arms alternate, so goofish's own drift
 *                                 cannot favour one of them.
 *   node probe7.mjs parallel  -- does item detail parallelise at all? 4 pages at once against serial,
 *                                 both through the same headed context and the same options Session uses.
 *
 * Both read the page's own `mtop.taobao.idle.pc.detail` reply off the wire, which is the only route
 * to a listing (see browser.ts), so "answered" here means item_view would have answered. Numbers, not
 * adjectives: the bead asks for both to be proven rather than assumed.
 */
import { chromium } from 'playwright';
import { getSession, HOME } from './src/browser.ts';
import { TOOLS } from './src/tools.ts';

const DETAIL_API = 'mtop.taobao.idle.pc.detail';
// item_view's own window for this reply (ITEM_READY_WAIT_MS in tools.ts), because a probe that judges
// an arm with a shorter clock than the code it is measuring will call a slow answer a failure. An
// earlier run of this file at 15s reported "4 parallel pages, zero replies" -- probe9 shows the reply
// routinely lands 9-17s after the document, so that was the probe being impatient, not goofish refusing.
const WAIT_MS = 32_000;
const mode = process.argv[2] || 'spa';
const s = (ms) => (ms / 1000).toFixed(1) + 's';
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
/** Wait for a detail reply about `item`, discarding any that are about something else. `ok:false` is a
 *  listing goofish declined or has no answer for, and is recorded rather than retried into a better number.
 *  A flag rather than `page.off`, which does not exist -- and the listener is left in place either way,
 *  because the Session's own tap is on the same page and has to survive this. */
const awaitDetail = async (page, item, budgetMs = WAIT_MS) => {
  const until = Date.now() + budgetMs;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) return { ok: false, ret: 'no reply', item_id: '' };
    const reply = await new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => done(null), left);
      page.on('response', (res) => {
        if (res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/)?.[1] !== DETAIL_API) return;
        res.json().then((j) => done({ ok: String(j?.ret ?? '').includes('SUCCESS'), ret: Array.isArray(j?.ret) ? j.ret.join(' | ') : String(j?.ret ?? ''), item_id: String(j?.data?.itemDO?.itemId ?? '') }), () => {});
      });
    });
    if (!reply) return { ok: false, ret: 'no reply', item_id: '' };
    if (reply.item_id && reply.item_id !== item) continue;      // a leftover for another listing
    return reply;
  }
};

const liveIds = async (n) => {
  const feed = await TOOLS.find((t) => t.name === 'browse_feed').run({ page_number: 1, pages: 1, limit: 30 });
  return (feed.items || []).map((i) => String(i.item_id)).filter(Boolean).slice(0, n);
};

const SPA_ROUTE = (url) => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); };

const spa = async () => {
  const ids = await liveIds(9);
  console.log(`ids: ${ids.join(' ')}\n`);
  const session = getSession();
  const warm = Date.now();
  const page = await session.open(`${HOME}item?id=${ids[0]}`);
  console.log(`warm full load of ${ids[0]}: ${s(Date.now() - warm)} (this is the cold-ish cost every later arm avoids)`);
  const rows = [];
  for (const item of ids.slice(1)) {
    for (const arm of ['load', 'spa']) {
      session.domTap.clear();
      const began = Date.now();
      // The listener goes on BEFORE the navigation, or a reply that lands during `open()` is missed
      // and the arm is recorded as a 15s timeout that says nothing about the arm.
      const pending = awaitDetail(page, item);
      if (arm === 'spa') {
        // Same document: push the URL and fire the popstate the router listens for. Nothing is
        // re-fetched if this works, which is the whole claim under test.
        const pushed = await page.evaluate((u) => { try { history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); return true; } catch (e) { return String(e); } }, `${HOME}item?id=${item}`);
        if (pushed !== true) { rows.push({ arm, item, error: String(pushed).slice(0, 100) }); console.log(JSON.stringify(rows.at(-1))); continue; }
      } else { await session.open(`${HOME}item?id=${item}`); }
      const reply = await pending;
      rows.push({ arm, item, answer_ms: Date.now() - began, ok: reply.ok, ret: reply.ret, served: reply.item_id, url: page.url().slice(0, 60) });
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
  const good = (arm) => rows.filter((r) => r.arm === arm && r.ok).map((r) => r.answer_ms);
  const total = (arm) => rows.filter((r) => r.arm === arm).map((r) => r.answer_ms);
  console.log(`\nspa   answered ${good('spa').length}/${rows.filter((r) => r.arm === 'spa').length}  median ${s(median(good('spa')))}  all ${s(median(total('spa')))}`);
  console.log(`load  answered ${good('load').length}/${rows.filter((r) => r.arm === 'load').length}  median ${s(median(good('load')))}  all ${s(median(total('load')))}`);
};

const parallel = async () => {
  const ids = await liveIds(8);
  console.log(`ids: ${ids.join(' ')}\n`);
  const browser = await chromium.launch({ headless: process.env.XIANYU_HEADLESS === '1', args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-default-browser-check', '--disable-gpu'] });
  const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
  const four = ids.slice(0, 4);
  const serialRows = [];
  const one = await ctx.newPage();
  for (const item of four) {
    const began = Date.now();
    const pending = awaitDetail(one, item);
    await one.goto(`${HOME}item?id=${item}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    const reply = await pending;
    serialRows.push({ item, ms: Date.now() - began, ok: reply.ok });
    console.log(`serial   ${JSON.stringify(serialRows.at(-1))}`);
  }
  const serialWall = serialRows.reduce((a, r) => a + r.ms, 0);
  const pages = await Promise.all(four.map(() => ctx.newPage()));
  const wallStart = Date.now();
  const parRows = await Promise.all(four.map(async (item, i) => {
    const t = Date.now();
    const pending = awaitDetail(pages[i], item);
    await pages[i].goto(`${HOME}item?id=${item}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    const reply = await pending;
    return { item, ms: Date.now() - t, ok: reply.ok };
  }));
  const parWall = Date.now() - wallStart;
  for (const r of parRows) console.log(`parallel ${JSON.stringify(r)}`);
  const serialPer = serialWall / four.length, parPer = parWall / four.length;
  console.log(`\nserial   ${s(serialPer)} per listing, ${four.length} listings in ${s(serialWall)}`);
  console.log(`parallel ${s(parPer)} per listing, ${four.length} listings in ${s(parWall)} wall`);
  console.log(`speed-up ${(serialPer / parPer).toFixed(2)}x  (4.00x is what free parallelism would look like; ~1.0x means goofish throttles per IP)`);
  await browser.close();
};

try { if (mode === 'spa') await spa(); else await parallel(); }
catch (e) { console.error('probe failed:', e); }
finally { await getSession().close().catch(() => {}); process.exit(0); }