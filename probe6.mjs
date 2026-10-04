import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--no-first-run','--disable-gpu'] });
const ctx = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
try { await page.goto('https://www.goofish.com/item?id=1045171414271', { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}
await page.waitForTimeout(10000);
const out = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !window?.lib?.mtop?.request; i++) await wait(150);
  if (!window?.lib?.mtop?.request) return { fatal: 'no mtop' };
  const one = async ([api, data]) => {
    try { const res = await window.lib.mtop.request({ api, data, type: 'POST', v: '1.0', dataType: 'json', needLogin: false, needLoginPC: false, sessionOption: 'AutoLoginOnly', ecode: 0 }); return { api, ret: Array.isArray(res?.ret) ? res.ret.join('|') : String(res?.ret ?? ''), keys: Object.keys(res?.data ?? {}).join(',') }; }
    catch (e) { return { api, ret: (Array.isArray(e?.ret) ? e.ret.join('|') : String(e?.ret ?? e?.message ?? e)) }; }
  };
  return Promise.all([
    one(['mtop.idle.web.user.page.head', { encryptedUserId: '', userId: '2214350705775' }]),
    one(['mtop.idle.web.user.page.head', {}]),
    one(['mtop.taobao.idle.filter.hitnum.pc.get', { pageNumber: 1, keyword: 'x220', rowsPerPage: 30, searchReqFromPage: 'pcSearch', extraFilterValue: '{}', userPositionJson: '{}', customDistance: '', customGps: '', gps: '' }]),
  ]);
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);
