import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
try { await page.goto('https://www.goofish.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}
await page.waitForTimeout(12000);
const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /cCatId|catId|channel|home\?/i.test(h)).slice(0, 20));
console.log(JSON.stringify([...new Set(links)], null, 1));
await browser.close(); process.exit(0);
