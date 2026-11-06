# Garmin Connect: import ablak + automatikus import panel. Csak olvas (GET),
# Garmin-kapcsolat nélkül kihagyja.

import pytest

from conftest import login, no_horizontal_overflow, real_errors, shot


def test_garmin_import_modal_auto_panel(page):
    login(page)
    page.click('[data-tab="library"]:visible')
    page.click("#libraryImportBtn")
    item = page.locator("#libraryImportGarminItem")
    page.wait_for_timeout(2000)
    if item.is_disabled():
        pytest.skip("a fióknak nincs Garmin-kapcsolata")
    item.click()
    assert page.locator("#garminImportOverlay").is_visible()
    # a duplikált Strava-blokk nincs a Garmin-ablakban
    assert page.locator("#garminImportOverlay #stravaAuto").count() == 0
    auto = page.evaluate("""async () => {
        const r = await fetch('/api/garmin/auto-sync', {headers: {Authorization: 'Bearer ' + localStorage.getItem('bringaterv_jwt')}});
        return (await r.json()).enabled;
    }""")
    # a panel a kapcsolat-státusz után töltődik be (aszinkron) – megvárjuk
    page.wait_for_function(f"document.querySelector('#garminAutoToggle').checked === {str(bool(auto)).lower()}", timeout=10000)
    assert page.locator("#garminAutoToggle").is_checked() == bool(auto)
    assert page.locator("#garminAutoOpts").is_hidden() == (not auto)
    assert no_horizontal_overflow(page)
    shot(page, "garmin-import")
    page.click("#garminImportClose")
    assert not real_errors(page), real_errors(page)
    assert not page.blocked_writes, page.blocked_writes
