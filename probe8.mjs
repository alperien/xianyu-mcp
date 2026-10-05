/**
 * Why did `probe7.mjs spa` answer 0/8? This is the follow-up that decides whether an SPA route change
 * is reachable at all, and if so by which trigger -- the router instance, a history call, or a real
 * link. Three candidates are tried on one already-warm item page, each against a different live id,
 * and each judged the same way: did goofish's own detail call go out, and how long after the trigger.
 *
 *   node probe8.mjs
 */
import { getSession, HOME } from './src/browser.ts';
import { TOOLS } from './src/tools.ts';

const DETAIL_API = 'mtop.taobao.idle.pc.detail';
const s = (ms) => (ms / 1000).toFixed(1) + 's';

/** A listener that resolves on the next detail reply *about `item`*, attached before the trigger -- a
 *  reply that lands during it is missed, and a reply about another listing is not an answer. Playwright
 *  has no page.off, so the flag does the work. */
const awaitDetail = async (page, item, budgetMs = 12_000) => {
  const until = Date.now() + budgetMs;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) return { ok: false, ret: 'no detail call for it in the window' };
    const reply = await new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => done(null), left);
      page.on('response', (res) => {
        if (res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/)?.[1] !== DETAIL_API) return;
        res.json().then((j) => done({ ok: String(j?.ret ?? '').includes('SUCCESS'), ret: String(j?.ret ?? ''), item_id: String(j?.data?.itemDO?.itemId ?? '') }), () => {});
      });
    });
    if (!reply) return { ok: false, ret: 'no detail call for it in the window' };
    if (reply.item_id && reply.item_id !== item) continue;      // a leftover for the listing already on the page
    return reply;
  }
};

const feed = await TOOLS.find((t) => t.name === 'browse_feed').run({ page_number: 1, pages: 1, limit: 30 });
const ids = (feed.items || []).map((i) => String(i.item_id)).filter(Boolean).slice(0, 5);
console.log(`ids: ${ids.join(' ')}`);

const session = getSession();
const page = await session.open(`${HOME}item?id=${ids[0]}`);
console.log(`warm page loaded: ${page.url()}\n`);

const globals = await page.evaluate(() => {
  const app = document.querySelector('#app') ?? document.body;
  return {
    window_keys: Object.keys(window).filter((k) => /vue|router|INITIAL|STATE|NUXT|APP/i.test(k)).slice(0, 30),
    app_props: Object.keys(app ?? {}).filter((k) => k.startsWith('__')),
    has_initial_state: typeof window.__INITIAL_STATE__,
    initial_state_keys: typeof window.__INITIAL_STATE__ === 'object' && window.__INITIAL_STATE__ ? Object.keys(window.__INITIAL_STATE__).slice(0, 20) : [],
    links: [...document.querySelectorAll('a[href*="/item?id="]')].slice(0, 5).map((a) => a.getAttribute('href')),
    title: document.title,
  };
});
console.log('globals on the item page:');
console.log(JSON.stringify(globals, null, 1));

// One warm page, three triggers, three different live ids, judged the same way.
const trials = [
  ['router via the page\'s own micro-frontend context', async (id) => page.evaluate((u) => {
    const ctx = window.__ICE_APP_CONTEXT__;
    if (!ctx) return 'no __ICE_APP_CONTEXT__';
    const app = ctx.apps?.[0] ?? Object.values(ctx.apps ?? {})[0];
    const router = app?.router ?? ctx.router ?? app?.app?.config?.globalProperties?.$router;
    if (!router) return `context keys: ${Object.keys(ctx).join(',')} / app keys: ${app ? Object.keys(app).join(',') : '(no app)'}`;
    router.push(u);
    return true;
  }, `${HOME}item?id=${id}`)],
  ['history.pushState + popstate (probe7 arm)', async (id) => page.evaluate((u) => { history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); return true; }, `${HOME}item?id=${id}`)],
  ['a real link click on the page\'s own rail', async (id) => page.evaluate((target) => {
    const a = [...document.querySelectorAll('a[href*="/item?id="]')].find((x) => x.getAttribute('href').includes(target));
    if (!a) return 'no link to that listing on this page';
    a.click();
    return true;
  }, id)],
];

for (const [name, trigger] of trials) {
  const id = ids[trials.findIndex((t) => t[0] === name) + 1];
  const pending = awaitDetail(page, id);
  const began = Date.now();
  const fired = await trigger(id);
  const reply = await pending;
  const after = await page.evaluate(() => ({ href: location.href, title: document.title })).catch(() => ({}));
  console.log(`\n${name}\n  fired: ${String(fired).slice(0, 120)}\n  target ${id}: ${reply.ok ? 'ANSWERED' : 'no detail call'} ${reply.ret} served=${reply.item_id} in ${s(Date.now() - began)}\n  url now: ${after.href}  title: ${after.title}`);
  if (reply.ok) break;   // one working trigger is all this needs to find
}

await getSession().close().catch(() => {});
process.exit(0);