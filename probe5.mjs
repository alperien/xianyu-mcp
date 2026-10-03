import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
const taps = [];
page.on('response', async (res) => { const m = res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/); if (!m) return; try { const j = await res.json(); taps.push({ api: m[1], ret: String(Array.isArray(j?.ret) ? j.ret.join('|') : j?.ret ?? ''), data: j?.data }); } catch {} });
const urls = ['https://www.goofish.com/mach-feeds?machId=163873&publishTimes=1', 'https://www.goofish.com/search?q=x220&cCatId=126854525'];
for (const u of urls) {
  taps.length = 0;
  try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}
  try { await page.waitForTimeout(14000); } catch {}
  console.log('=== ', u, '->', page.url());
  const seen = new Set();
  for (const t of taps) { if (seen.has(t.api)) continue; seen.add(t.api); console.log(' ', t.api, '|', t.ret.slice(0, 50), '| keys:', Object.keys(t.data ?? {}).slice(0, 8).join(',')); }
  console.log('  body:', (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).replace(/\n/g, '|').slice(0, 160));
}
await browser.close(); process.exit(0);
