# OnelapFit (Magene) integráció + ismétlődés-védelem. Csak olvas: a listázás GET,
# importot / feltöltést nem indít (a write-guard úgyis blokkolná).

import pytest

from conftest import login, no_horizontal_overflow, real_errors, shot
from test_planning import POINTS, WP_COUNT, click_latlng, fit_points_into_visible_map


def test_dedup_toggle_reflects_server(page):
    login(page)
    server = page.evaluate("""async () => {
        const r = await fetch('/api/user/settings', {headers: {Authorization: 'Bearer ' + localStorage.getItem('bringaterv_jwt')}});
        return (await r.json()).importDedup;
    }""")
    page.wait_for_function("document.querySelector('#settingsImportDedup') !== null")
    page.wait_for_timeout(1500)
    assert page.locator("#settingsImportDedup").is_checked() == (server is not False)
    assert not real_errors(page), real_errors(page)


def test_onelap_import_modal(page):
    login(page)
    page.click('[data-tab="library"]:visible')
    page.click("#libraryImportBtn")
    item = page.locator("#libraryImportOnelapItem")
    assert item.is_visible()
    # a státusz-lekérés után: kapcsolat nélkül letiltva, „nincs kapcsolat” felirattal
    page.wait_for_function("document.querySelector('#libraryImportOnelapItem').title.includes('Onelap')")
    page.wait_for_timeout(1500)
    if item.is_disabled():
        assert "nincs kapcsolat" in item.text_content()
        pytest.skip("a fióknak nincs Onelap kapcsolata")
    item.click()
    assert page.locator("#onelapImportOverlay").is_visible()
    # automatikus import: a kapcsoló a szerver állapotát mutatja
    auto = page.evaluate("""async () => {
        const r = await fetch('/api/onelap/auto-sync', {headers: {Authorization: 'Bearer ' + localStorage.getItem('bringaterv_jwt')}});
        return (await r.json()).enabled;
    }""")
    assert page.locator("#onelapAutoToggle").is_checked() == bool(auto)
    assert page.locator("#onelapAutoOpts").is_hidden() == (not auto)
    page.select_option("#onelapImportRange", "365")
    page.click("#onelapImportListBtn")
    page.wait_for_function("document.querySelectorAll('#onelapImportList .strava-import-row').length > 0"
                           " || /Hiba|Nincs/.test(document.querySelector('#onelapImportStatus').textContent)",
                           timeout=60000)
    assert "Hiba" not in page.text_content("#onelapImportStatus")
    rows = page.locator("#onelapImportList .strava-import-row")
    assert rows.count() > 0
    assert no_horizontal_overflow(page)
    shot(page, "onelap-import")
    page.click("#onelapImportClose")
    assert page.locator("#onelapImportOverlay").is_hidden()
    assert not real_errors(page), real_errors(page)
    assert not page.blocked_writes, page.blocked_writes


def test_export_modal_device_buttons(page):
    login(page)
    connected, garmin = page.evaluate("""async () => {
        const h = {headers: {Authorization: 'Bearer ' + localStorage.getItem('bringaterv_jwt')}};
        const o = await (await fetch('/api/onelap/status', h)).json();
        const g = await (await fetch('/api/garmin/status', h)).json();
        return [o.connected, g.connected];
    }""")
    # a Mentés gomb csak útvonallal aktív → két pont a térképre
    page.click('[data-tab="plan"]:visible')
    page.wait_for_timeout(800)
    for i, (lat, lng) in enumerate(POINTS[:2], start=1):
        page.keyboard.press("Escape")
        fit_points_into_visible_map(page, POINTS[:2])
        click_latlng(page, lat, lng)
        page.wait_for_function(f"{WP_COUNT} === {i}", timeout=8000)
    page.wait_for_function("!document.querySelector('#exportButton').disabled", timeout=30000)
    page.evaluate("document.querySelector('#exportButton').click()")
    page.wait_for_selector("#exportOverlay:not([hidden])")
    assert page.locator("#exportOnelap").is_visible() == bool(connected)
    assert page.locator("#exportGarmin").is_visible() == bool(garmin)
    shot(page, "export-modal")
    page.keyboard.press("Escape")
    assert not real_errors(page), real_errors(page)
