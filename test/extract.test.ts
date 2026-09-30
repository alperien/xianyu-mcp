/**
 * The in-page JavaScript, actually executed against a synthetic document.
 *
 * Nothing here reaches the network. These are the parsers that read goofish's two feed
 * card shapes, the item detail block and the recommendation rail, and this is the only
 * place their behaviour is observable without a browser -- so it is where the rail
 * cut-off and the detailParams / titleSummary split are pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_NORMALIZE_JS, hasAllTerms, ITEM_SCRAPE_JS, MTOP_CALL_JS, MTOP_READY_JS, queryTerms, RAIL_MARKERS, SCRAPE_CARDS_JS } from '../src/extract.ts';
import { ITEM_FIELDS } from '../src/tools.ts';

const g = globalThis as any;
const realSetTimeout = g.setTimeout;
const setDoc = (text: string, sel: Record<string, any[]> = {}, location: string | { search?: string; pathname?: string } = '') => {
  g.document = { body: { innerText: text }, querySelectorAll: (s: string) => sel[s] ?? [], querySelector: () => null };
  g.location = { search: '', ...(typeof location === 'string' ? { search: location } : location) };
};
// These tests replace globals the page scripts read, so they put every one back: without this the
// file only passed in the order it happens to be written.
test.afterEach(() => { for (const k of ['document', 'location', 'window']) delete g[k]; g.setTimeout = realSetTimeout; });

test('the mtop wrapper reports "not ready" instead of throwing, and keeps goofish\'s own ret code', async () => {
  g.setTimeout = ((fn: any) => setImmediate(fn)) as any;   // the readiness poll's 150ms x 60 would otherwise cost 9s
  g.window = {};
  assert.equal(MTOP_READY_JS(), 'pending');
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).fatal, 'mtop-not-ready');
  g.window = { lib: { mtop: { request: async () => ({ ret: ['SUCCESS::ok'], data: { n: 1 } }) } } };
  assert.equal(MTOP_READY_JS(), 'ready');
  const ok = (await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a;
  assert.equal(ok.ok, true);
  assert.equal(ok.data.n, 1);
  // A rejected mtop call still carries the real code on `ret`; the JS message would throw it away.
  g.window = { lib: { mtop: { request: async () => { const e: any = new Error('js noise'); e.ret = 'RGV587_ERROR'; throw e; } } } };
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a.ret, 'RGV587_ERROR');
  g.window = { lib: { mtop: { request: async () => { throw new Error('plain failure'); } } } };
  assert.equal((await MTOP_CALL_JS({ calls: [['a', 'x', {}]] })).a.ok, false);
  // a batch goes out concurrently, so a 25-page feed is one slow request rather than 25 of them
  let live = 0, peak = 0;
  g.window = { lib: { mtop: { request: async () => { peak = Math.max(peak, ++live); await new Promise((r) => setImmediate(r)); live--; return { ret: ['SUCCESS'], data: {} }; } } } };
  assert.equal(Object.keys(await MTOP_CALL_JS({ calls: Array.from({ length: 5 }, (_, i) => [`p${i}`, 'x', {}]) })).length, 5);
  assert.equal(peak, 5);
});

test('the feed normalizer reads both card shapes, and only the first one has attributeMap', () => {
  const rows = FEED_NORMALIZE_JS({ rows: [
    { cardData: { detailParams: { itemId: '111', title: 'A', soldPrice: '12.5', picUrl: 'p1', userNick: 'sellerA', isVideo: 'true' }, attributeMap: { wantNum: 7, originalPrice: '20', city: '杭州' } } },
    { itemId: '222', titleSummary: { text: 'B' }, priceInfo: { price: '99' }, images: [{ url: 'p2' }], user: { userNick: 'sellerB' }, hotPoint: { text: '1.2万人想要' } },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].item_id, rows[0].seller, rows[0].price, rows[0].city, rows[0].want_count, rows[0].is_video],
    ['111', 'sellerA', '12.5', '杭州', '7', true]);
  assert.deepEqual([rows[1].item_id, rows[1].seller, rows[1].price, rows[1].want_count, rows[1].image_urls[0]],
    ['222', 'sellerB', '99', '12000', 'p2']);
  assert.equal(rows[0].url, 'https://www.goofish.com/item?id=111');
  // a card with no item id is skipped rather than reported as a blank listing
  assert.deepEqual(FEED_NORMALIZE_JS({ rows: [{}, { detailParams: {} }] }), []);
});

test('the item scraper reads the detail head and refuses the rail below it', () => {
  const head = '男士羊毛呢大衣\n¥1999\n2人想要\n110浏览\n汴梁资深化镁\n来闲鱼4年 卖出27件宝贝 好评率100%\n专柜入手，穿过几次。\n';
  setDoc(head + '为你推荐\n¥5\n推荐卡片标题 ¥9', {
    '[class*="main-title"]': [{ textContent: '男士羊毛呢大衣' }, { textContent: '推荐卡片标题' }],
    // the want-counter really is in the head, so it is isCounter that has to reject it
    '[class*="desc--"]': [{ textContent: '2人想要' }, { textContent: '专柜入手，穿过几次。' }],
    '[class*="nick"]': [{ textContent: '汴梁资深化镁' }],
  }, '?id=1045171414271');
  const d = ITEM_SCRAPE_JS({ item_id: '1045171414271', rails: RAIL_MARKERS });
  assert.equal(d.detail_rendered, true);
  assert.equal(d.title, '男士羊毛呢大衣');
  assert.equal(d.price, '1999');
  assert.deepEqual([d.want_count, d.browse_count], ['2', '110']);
  assert.deepEqual([d.seller_tenure_years, d.seller_items_sold, d.seller_positive_rate], ['4', '27', '100']);
  // a want-counter sitting in a class containing "desc" is not the seller's description
  assert.equal(d.description, '专柜入手，穿过几次。');
  assert.equal(d.seller, '汴梁资深化镁');
  assert.deepEqual([d.requested_item_id, d.page_item_id], ['1045171414271', '1045171414271']);
  assert.equal(JSON.stringify(d).includes('推荐卡片'), false, 'a recommendation card leaked into the payload');
  // ITEM_FIELDS is what item_view promises; every one of those names has to be a key the scraper
  // really returns, or fields_present / fields_missing would describe a payload nobody produces.
  for (const f of ITEM_FIELDS) assert.ok(f in d, `item_view promises ${f}, which this scraper never returns`);
  // A path-form item URL is a served listing, not a wrong one: trusting `location.search` alone made
  // item_view refuse a correct page and call it a different listing.
  setDoc(head, {}, { pathname: '/item/777' });
  assert.equal(ITEM_SCRAPE_JS({ item_id: '777', rails: RAIL_MARKERS }).page_item_id, '777');
});

test('listing photos are the seller\'s own uploads: rail cards, banners, avatars and undecoded images excluded', () => {
  // The old rule was "big, on a known CDN host, not inside a card anchor", and it returned goofish's
  // own promo banners -- measured on a live page whose listing was a nail gun, the four URLs it gave
  // were four `-tps-242-150.png` strips from `gw.alicdn.com`. A banner is big and on a known CDN too.
  // The discriminator is the path: everything a seller uploaded is on `/bao/uploaded/`, and a banner
  // or an avatar is not.
  const anchorImg = { src: 'https://img.alicdn.com/bao/uploaded/card.jpg', naturalWidth: 400 };
  setDoc('大衣 ¥1\n1人想要', {
    "a[href*='/item?id=']": [{ querySelectorAll: () => [anchorImg] }],
    img: [
      anchorImg,                                                                   // a rail card's picture
      { src: 'https://gw.alicdn.com/imgextra/i4/O1CN-2-tps-242-150.png', naturalWidth: 242 }, // a promo banner: big, on a CDN, not a photo
      { src: 'https://gtms03.alicdn.com/tps/i3/avatar-200-200.png', naturalWidth: 200 },         // the seller avatar
      { src: 'https://img.alicdn.com/bao/uploaded/i4/gallery.jpg', naturalWidth: 400 },
      { src: 'https://img.alicdn.com/bao/uploaded/i4/undecoded.jpg', naturalWidth: 0 },
      // the thumbnail strip and the full-size preview are one photo at two sizes; they collapse
      { src: 'https://img.alicdn.com/bao/uploaded/i4/gallery.jpg_110x10000Q90.jpg_.webp', naturalWidth: 110 },
    ],
  });
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.deepEqual(d.image_urls, ['https://img.alicdn.com/bao/uploaded/i4/gallery.jpg']);
  assert.equal(d.image_candidates, 2, 'the same photo at two sizes is two candidates, one URL');
  assert.equal(d.reco_anchors, 1);
});

test('the listing title comes from the document title, because the detail block does not print it', () => {
  // Measured over 6 live listings: the detail block prints the price, the counts, the description and
  // the seller, and the title is nowhere in `innerText` -- so every class-name search for it either
  // found a recommendation card further down the page or nothing, and the field came back empty.
  const g = globalThis as any;
  g.document = {
    body: { innerText: '搜索\n今生有缘xy\n台州\n¥\n366\n1人想要\n28浏览\n描述文字' },
    title: '腾亚40C瓦斯钉抢，功能正常使用_闲鱼',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.equal(d.title, '腾亚40C瓦斯钉抢，功能正常使用', 'the _闲鱼 suffix is goofish\'s, not the listing\'s');
});

test('the empty shell goofish serves a throttled IP must not look rendered, but its text is still quoted', () => {
  setDoc('阿里巴巴集团 淘宝 天猫');
  const d = ITEM_SCRAPE_JS({ item_id: '1', rails: RAIL_MARKERS });
  assert.equal(d.detail_rendered, false);
  assert.equal(d.page_item_id, '');
  assert.match(d.head_preview, /阿里巴巴/);
});

const card = (id: string, title: string, price: string, city = '成都') => ({
  href: `https://www.goofish.com/item?id=${id}`,
  innerText: `${title} ${price}`,
  getAttribute: () => null,
  querySelector: (s: string) => (s.includes('price')
    ? { querySelector: (t: string) => ({ textContent: t.includes('number') ? price : '' }) }
    : s.includes('seller') ? { querySelector: () => ({ textContent: city }) } : { textContent: title }),
  querySelectorAll: () => [],
});

test('the card scraper dedupes by item id, honours limit, and counts real query hits', () => {
  setDoc('联想 X220 电池', { 'a[href*="/item?id="]': [card('9', '联想 X220 电池', '300'), card('9', 'dup', '1'), card('10', '相机', '1200')] });
  const out = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.deepEqual(out.items.map((i: any) => i.item_id), ['9', '10']);
  assert.equal(out.query_hits, 1, 'only the title that really contains the query is a hit');
  assert.deepEqual(out.items.map((i: any) => i.matches_query), [true, false]);
  assert.equal(out.items[0].price, '¥300');
  assert.equal(out.items[0].city, '成都');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 1, rails: RAIL_MARKERS }).items.length, 1);
  // `limit` bounds what is kept, not what is counted: the caller needs the hit fraction over every
  // card on the page, so cards_scanned and query_hits both keep going past the limit.
  const capped = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 1, rails: RAIL_MARKERS });
  assert.deepEqual([capped.items.length, capped.query_hits, capped.cards_scanned], [1, 1, 2]);
  // no per-item `source`: a search hit is not a recommendation, and the envelope says where it came from
  assert.equal('source' in out.items[0], false);
  // token_hits is the looser, *additional* count: a title that holds every word of the query in any
  // order is a hit the strict substring guard will not accept, and it has to be visible either way.
  setDoc('', { 'a[href*="/item?id="]': [card('30', '联想 X220 键盘 拆机', '50'), card('31', '键盘 X220 联想 全新', '50'), card('32', '相机 1200', '1')] });
  const words = SCRAPE_CARDS_JS({ query: 'x220 键盘', terms: queryTerms('x220 键盘'), limit: 10, rails: RAIL_MARKERS });
  assert.deepEqual([words.query_hits, words.token_hits, words.cards_scanned], [1, 2, 3]);
  const one_word = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.equal(one_word.token_hits, one_word.query_hits, 'one word: the two counts are the same thing');
});

test('a query matches a listing by its terms in any order, which is the only way this works here', () => {
  // goofish titles are in whatever word order the seller typed, and Chinese has no spaces, so an
  // exact-substring test rejects nearly everything on this site. Measured: a search for `机械硬盘4t`
  // -- 70,146 listings by goofish's own counter -- returned nothing, because the titles say
  // `西数4T机械硬盘`. These are the real splits.
  assert.deepEqual(queryTerms('机械硬盘4t'), ['机械硬盘', '4t']);
  assert.deepEqual(queryTerms('i350网卡'), ['i350', '网卡']);
  assert.deepEqual(queryTerms('显示器24寸'), ['显示器', '24寸']);
  assert.deepEqual(queryTerms('笔记本内存ddr4'), ['笔记本内存', 'ddr4']);
  assert.deepEqual(queryTerms('sata固态512g'), ['sata', '固态', '512g']);
  assert.deepEqual(queryTerms('thinkpad x220'), ['thinkpad', 'x220']);
  assert.deepEqual(queryTerms('自行车'), ['自行车'], 'one term, no boundary to find');
  assert.deepEqual(queryTerms(''), []);

  // the looser rule admits the reversed-word-order title the strict one rejects...
  const reversed = '西数红盘4T企业级机械硬盘 寄';
  assert.equal(reversed.toLowerCase().includes('机械硬盘4t'), false, 'the phrase really is not there');
  assert.equal(hasAllTerms(reversed, queryTerms('机械硬盘4t')), true);
  // ...and still refuses a rail card, which is the whole point of the guard
  assert.equal(hasAllTerms('全新自行车 山地车 骑行装备', queryTerms('机械硬盘4t')), false);
  assert.equal(hasAllTerms('机械硬盘 台式机内存条', queryTerms('机械硬盘4t')), false, 'half the terms is not a match');
  // and a one-word query is unchanged by any of this
  assert.equal(hasAllTerms('任意自行车', queryTerms('自行车')), true);
});

test('the card scraper keeps the rail out under the looser rule, not just the strict one', () => {
  // 30 cards on a declined search page: 18 recommendations and 12 real listings, none of which
  // carries the phrase. The strict rule counts none of the 12; the term rule counts 12, which clears
  // the fifth-of-the-page floor. If this had gone the other way the rail would be sold as results.
  const rail = Array.from({ length: 18 }, (_, i) => card(String(100 + i), `推荐好物 ${i} 全新`, '9'));
  const real = Array.from({ length: 12 }, (_, i) => card(String(200 + i), `西数红盘4T企业级机械硬盘 ${i}`, '199'));
  setDoc('', { 'a[href*="/item?id="]': [...rail, ...real] });
  const out = SCRAPE_CARDS_JS({ query: '机械硬盘4t', terms: queryTerms('机械硬盘4t'), limit: 50, rails: RAIL_MARKERS });
  assert.equal(out.cards_scanned, 30);
  assert.equal(out.query_hits, 0, 'no title carries the phrase, only the terms');
  assert.equal(out.token_hits, 12, 'and the term rule finds all twelve real ones');
  // the scraper publishes every card it saw and flags them; the caller keeps the flagged ones, and
  // that is where the rail stops being results.
  assert.equal(out.items.filter((i: any) => i.matches_query).length, 12, 'so only the real ones are flagged as matches');
  assert.equal(out.items.filter((i: any) => i.matches_phrase).length, 0, 'and it is honest that the phrase was not the match');
});

test('a declined anonymous search is distinguishable from a real result set, and from a risk-control page', () => {
  setDoc('小闲鱼没有找到你想要的宝贝~ 猜你喜欢', { 'a[href*="/item?id="]': [card('900', '木瓜丝广西特产', '9')] });
  const out = SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS });
  assert.equal(out.rendered, true);
  assert.equal(out.query_hits, 0);
  assert.equal(out.rail, '猜你喜欢');
  assert.equal(out.says_no_results, true);
  // With no query (the recommendations path) nothing is claimed to match.
  assert.equal(SCRAPE_CARDS_JS({ query: '', terms: queryTerms(''), limit: 10, rails: RAIL_MARKERS }).items[0].matches_query, false);
  // goofish also answers this client with a risk-control page rather than the app: a 200 whose whole
  // body is 非法访问. It renders no cards and no rail, so without this flag the caller reports "no
  // results found" for a page the site never searched. Measured, so it is matched literally.
  setDoc('非法访问\n为了保障您的体验，请使用正常浏览器访问闲鱼~\n关闭\n反馈问题');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS }).blocked, true);
  setDoc('联想 X220 电池 ¥300');
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 10, rails: RAIL_MARKERS }).blocked, false);
  // One marker list, both scrapers. 猜你想看 is the one the card scraper was missing, and that gap is
  // what let a page headed with it and one query-matching card through as results; the list reaches
  // them as an argument (Playwright serialises the function and its one argument, nothing else), so
  // the only way to prove they read it is to hand them a list they do not otherwise have.
  assert.deepEqual(RAIL_MARKERS, ['为你推荐', '猜你喜欢', '猜你想看']);
  for (const marker of RAIL_MARKERS) {
    setDoc(`男士羊毛呢大衣\n1人想要\n${marker}\n专柜入手，穿过几次。`, {
      '[class*="main-title"]': [{ textContent: '男士羊毛呢大衣' }],
      '[class*="desc--"]': [{ textContent: '专柜入手，穿过几次。' }],
    });
    assert.equal(ITEM_SCRAPE_JS({ item_id: '1', rails: [marker] }).description, '', `${marker}: the item scraper did not cut the page at it`);
    setDoc(`小闲鱼 ${marker} 没有找到你想要的宝贝`, { 'a[href*="/item?id="]': [card('1', '联想X220', '300')] });
    assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 5, rails: [marker] }).rail, marker);
  }
  assert.equal(SCRAPE_CARDS_JS({ query: 'x220', terms: queryTerms('x220'), limit: 5, rails: ['推荐位'] }).rail, '', 'a marker that is not in the list is not a rail');
});

