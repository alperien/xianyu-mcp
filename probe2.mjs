import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
let detail = null;
page.on('response', async (res) => {
  const m = res.url().match(/\/h5\/(mtop\.[^/]+)\/\d/);
  if (!m) return;
  try { const j = await res.json(); if (m[1] === 'mtop.taobao.idle.pc.detail' && j?.data) detail = j.data; } catch {}
});
await page.goto('https://www.goofish.com/item?id=1045171414271', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
if (detail) {
  console.log('sellerDO keys:', Object.keys(detail.sellerDO ?? {}).join(','));
  console.log('sellerDO.id-ish:', JSON.stringify({ sellerId: detail.sellerDO?.sellerId, userId: detail.sellerDO?.userId, id: detail.sellerDO?.id, userIdStr: detail.sellerDO?.userIdStr }));
  console.log('itemDO keys:', Object.keys(detail.itemDO ?? {}).join(','));
  console.log('itemDO seller-ish:', JSON.stringify({ sellerId: detail.itemDO?.sellerId, userId: detail.itemDO?.userId }));
}
const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /user|personal|seller/i.test(h)).slice(0, 10));
console.log('seller links:', JSON.stringify(links, null, 1));
await browser.close();
