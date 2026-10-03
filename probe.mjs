import { chromium } from 'playwright';
const taps = [];
const browser = await chromium.launch({ headless: process.env.H === '1', args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
page.on('response', async (res) => {
  const m = res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/);
  if (!m) return;
  try { const j = await res.json(); const raw = j?.ret; const ret = Array.isArray(raw) ? raw.join(' | ') : String(raw ?? ''); taps.push({ api: m[1], ret, url: res.url(), data: j?.data }); } catch {}
});
const url = process.argv[2];
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await page.waitForTimeout(12000); } catch {}
console.log("URL:", page.url());// eslint-disable-line page.url());
console.log('TITLE:', await page.title());
const seen = new Set();
for (const t of taps) { if (seen.has(t.api)) continue; seen.add(t.api); console.log(t.api, '|', t.ret.slice(0,60), '| keys:', Object.keys(t.data ?? {}).slice(0,10).join(',')); }
await browser.close();
