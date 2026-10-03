import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
let headd = null, nav = null;
page.on('response', async (res) => {
  const m = res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/);
  if (!m) return;
  try { const j = await res.json(); if (m[1] === 'mtop.idle.web.user.page.head') headd = j.data; if (m[1] === 'mtop.idle.web.user.page.nav') nav = j; } catch {}
});
await page.goto('https://www.goofish.com/personal?userId=2214350705775', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
console.log('user ids found in DOM:', await page.evaluate(() => document.body.innerText.slice(0, 400)));
if (headd) console.log('page.head baseInfo:', JSON.stringify(headd.baseInfo, null, 1).slice(0, 1500));
await browser.close();
