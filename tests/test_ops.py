import pytest

from xianyu_mcp import (
    MAX_PAGES,
    NavigationError,
    XianyuError,
    build_search_url,
    clamp,
    dedupe,
    ensure_goofish_url,
    is_gated,
    item_id_from_url,
    rank_items,
)
from xianyu_mcp.errors import (
    DetailUnavailableError,
    GatedError,
    ParseError,
    SearchUnavailableError,
)


class TestClamp:
    def test_bounds(self):
        assert clamp(0, 1, 200) == 1
        assert clamp(999, 1, 200) == 200
        assert clamp(30, 1, 200) == 30

    def test_garbage_floors(self):
        assert clamp(None, 1, 200) == 1
        assert clamp("abc", 1, 200) == 1
        assert clamp("7", 1, 200) == 7

    def test_page_cap_is_sane(self):
        assert clamp(10_000, 1, MAX_PAGES) == MAX_PAGES


class TestItemIdFromUrl:
    def test_extracts(self):
        assert item_id_from_url("https://www.goofish.com/item?id=99&x=1") == "99"

    def test_missing(self):
        assert item_id_from_url("no id") == ""
        assert item_id_from_url("") == ""


class TestDedupe:
    def test_drops_repeats_by_item_id(self):
        items = [{"item_id": "1"}, {"item_id": "2"}, {"item_id": "1"}]
        assert [i["item_id"] for i in dedupe(items)] == ["1", "2"]

    def test_falls_back_to_url(self):
        items = [{"url": "https://www.goofish.com/item?id=5"}, {"item_id": "5"}]
        assert len(dedupe(items)) == 1

    def test_drops_items_with_no_identity(self):
        assert dedupe([{"title": "no id"}]) == []


class TestRankItems:
    def test_ranks_and_trims(self):
        out = rank_items([{"item_id": "a"}, {"item_id": "b"}, {"item_id": "c"}], 2)
        assert [i["rank"] for i in out] == [1, 2]
        assert len(out) == 2

    def test_empty(self):
        assert rank_items([], 10) == []


class TestIsGated:
    @pytest.mark.parametrize(
        "ret",
        [
            "RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!",
            "FAIL_SYS_SESSION_EXPIRED::Session过期",
            "TIMEOUT::接口超时",
            "FAIL_SYS_TOKEN_EXOIRED::x",
            "ILLEGAL_ACCESS::x",
        ],
    )
    def test_detects_gates(self, ret):
        assert is_gated(ret)

    @pytest.mark.parametrize("ret", ["SUCCESS::调用成功", "", "SUCCESS"])
    def test_success_is_not_gated(self, ret):
        assert not is_gated(ret)


class TestNavigationGuard:
    def test_allows_goofish(self):
        assert ensure_goofish_url("https://www.goofish.com/search?q=x")
        assert ensure_goofish_url("https://goofish.com/")

    @pytest.mark.parametrize(
        "url",
        [
            "https://evil.com/",
            "https://www.goofish.com.evil.com/",
            "https://taobao.com/",
            "https://passport.goofish.com/mini_login.htm",
            "file:///etc/passwd",
        ],
    )
    def test_blocks_everything_else(self, url):
        with pytest.raises(NavigationError):
            ensure_goofish_url(url)


class TestBuildSearchUrl:
    def test_encodes(self):
        assert build_search_url("iphone 15") == "https://www.goofish.com/search?q=iphone%2015"

    def test_rejects_empty(self):
        with pytest.raises(XianyuError):
            build_search_url("   ")


class FakePage:
    """Stands in for a goofish page. Payloads are returned in order; the last one sticks."""

    def __init__(self, payloads, url="https://www.goofish.com/"):
        self._payloads = list(payloads)
        self.url = url
        self.reloads = 0
        self.goto_calls = []
        self.args = []            # every argument the page was asked to evaluate with

    async def evaluate(self, js, arg=None):
        # Scroll/wait calls pass no argument; only scraper calls carry the item id.
        self.args.append(arg)
        if arg is None:
            return None
        return self._payloads.pop(0) if len(self._payloads) > 1 else self._payloads[0]

    async def reload(self, **kwargs):
        self.reloads += 1

    async def goto(self, url, **kwargs):
        self.goto_calls.append(url)
        self.url = url

    async def wait_for_timeout(self, ms):
        return None


class FakeSession:
    def __init__(self, page, raw=None):
        self.page_obj = page
        self.launches = 0
        self.opened = []
        self.specs = []
        self.raw = {} if raw is None else raw

    async def page(self):
        return self.page_obj

    async def open(self, url):
        from xianyu_mcp.session import ensure_goofish_url

        ensure_goofish_url(url)      # the real guard, so no test can route around it
        self.opened.append(url)
        self.page_obj.url = url
        return self.page_obj

    async def ensure_ready(self):
        # mirrors the real session: the mtop-only endpoints must NOT navigate
        self.ready_calls = getattr(self, "ready_calls", 0) + 1
        return self.page_obj

    async def call(self, spec):
        self.specs.append(spec)
        return self.raw


def install_fake_session(monkeypatch, payloads, url="https://www.goofish.com/", raw=None):
    from xianyu_mcp import ops

    session = FakeSession(FakePage(payloads, url), raw)
    monkeypatch.setattr(ops, "get_session", lambda: session)
    return session


RENDERED_ITEM = {
    "detail_rendered": True,
    "requested_item_id": "42",
    "title": "男士羊毛呢大衣",
    "price": "1999",
    "want_count": "2",
    "browse_count": "110",
    "description": "专柜入手，穿过几次。",
    "seller": "汴梁资深化镁",
    "seller_tenure_years": "4",
    "seller_items_sold": "27",
    "seller_positive_rate": "100",
    "image_urls": ["https://img.alicdn.com/bao/uploaded/i4/x.jpg"],
    "head_preview": "...",
    "reco_anchors": 30,
}
UNRENDERED_ITEM = {"detail_rendered": False, "head_preview": "阿里巴巴集团 淘宝 天猫"}


def feed_page(*cards, ok=True, ret="SUCCESS::调用成功"):
    """One mtop feed page's worth of raw cards."""
    return {"ok": ok, "ret": ret, "data": {"cardList": list(cards)}}


class TestBrowseFeed:
    """The one tool that always works without an account, so it is pinned hardest."""

    NORMALIZED = [
        {"item_id": "1", "title": "自行车", "price": "80", "city": "杭州",
         "seller": "a", "want_count": "3", "image_urls": ["u1"], "url": "https://www.goofish.com/item?id=1"},
        {"item_id": "2", "title": "相机", "price": "1200", "city": "上海",
         "seller": "b", "want_count": "7", "image_urls": [], "url": "https://www.goofish.com/item?id=2"},
    ]

    async def test_returns_normalized_items(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(
            monkeypatch, [list(self.NORMALIZED)],
            raw={"p1": feed_page({"cardData": {"itemId": "1"}}, {"cardData": {"itemId": "2"}})},
        )
        out = await ops.browse_feed()
        assert out["source"] == "homepage_feed"
        assert out["account_required"] is False
        assert out["raw_cards"] == 2
        assert out["unique_items"] == 2
        assert out["count"] == 2
        assert [i["item_id"] for i in out["items"]] == ["1", "2"]
        assert [i["rank"] for i in out["items"]] == [1, 2]

    async def test_one_mtop_call_carries_every_requested_page(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(
            monkeypatch, [list(self.NORMALIZED)],
            raw={"p1": feed_page({"itemId": "1"}), "p2": feed_page({"itemId": "2"}),
                 "p3": feed_page({"itemId": "3"})},
        )
        out = await ops.browse_feed(page_number=1, pages=3)
        assert len(session.specs) == 1
        assert [call[0] for call in session.specs[0]] == ["p1", "p2", "p3"]
        assert [call[2]["pageNumber"] for call in session.specs[0]] == [1, 2, 3]
        assert out["requested_pages"] == [1, 2, 3]
        assert out["page_reports"] == [
            {"page": 1, "ok": True, "cards": 1},
            {"page": 2, "ok": True, "cards": 1},
            {"page": 3, "ok": True, "cards": 1},
        ]

    async def test_unwraps_carddata_but_accepts_a_bare_card(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(
            monkeypatch, [list(self.NORMALIZED)],
            raw={"p1": feed_page({"cardData": {"itemId": "1", "title": "A"}}, {"itemId": "2", "title": "B"})},
        )
        await ops.browse_feed()
        rows = session.page_obj.args[-1]["rows"]
        assert rows == [{"itemId": "1", "title": "A"}, {"itemId": "2", "title": "B"}]

    async def test_a_gate_on_every_page_is_a_gate_not_a_shape_change(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(
            monkeypatch, [[]],
            raw={"p1": feed_page(ok=False, ret="RGV587_ERROR::SM::哎哟喂,被挤爆啦!")},
        )
        with pytest.raises(GatedError) as exc:
            await ops.browse_feed()
        assert "RGV587" in str(exc.value)

    async def test_one_refused_page_does_not_throw_away_the_others(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(
            monkeypatch, [list(self.NORMALIZED)],
            raw={"p1": feed_page({"itemId": "1"}),
                 "p2": feed_page(ok=False, ret="RGV587_ERROR::SM::挤爆啦")},
        )
        out = await ops.browse_feed(pages=2)
        assert out["unique_items"] == 2
        assert out["page_reports"][1] == {"page": 2, "ok": False, "ret": "RGV587_ERROR::SM::挤爆啦"}

    async def test_no_cards_at_all_is_a_parse_error(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [[]], raw={"p1": feed_page()})
        with pytest.raises(ParseError) as exc:
            await ops.browse_feed()
        assert "card shape" in str(exc.value)

    async def test_cards_without_ids_is_a_parse_error_naming_the_shape(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [[]], raw={"p1": feed_page({"brandNew": "field"})})
        with pytest.raises(ParseError) as exc:
            await ops.browse_feed()
        assert "brandNew" in str(exc.value)

    async def test_limit_trims_the_list_but_not_the_unique_count(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [list(self.NORMALIZED)],
                             raw={"p1": feed_page({"itemId": "1"}, {"itemId": "2"})})
        out = await ops.browse_feed(limit=1)
        assert out["count"] == 1
        assert out["unique_items"] == 2
        assert out["items"][0]["rank"] == 1

    @pytest.mark.parametrize("bad", ["abc", None, "", 0, -5, float("nan")])
    async def test_garbage_page_numbers_do_not_crash(self, monkeypatch, bad):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [list(self.NORMALIZED)],
                                       raw={"p1": feed_page({"itemId": "1"}),
                                            "p2": feed_page({"itemId": "2"})})
        out = await ops.browse_feed(page_number=bad, pages=2)
        assert out["requested_pages"] == [1, 2]          # anything unusable floors to page 1
        assert [c[2]["pageNumber"] for c in session.specs[0]] == [1, 2]

    async def test_absurd_page_numbers_are_bounded(self, monkeypatch):
        from xianyu_mcp import ops

        top = ops.MAX_PAGE_NUMBER
        session = install_fake_session(monkeypatch, [list(self.NORMALIZED)],
                                       raw={f"p{n}": feed_page({"itemId": str(n)})
                                            for n in (top, top + 1)})
        out = await ops.browse_feed(page_number=10**9, pages=2)
        assert out["requested_pages"] == [ops.MAX_PAGE_NUMBER, ops.MAX_PAGE_NUMBER + 1]
        assert [c[2]["pageNumber"] for c in session.specs[0]] == out["requested_pages"]

    async def test_browsing_never_needs_a_credential(self, monkeypatch):
        """The feed call carries no cookie, token or account field of any kind."""
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [list(self.NORMALIZED)],
                                       raw={"p1": feed_page({"itemId": "1"})})
        await ops.browse_feed()
        (_label, api, data) = session.specs[0][0]
        assert api == ops.FEED_API
        assert data == {"pageNumber": 1}


class TestItemView:
    async def test_reads_a_rendered_listing(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [RENDERED_ITEM])
        out = await ops.item_view("1045171414271")
        assert out["item_id"] == "1045171414271"
        assert out["price"] == "1999"
        assert out["want_count"] == "2"
        assert out["browse_count"] == "110"
        assert out["seller"] == "汴梁资深化镁"
        assert out["image_urls"] == ["https://img.alicdn.com/bao/uploaded/i4/x.jpg"]
        assert out["account_required"] is False
        assert "price" in out["fields_present"]
        assert "title" not in out["fields_missing"]

    async def test_reports_missing_fields_rather_than_filling_them(self, monkeypatch):
        from xianyu_mcp import ops

        thin = dict(RENDERED_ITEM, description="", seller="", image_urls=[])
        install_fake_session(monkeypatch, [thin])
        out = await ops.item_view("42")
        assert out["description"] == "" and out["seller"] == "" and out["image_urls"] == []
        assert set(out["fields_missing"]) == {"description", "seller", "image_urls"}
        assert "description" not in out["fields_present"]

    async def test_every_promised_field_is_emitted(self, monkeypatch):
        """The seller_line / image_urls bug class: extracted, then silently dropped."""
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [RENDERED_ITEM])
        out = await ops.item_view("42")
        for field in ops.ITEM_FIELDS:
            assert field in out, field
        assert set(out["fields_present"]) | set(out["fields_missing"]) == set(ops.ITEM_FIELDS)

    async def test_accepts_an_item_url(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [RENDERED_ITEM])
        out = await ops.item_view("https://www.goofish.com/item?id=777&foo=1")
        assert out["item_id"] == "777"
        assert session.opened == ["https://www.goofish.com/item?id=777"]

    @pytest.mark.parametrize(
        "given",
        [
            "https://www.goofish.com/item?id=777#detail",   # a fragment is a normal URL
            "https://www.goofish.com/item?id=777&spm=a1z10.3",
            "https://www.goofish.com/search?q=x&id=777",
            "  777  ",
        ],
    )
    async def test_item_id_extraction_survives_real_urls(self, monkeypatch, given):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [RENDERED_ITEM])
        assert (await ops.item_view(given))["item_id"] == "777"

    async def test_retries_then_gives_up_with_evidence(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [UNRENDERED_ITEM])

        async def fake_probe(api, data):
            return "TIMEOUT::接口超时"

        monkeypatch.setattr(ops, "_probe_ret", fake_probe)
        with pytest.raises(DetailUnavailableError) as exc:
            await ops.item_view("42")
        msg = str(exc.value)
        assert "TIMEOUT" in msg
        assert "阿里巴巴集团" in msg          # shows the page text it actually saw
        # retries use cache-busted reloads to escape a cached empty shell
        cache_busted = [u for u in session.page_obj.goto_calls if "_r" in u]
        assert cache_busted, "expected at least one cache-busted retry"
        assert len(cache_busted) <= ops.RENDER_ATTEMPTS - 1

    async def test_retries_until_it_renders(self, monkeypatch):
        from xianyu_mcp import ops

        # the readiness poll consumes extra scrapes, so assert the outcome, not the count
        install_fake_session(monkeypatch, [UNRENDERED_ITEM, UNRENDERED_ITEM, RENDERED_ITEM])
        out = await ops.item_view("42")
        assert out["price"] == "1999"
        assert out["attempts"] >= 1

    async def test_will_not_report_another_listings_fields(self, monkeypatch):
        """If goofish serves a different item than the one asked for, that is an error."""
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [dict(RENDERED_ITEM, page_item_id="999")])
        with pytest.raises(ParseError) as exc:
            await ops.item_view("42")
        assert "999" in str(exc.value)

    async def test_a_matching_page_item_id_is_accepted(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [dict(RENDERED_ITEM, page_item_id="42")])
        assert (await ops.item_view("42"))["item_id"] == "42"

    @pytest.mark.parametrize("bad", ["not-an-id", "", "42; DROP TABLE", "١٢٣", "0x2a"])
    async def test_rejects_garbage_id_before_touching_the_browser(self, monkeypatch, bad):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [RENDERED_ITEM])
        with pytest.raises(XianyuError):
            await ops.item_view(bad)
        assert session.opened == []

    async def test_a_pasted_url_contributes_its_id_and_nothing_else(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [RENDERED_ITEM])
        out = await ops.item_view("https://evil.com/steal?id=777")
        assert out["item_id"] == "777"
        assert out["url"] == "https://www.goofish.com/item?id=777"
        assert session.opened == ["https://www.goofish.com/item?id=777"]


class TestRecommendations:
    async def test_scrapes_the_dom_rail(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [{
            "items": [{"item_id": "1", "title": "a", "url": "u"}],
            "rail": "为你推荐",
            "saysNoResults": False,
            "loginWallUp": False,
        }])
        out = await ops.recommendations(limit=10)
        assert out["source"] == "dom_recommendation"
        assert out["count"] == 1
        assert out["rail"] == "为你推荐"
        assert out["attempts"] == 1
        assert out["account_required"] is False
        assert out["items"][0]["rank"] == 1

    async def test_returns_the_scraped_cards_untouched(self, monkeypatch):
        """No card field is dropped on the way out (the seller_line / image_urls bug)."""
        from xianyu_mcp import ops

        card = {"item_id": "1", "title": "a", "price": "¥12", "condition": "9成新",
                "brand": "无", "city": "成都", "url": "u", "source": "dom_recommendation"}
        install_fake_session(monkeypatch, [{"items": [card], "rail": "猜你喜欢"}])
        out = await ops.recommendations(limit=10)
        assert out["items"][0] == {**card, "rank": 1}

    async def test_reports_when_the_page_says_it_found_nothing(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [{
            "items": [{"item_id": "1", "title": "a", "url": "u"}],
            "saysNoResults": True,
            "loginWallUp": True,
        }])
        out = await ops.recommendations(limit=10)
        assert out["says_no_results_for_query"] is True
        assert out["login_wall_still_up"] is True

    async def test_retries_an_empty_shell_before_falling_back(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [
            {"items": []}, {"items": []}, {"items": [{"item_id": "1", "title": "a", "url": "u"}]},
        ])
        out = await ops.recommendations(limit=10)
        assert out["attempts"] == 3
        assert out["count"] == 1

    async def test_dedupes_repeated_cards(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [{"items": [
            {"item_id": "1", "title": "a", "url": "u"},
            {"item_id": "1", "title": "a again", "url": "u"},
        ]}])
        assert (await ops.recommendations(limit=10))["count"] == 1

    async def test_falls_back_to_the_feed_and_says_why(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [{"items": [], "rail": ""}])

        async def fake_feed(**kwargs):
            return {"source": "homepage_feed", "items": [{"item_id": "9"}], "count": 1}

        monkeypatch.setattr(ops, "browse_feed", fake_feed)
        out = await ops.recommendations(limit=5)
        assert out["source"] == "homepage_feed"
        assert "empty shell" in out["fallback_reason"]
        assert out["requested_url"] == "https://www.goofish.com/"

    async def test_refuses_an_off_site_url(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{"items": []}])
        with pytest.raises(NavigationError):
            await ops.recommendations(url="https://evil.com/steal?_r=1")
        assert session.opened == []


SEARCH_HIT = {
    "rendered": True, "query_hits": 2, "guess_rail": False, "says_no_results": False,
    "login_wall_up": False, "text_preview": "联想X220 电池还能用...",
    "items": [
        {"item_id": "1", "title": "联想X220 电池还能用", "price": "300", "condition": "",
         "brand": "", "city": "北京", "url": "https://www.goofish.com/item?id=1",
         "matches_query": True},
        {"item_id": "2", "title": "X220主板 ThinkPad i7", "price": "180", "condition": "",
         "brand": "", "city": "上海", "url": "https://www.goofish.com/item?id=2",
         "matches_query": True},
    ],
}
# What goofish serves when it declines: unrelated cards under the 猜你喜欢 rail.
SEARCH_RAIL = {
    "rendered": True, "query_hits": 0, "guess_rail": True, "says_no_results": True,
    "login_wall_up": False, "text_preview": "小闲鱼没有找到你想要的宝贝~ 猜你喜欢",
    "items": [
        {"item_id": "900", "title": "木瓜丝广西特产", "price": "9", "condition": "",
         "brand": "", "city": "南宁", "url": "https://www.goofish.com/item?id=900",
         "matches_query": False},
    ],
}
SEARCH_EMPTY = {"rendered": False, "query_hits": 0, "guess_rail": False,
                "says_no_results": False, "login_wall_up": False,
                "text_preview": "阿里巴巴集团 淘宝 天猫", "items": []}


class TestSearchWorks:
    async def test_returns_real_matches(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [SEARCH_HIT])
        out = await ops.search_items("x220")
        assert out["count"] == 2
        assert out["query_hits"] == 2
        assert out["account_required"] is False
        assert out["source"] == "search_page_dom"
        assert all(i["matches_query"] for i in out["items"])

    async def test_never_returns_the_recommendation_rail(self, monkeypatch):
        """The rail is the one thing that would make this tool lie."""
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [SEARCH_RAIL] * 8)
        with pytest.raises(SearchUnavailableError) as exc:
            await ops.search_items("x220", attempts=2)
        msg = str(exc.value)
        assert "木瓜丝" not in msg
        assert "declined" in msg
        # it retried before giving up
        assert len(session.opened) == 2

    async def test_retries_until_goofish_serves_results(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [SEARCH_RAIL, SEARCH_EMPTY, SEARCH_HIT, SEARCH_HIT])
        out = await ops.search_items("x220", attempts=4)
        # A rail decline is recorded, then a later load serves real matches.
        assert out["count"] == 2
        assert out["attempt_log"][0]["guess_rail"] is True
        assert out["attempt_log"][0]["query_hits"] == 0
        assert out["attempts"] >= 2

    async def test_attempt_log_records_every_try(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [SEARCH_RAIL] * 4)
        with pytest.raises(SearchUnavailableError):
            await ops.search_items("x220", attempts=3)

    async def test_respects_limit(self, monkeypatch):
        from xianyu_mcp import ops

        install_fake_session(monkeypatch, [SEARCH_HIT])
        out = await ops.search_items("x220", limit=1)
        assert out["count"] == 1

    async def test_rejects_empty_query(self):
        from xianyu_mcp import ops

        with pytest.raises(XianyuError):
            await ops.search_items("   ")

    async def test_attempts_are_clamped(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [SEARCH_RAIL] * 30)
        with pytest.raises(SearchUnavailableError):
            await ops.search_items("x220", attempts=9999)
        assert len(session.opened) == ops.MAX_SEARCH_ATTEMPTS


class TestNormalizeContract:
    """The feed normalizer must emit the fields the tools promise."""

    def test_js_extracts_every_advertised_field(self):
        import re
        from pathlib import Path

        src = Path(__file__).resolve().parents[1] / "src" / "xianyu_mcp" / "extract.py"
        text = src.read_text(encoding="utf-8")
        block = text.split("FEED_NORMALIZE_JS = r\"\"\"")[1].split('"""')[0]
        for field in ("item_id", "title", "price", "city", "want_count",
                      "seller", "url", "image_urls", "is_video", "category_id"):
            assert re.search(rf"\b{field}\b", block), f"feed normalizer missing {field}"

    def test_item_scraper_output_is_all_surfaced(self):
        """Every field ITEM_SCRAPE_JS returns has to be reported, used, or explained.

        This is the guard on the bug this project already shipped once: a field was
        extracted from the page and then quietly never emitted.
        """
        from xianyu_mcp import ops
        from xianyu_mcp.extract import ITEM_SCRAPE_JS

        scraped = set(_object_keys(ITEM_SCRAPE_JS, "  return {"))
        control = {"detail_rendered", "requested_item_id", "page_item_id"}
        evidence = {"head_preview"}          # quoted in the DetailUnavailableError message
        reported = {"reco_anchors", "image_candidates"}  # reported next to the fields
        assert scraped == set(ops.ITEM_FIELDS) | control | evidence | reported

    def test_card_scraper_output_is_all_surfaced(self):
        from xianyu_mcp.extract import CARD_SCRAPE_JS

        card = set(_object_keys(CARD_SCRAPE_JS, "    items.push({", indent=6))
        assert card == {"item_id", "title", "price", "condition", "brand", "city",
                        "url", "source"}
        envelope = set(_object_keys(CARD_SCRAPE_JS, "  return {"))
        assert envelope == {"items", "rail", "saysNoResults", "loginWallUp"}

    def test_feed_normalizer_output_is_a_subset_of_what_browse_feed_returns(self):
        from xianyu_mcp.extract import FEED_NORMALIZE_JS

        emitted = set(_object_keys(FEED_NORMALIZE_JS, "    out.push({", indent=6))
        assert emitted == {
            "item_id", "title", "price", "original_price", "city", "want_count",
            "image_count", "seller", "is_video", "category_id", "image_urls", "url",
        }


def _object_keys(script: str, anchor: str, indent: int = 4) -> list[str]:
    """Keys of the object literal that starts at `anchor`, located by brace matching."""
    import re

    start = script.index(anchor)
    depth, i = 0, start + len(anchor) - 1          # the anchor's own opening brace
    while i < len(script):
        if script[i] == "{":
            depth += 1
        elif script[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    # `key:` and the shorthand `key,` both count as declared fields
    return re.findall(rf"^ {{{indent}}}([A-Za-z_][A-Za-z0-9_]*)\s*[,:]", script[start:i], re.M)


class TestKeywordEndpoints:
    """Endpoints recovered from goofish's JS bundles; all answer without an account."""

    async def test_search_count_reads_hitnum(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{}])
        calls = {}

        async def fake_call(spec):
            calls["spec"] = spec
            return {"hitnum": {"ok": True, "ret": "SUCCESS::调用成功",
                               "data": {"hitnum": 28791}}}

        monkeypatch.setattr(session, "call", fake_call)
        out = await ops.search_count("x220")
        assert out["match_count"] == 28791
        assert out["has_matches"] is True
        assert out["account_required"] is False
        api, data = calls["spec"][0][1], calls["spec"][0][2]
        assert api == ops.HITNUM_API
        assert data["keyword"] == "x220"
        assert data["searchReqFromPage"] == "pcSearch"

    async def test_search_count_zero_is_not_an_error(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{}])

        async def fake_call(spec):
            return {"hitnum": {"ok": True, "ret": "SUCCESS::调用成功", "data": {"hitnum": 0}}}

        monkeypatch.setattr(session, "call", fake_call)
        out = await ops.search_count("asdkjhqwezzz")
        assert out["match_count"] == 0
        assert out["has_matches"] is False

    async def test_search_count_surfaces_a_refusal(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{}])

        async def fake_call(spec):
            return {"hitnum": {"ok": False, "ret": "RGV587_ERROR::x", "data": None}}

        monkeypatch.setattr(session, "call", fake_call)
        with pytest.raises(GatedError):
            await ops.search_count("x220")

    async def test_search_count_rejects_empty(self):
        from xianyu_mcp import ops

        with pytest.raises(XianyuError):
            await ops.search_count(" ")

    async def test_search_suggest_normalises_items(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{}])

        async def fake_call(spec):
            assert spec[0][1] == ops.SUGGEST_API
            return {"sug": {"ok": True, "ret": "SUCCESS::调用成功", "data": {
                "totalCount": 1234,
                "items": [{"suggest": "x220笔记本", "bucketNum": 30},
                          {"suggest": "x220 主板", "bucketNum": 30},
                          {"suggest": "x220笔记本"},          # duplicate
                          {"suggest": ""},                    # empty
                          "not-a-dict"],
            }}}

        monkeypatch.setattr(session, "call", fake_call)
        out = await ops.search_suggest("x220")
        assert out["total_count"] == 1234
        assert [s["text"] for s in out["suggestions"]] == ["x220笔记本", "x220 主板"]
        assert out["account_required"] is False

    async def test_related_items_omits_item_id_when_generic(self, monkeypatch):
        from xianyu_mcp import ops

        # the only evaluate the op makes is the card normalizer, so the single
        # payload the fake serves is what the normalizer "returns"
        session = install_fake_session(monkeypatch, [[
            {"item_id": "111", "title": "a", "price": "1"},
            {"item_id": "222", "title": "b", "price": "2"},
        ]])
        captured = {}

        async def fake_call(spec):
            captured["data"] = spec[0][2]
            return {"rec": {"ok": True, "ret": "SUCCESS::调用成功", "data": {
                "hasMore": True, "cardList": [
                    {"cardData": {"detailParams": {"itemId": "111", "title": "a", "soldPrice": "1"}}},
                    {"cardData": {"itemId": "222", "title": "b", "soldPrice": "2"}},
                ]}}}

        monkeypatch.setattr(session, "call", fake_call)
        out = await ops.related_items()
        # no item_id -> goofish's own seed item, exactly as its bundle does it
        assert captured["data"]["itemId"] == ops.RECOMMEND_SEED_ITEM_ID
        assert captured["data"]["reqFrom"] == "xianyuweb"
        # pageSize is hardcoded by the endpoint; `limit` is applied client-side
        assert captured["data"]["pageSize"] == ops.RECOMMEND_PAGE_SIZE
        assert captured["data"]["categoryId"] == ""
        assert out["unique_items"] == 2
        assert out["has_more"] is True
        assert out["items"][0]["rank"] == 1

    async def test_related_items_passes_item_id_when_given(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [
            [{"item_id": "9", "title": "t", "price": "5"}]])
        captured = {}

        async def fake_call(spec):
            captured["data"] = spec[0][2]
            return {"rec": {"ok": True, "ret": "SUCCESS::调用成功", "data": {"cardList": [
                {"cardData": {"detailParams": {"itemId": "9", "title": "t", "soldPrice": "5"}}}]}}}

        monkeypatch.setattr(session, "call", fake_call)
        await ops.related_items("https://www.goofish.com/item?id=777&x=1")
        assert captured["data"]["itemId"] == "777"

    async def test_related_items_raises_on_empty_cards(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{}])

        async def fake_call(spec):
            return {"rec": {"ok": True, "ret": "SUCCESS::调用成功", "data": {"cardList": []}}}

        monkeypatch.setattr(session, "call", fake_call)
        with pytest.raises(ParseError):
            await ops.related_items()


class TestNoRedundantNavigation:
    """The mtop-only endpoints must not reload the page.

    Navigating to the homepage on every call cost 10-25s per call on a slow link while
    changing nothing -- the mtop client is already live in the parked page. Only the
    DOM-scraping tools (search_items, item_view, recommendations) may navigate.
    """

    async def test_keyword_endpoints_do_not_navigate(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [[]], raw={
            "hitnum": {"ok": True, "ret": "SUCCESS", "data": {"hitnum": 5}},
            "sug": {"ok": True, "ret": "SUCCESS", "data": {"items": [], "totalCount": 0}},
            "rec": {"ok": True, "ret": "SUCCESS", "data": {"cardList": []}},
        })
        await ops.search_count("x220")
        await ops.search_suggest("x220")
        assert session.opened == [], f"mtop-only calls navigated: {session.opened}"
        assert session.ready_calls == 2

    async def test_dom_tools_still_navigate(self, monkeypatch):
        from xianyu_mcp import ops

        session = install_fake_session(monkeypatch, [{
            "rendered": True, "query_hits": 1, "guess_rail": False,
            "says_no_results": False, "login_wall_up": False, "text_preview": "",
            "items": [{"item_id": "1", "title": "x220 laptop", "price": "1",
                       "condition": "", "brand": "", "city": "",
                       "url": "https://www.goofish.com/item?id=1", "matches_query": True}],
        }])
        await ops.search_items("x220", attempts=1)
        assert session.opened == ["https://www.goofish.com/search?q=x220"]


class TestItemViewDoesNotOverSleep:
    """item_view must wait for the listing block, not for a fixed sleep."""

    async def test_polls_until_the_detail_block_appears(self, monkeypatch):
        from xianyu_mcp import ops

        # first scrape unrendered, then rendered: the poll loop should pick it up
        # without needing the retry/reload path at all
        install_fake_session(monkeypatch, [UNRENDERED_ITEM, RENDERED_ITEM])
        out = await ops.item_view("42")
        assert out["price"] == "1999"
        assert "price" in out["fields_present"]


class TestWallClockBudget:
    """Best-effort tools must give up on a clock, not hold the caller for minutes."""

    def test_budgets_default_and_are_overridable(self, monkeypatch):
        import os

        from xianyu_mcp import ops

        assert ops.ITEM_VIEW_BUDGET_S >= 5
        assert ops.SEARCH_BUDGET_S >= 5
        monkeypatch.setenv("XIANYU_ITEM_VIEW_BUDGET_S", "12")
        assert ops._budget("ITEM_VIEW", 45) == 12
        monkeypatch.setenv("XIANYU_ITEM_VIEW_BUDGET_S", "nonsense")
        assert ops._budget("ITEM_VIEW", 45) == 45      # falls back, never raises
        monkeypatch.setenv("XIANYU_ITEM_VIEW_BUDGET_S", "1")
        assert ops._budget("ITEM_VIEW", 45) == 5        # floored, never absurd
        os.environ.pop("XIANYU_ITEM_VIEW_BUDGET_S", None)

    async def test_item_view_stops_at_the_budget(self, monkeypatch):
        from xianyu_mcp import ops

        monkeypatch.setattr(ops, "ITEM_VIEW_BUDGET_S", 0)   # already spent
        install_fake_session(monkeypatch, [UNRENDERED_ITEM] * 10)

        async def fake_probe(api, data):
            return "TIMEOUT::x"

        monkeypatch.setattr(ops, "_probe_ret", fake_probe)
        with pytest.raises(DetailUnavailableError) as exc:
            await ops.item_view("42")
        # it must not have burned through every attempt
        assert "attempt(s)" in str(exc.value)

    async def test_search_stops_at_the_budget(self, monkeypatch):
        from xianyu_mcp import ops

        monkeypatch.setattr(ops, "SEARCH_BUDGET_S", 0)
        session = install_fake_session(monkeypatch, [SEARCH_RAIL] * 20)
        with pytest.raises(SearchUnavailableError) as exc:
            await ops.search_items("x220", attempts=10)
        assert "time budget reached" in str(exc.value)
        assert len(session.opened) == 1        # stopped before reloading again
