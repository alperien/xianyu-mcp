import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
let headd = null;
page.on('response', async (res) => {
  const m = res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/);
  if (!m) return;
  try { const j = await res.json(); if (m[1] === 'mtop.idle.web.user.page.head') headd = j.data; } catch {}
});
try { await page.goto('https://www.goofish.com/personal?userId=2214350705775', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) { console.log('goto err', String(e).slice(0,80)); }
await page.waitForTimeout(12000);
try { console.log('BODY:', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n/g, ' | ')); } catch (e) { console.log('eval err'); }
if (headd) { console.log('baseInfo keys:', Object.keys(headd.baseInfo ?? {}).join(',')); console.log(JSON.stringify(headd.baseInfo).slice(0, 1200)); }
else console.log('no page.head reply');
await browser.close();
process.exit(0);
