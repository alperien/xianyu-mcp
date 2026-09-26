"""The in-page JavaScript, actually executed.

`extract.py` holds the parsers for goofish's two feed card shapes, the item detail
block and the recommendation rail. None of that is reachable from a unit test that
only mocks the page, so this harness feeds each script a hand-built DOM and asserts
what it reads. Node is optional: without it these skip and the Python-side tests
still cover the contract.

Run: .venv/bin/python -m pytest tests/test_extract_js.py
"""
from __future__ import annotations

import shutil
import subprocess

import pytest

from xianyu_mcp.extract import (
    CARD_SCRAPE_JS,
    DISMISS_LOGIN_JS,
    FEED_NORMALIZE_JS,
    ITEM_SCRAPE_JS,
    MTOP_CALL_JS,
    MTOP_READY_JS,
)

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

SCRIPTS = {
    "DISMISS_LOGIN_JS": DISMISS_LOGIN_JS,
    "MTOP_READY_JS": MTOP_READY_JS,
    "MTOP_CALL_JS": MTOP_CALL_JS,
    "FEED_NORMALIZE_JS": FEED_NORMALIZE_JS,
    "ITEM_SCRAPE_JS": ITEM_SCRAPE_JS,
    "CARD_SCRAPE_JS": CARD_SCRAPE_JS,
}

# The assertions, in the order they are reported.
CHECKS = r"""
const fail = (m) => { throw new Error(m); };
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`${what}: got ${JSON.stringify(got)}`);
};

// 1. every script is a function of the arity ops.py calls it with
const arity = {DISMISS_LOGIN_JS: 0, MTOP_READY_JS: 0, MTOP_CALL_JS: 1,
               FEED_NORMALIZE_JS: 1, ITEM_SCRAPE_JS: 1, CARD_SCRAPE_JS: 1};
for (const [name, n] of Object.entries(arity)) {
  if (typeof eval(name) !== 'function') fail(`${name} is not a function`);
  if (eval(name).length !== n) fail(`${name} arity ${eval(name).length} != ${n}`);
}

// 2. the mtop wrapper: no client, a success, and a rejection carrying goofish's code
// The readiness poll waits 150ms x 60 before giving up; make the timer instant so
// this is the same code path without nine seconds of it.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
global.window = {};
eq(MTOP_READY_JS(), 'pending', 'mtop not there yet');
if ((await MTOP_CALL_JS({calls: [['a', 'x', {}]]})).fatal !== 'mtop-not-ready') fail('no fatal');
globalThis.setTimeout = realSetTimeout;
global.window = {lib: {mtop: {request: async () => ({ret: ['SUCCESS::ok'], data: {n: 1}})}}};
eq(MTOP_READY_JS(), 'ready', 'mtop ready');
const ok = (await MTOP_CALL_JS({calls: [['a', 'x', {}]]})).a;
if (!ok.ok || ok.data.n !== 1) fail('success not read');
global.window = {lib: {mtop: {request: async () => { const e = new Error('js noise'); e.ret = 'RGV587_ERROR'; throw e; }}}};
eq((await MTOP_CALL_JS({calls: [['a', 'x', {}]]})).a.ret, 'RGV587_ERROR', 'rejection ret');
global.window = {lib: {mtop: {request: async () => { throw new Error('plain failure'); }}}};
eq((await MTOP_CALL_JS({calls: [['a', 'x', {}]]})).a.ok, false, 'rejection not ok');

// 3. both feed card shapes, and the 万 want-count
const shapeA = {detailParams: {itemId: '111', title: 'A', soldPrice: '12.5', picUrl: 'p1',
                               userNick: 'sellerA', isVideo: 'true'},
                attributeMap: {wantNum: 7, originalPrice: '20', city: '杭州'}};
const shapeB = {itemId: '222', titleSummary: {text: 'B'}, priceInfo: {price: '99'},
                images: [{url: 'p2'}], user: {userNick: 'sellerB'}, hotPoint: {text: '1.2万人想要'}};
const rows = FEED_NORMALIZE_JS({rows: [{cardData: shapeA}, shapeB]});
if (rows.length !== 2) fail(`dropped a card: ${rows.length}`);
eq([rows[0].item_id, rows[0].seller, rows[0].price, rows[0].city],
   ['111', 'sellerA', '12.5', '杭州'], 'detailParams shape');
eq([rows[1].item_id, rows[1].seller, rows[1].price, rows[1].want_count],
   ['222', 'sellerB', '99', '12000'], 'titleSummary shape');
eq(rows[0].url, 'https://www.goofish.com/item?id=111', 'item url');
eq(rows[0].is_video, true, 'is_video');
if (FEED_NORMALIZE_JS({rows: [{}]}).length !== 0) fail('a card with no id must be skipped');

// 4. the item page: read the detail block, never the rail below it
global.location = {search: '?id=1045171414271'};
global.document = {
  body: {innerText: '男士羊毛呢大衣\n¥1999\n2人想要\n110浏览\n来闲鱼4年 卖出27件宝贝 好评率100%\n'
                   + '专柜入手，穿过几次。\n为你推荐\n¥5\n推荐卡片标题'},
  querySelectorAll: () => [],
};
const detail = ITEM_SCRAPE_JS('1045171414271');
if (!detail.detail_rendered) fail('detail_rendered');
eq([detail.price, detail.want_count, detail.browse_count], ['1999', '2', '110'], 'money and counts');
eq([detail.seller_tenure_years, detail.seller_items_sold, detail.seller_positive_rate],
   ['4', '27', '100'], 'seller stats');
eq([detail.requested_item_id, detail.page_item_id], ['1045171414271', '1045171414271'], 'ids');
if (JSON.stringify(detail).includes('推荐卡片')) fail('a recommendation card leaked into the payload');
// the empty shell goofish serves a throttled IP: must not look rendered
global.document = {body: {innerText: '阿里巴巴集团 淘宝 天猫'}, querySelectorAll: () => []};
if (ITEM_SCRAPE_JS('1').detail_rendered !== false) fail('empty shell reported as rendered');
if (!ITEM_SCRAPE_JS('1').head_preview.includes('阿里巴巴')) fail('page text must still be quoted');

// 5. the rail: dedupe by id, respect the limit, label the rail
const card = (id, title, price) => ({
  href: 'https://www.goofish.com/item?id=' + id, innerText: `${title} ${price}`, textContent: title,
  querySelector: (s) => s.includes('price')
      ? {textContent: price, querySelector: () => ({textContent: ''})}
      : s.includes('seller') ? {querySelector: () => ({textContent: '成都'})} : null,
  querySelectorAll: () => [],
});
global.document = {body: {innerText: '为你推荐'},
  querySelectorAll: (sel) => sel.includes('/item?id=')
      ? [card('9', '相机', '¥1200'), card('9', 'dup', '¥1'), card('10', '包', '¥30')] : []};
const rail = CARD_SCRAPE_JS(10);
eq(rail.items.map((i) => i.item_id), ['9', '10'], 'rail dedupe');
eq(rail.items[0].city, '成都', 'card city');
eq(rail.rail, '为你推荐', 'rail label');
if (CARD_SCRAPE_JS(1).items.length !== 1) fail('limit not honoured');
"""


def test_in_page_javascript(tmp_path):
    harness = tmp_path / "harness.mjs"
    harness.write_text(
        "\n".join(f"const {name} = {src};" for name, src in SCRIPTS.items()) + CHECKS,
        encoding="utf-8",
    )
    done = subprocess.run(
        ["node", str(harness)], capture_output=True, text=True, timeout=60, check=False
    )
    assert done.returncode == 0, done.stderr.strip()
