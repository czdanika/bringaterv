# Tervezés: pontok lerakása a térképre, BRouter útvonal, táv / szint / idő kiírás.

import re

import pytest

from conftest import login, no_horizontal_overflow, real_errors, shot

# Budapest, Margit-sziget környéke → Óbuda (rövid, biztosan routolható szakasz)
POINTS = [(47.5265, 19.0480), (47.5420, 19.0440), (47.5520, 19.0560)]


WP_COUNT = "document.querySelectorAll('#waypointList > li:not(.waypoint-segment-label)').length"


def click_latlng(pg, lat, lng):
    xy = pg.evaluate(
        """([lat, lng]) => {
            const p = window.__map.latLngToContainerPoint([lat, lng]);
            const r = window.__map.getContainer().getBoundingClientRect();
            return [r.left + p.x, r.top + p.y];
        }""",
        [lat, lng],
    )
    pg.mouse.click(*xy)


def fit_points_into_visible_map(pg, points):
    """A pontokat a térkép ténylegesen látható részére illeszti – mobilon a térkép alját
    a tervező lap, tetejét a fejléc / gombok takarják, oda koppintva nem a térképet érjük."""
    for attempt in range(4):
        if _fit_once(pg, points):
            return
        pg.wait_for_timeout(800)   # épp fut az app saját ráközelítő animációja
    pytest.fail("a pontok nem illeszthetők a látható térképrészre")


def _fit_once(pg, points):
    pg.evaluate(
        """(pts) => {
            const map = window.__map, c = map.getContainer(), r = c.getBoundingClientRect();
            const onMap = (x, y) => { const e = document.elementFromPoint(x, y); return e && c.contains(e)
                && !e.closest('.leaflet-control, .leaflet-marker-icon, button'); };
            const cx = r.left + r.width / 2;
            let top = r.top, bottom = r.bottom - 1;
            while (top < bottom && !onMap(cx, top + 1)) top += 4;
            while (bottom > top && !onMap(cx, bottom)) bottom -= 4;
            map.fitBounds(pts, { animate: false, maxZoom: 16,
                paddingTopLeft: [40, top - r.top + 70],
                paddingBottomRight: [40, r.bottom - bottom + 40] });
        }""",
        [list(p) for p in points],
    )
    pg.wait_for_timeout(600)
    for lat, lng in points:
        ok = pg.evaluate(
            """([lat, lng]) => { const map = window.__map, c = map.getContainer(), r = c.getBoundingClientRect();
                const p = map.latLngToContainerPoint([lat, lng]);
                const e = document.elementFromPoint(r.left + p.x, r.top + p.y); return !!e && c.contains(e); }""",
            [lat, lng],
        )
        if not ok:
            return False
    return True


def number(text):
    m = re.search(r"[\d]+(?:[.,]\d+)?", text.replace(" ", ""))
    return float(m.group(0).replace(",", ".")) if m else None


@pytest.mark.parametrize("mode", ["asphalt", "hiking"])
def test_plan_route(page, mode):
    login(page)
    page.click('[data-tab="plan"]:visible')
    page.wait_for_timeout(800)

    mobile_mode = page.locator(f'#mModes [data-m="{mode}"]')
    if mobile_mode.is_visible():
        mobile_mode.click()
    else:
        for picker in ("#routeModePicker", "#mapRouteModePicker"):
            if page.locator(picker).is_visible():
                page.click(picker)
                page.click(f'[data-route-mode="{mode}"]:visible')
                break
        else:
            pytest.fail("nem látható tervezési mód választó")
    page.wait_for_timeout(300)

    for i, (lat, lng) in enumerate(POINTS, start=1):
        page.keyboard.press("Escape")   # nyitott popup / pontkártya ne nyelje el a kattintást
        # minden pont előtt újra: a 2. pont után az app ráközelít az útvonalra (auto-zoom)
        fit_points_into_visible_map(page, POINTS)
        click_latlng(page, lat, lng)
        page.wait_for_function(f"{WP_COUNT} === {i}", timeout=8000)
        page.wait_for_timeout(500)

    page.wait_for_function(
        "() => { const t = document.querySelector('#distanceValue')?.textContent || '';"
        " return /\\d/.test(t); }",
        timeout=30000,
    )
    page.wait_for_timeout(1500)
    dist = page.locator("#distanceValue").text_content()
    eta = page.locator("#estimatedTimeValue").text_content()
    asc = page.locator("#ascentValue").text_content()
    print(f"\n[{page.device}/{mode}] táv={dist!r} idő={eta!r} emelkedés={asc!r}")
    shot(page, f"plan-{mode}")

    km = number(dist)
    assert km and 2 < km < 15, f"furcsa táv: {dist}"
    assert re.search(r"\d", eta), f"nincs időbecslés: {eta}"
    assert no_horizontal_overflow(page)
    assert not real_errors(page), real_errors(page)
