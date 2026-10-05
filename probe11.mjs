/**
 * The before/after the bead asks for: per-call latency for `item_view` in a session that has paid its
 * first load at boot, against one that has not and makes the user pay it on the first call. Arms
 * alternate so drift in goofish's own throttling lands on both, and every arm gets a brand-new Session
 * -- the whole point is what a session that has never run a tool costs.
 *
 * The `warm` arm awaits `warmUp()` and then starts the clock, because that is the user's position: the
 * server has been up, it warmed itself, and now the first question arrives.
 *
 *   node probe11.mjs
 */
import { Session, setSession } from './src/browser.ts';
import { TOOLS } from './src/tools.ts';

const s = (ms) => (ms / 1000).toFixed(1) + 's';
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };

const feed0 = await (async () => { const prev = new Session(); setSession(prev); try { return await TOOLS.find((t) => t.name === 'browse_feed').run({ page_number: 1, pages: 1, limit: 30 }); } finally { await prev.close().catch(() => {}); } })();
const ids = (feed0.items || []).map((i) => String(i.item_id)).filter(Boolean).slice(0, 8);
console.log(`ids: ${ids.join(' ')}\n`);

const rows = [];
const arms = ['cold', 'warm', 'warm', 'cold', 'cold', 'warm', 'cold', 'warm', 'warm', 'cold'];
for (const [i, arm] of arms.entries()) {
  const id = ids[i % ids.length];
  const session = new Session();
  setSession(session);
  let began = 0;
  try {
    if (arm === 'warm') await session.warmUp();
    began = Date.now();
    const out = await TOOLS.find((t) => t.name === 'item_view').run({ item_id: id });
    const row = { arm, item: id, ms: Date.now() - began, ok: out.ok !== false, source: out.source, warm: `${session.warm.status}/${session.warm.ms}ms`,
      last_load: `${session.lastLoad.declined || 'served'} in ${session.lastLoad.ms}ms`, launches: session.launches };
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (e) {
    rows.push({ arm, item: id, ms: Date.now() - began, ok: false, error: `${e?.error_type ?? e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 120)}`, warm: `${session.warm.status}/${session.warm.ms}ms`, last_load: `${session.lastLoad.declined || 'served'} in ${session.lastLoad.ms}ms` });
    console.log(JSON.stringify(rows.at(-1)));
  } finally {
    setSession(null);
    await session.close().catch(() => {});
  }
}
const pick = (arm, key = 'ms') => rows.filter((r) => r.arm === arm).map((r) => r[key]);
for (const arm of ['cold', 'warm']) {
  const mine = rows.filter((r) => r.arm === arm);
  console.log(`${arm.padEnd(5)} n=${mine.length} ok=${mine.filter((r) => r.ok).length} median ${s(median(pick(arm)))} [${s(Math.min(...pick(arm)))}-${s(Math.max(...pick(arm)))}] warm=${[...new Set(mine.map((r) => r.warm))].join(' ')}`);
}
console.log(`\nitem_view first call, warm minus cold: ${s(median(pick('warm')) - median(pick('cold')))} (negative means the boot warm-up paid off)`);
console.log(`declines detected by the response: ${rows.filter((r) => /risk_control|site_error/.test(String(r.last_load))).length}/${rows.length}`);
process.exit(0);