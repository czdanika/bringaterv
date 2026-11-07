# Felszerelés (saját főmenüpont a bal menüben / mobilon az alsó sávban): a nézet
# kirajzolódik, nincs vízszintes görgetés, a felirat elfér. Csak olvas.

from conftest import login, no_horizontal_overflow, real_errors, shot


def test_gear_tab(page):
    login(page)
    page.click('[data-tab="gear"]:visible')
    page.wait_for_function("document.querySelector('#gearMain .gear-top')", timeout=15000)
    assert page.locator("#gearMain").is_visible()
    assert page.locator("#libraryMain").is_hidden()
    assert page.locator(".map-wrap").is_hidden()
    assert no_horizontal_overflow(page)
    assert page.evaluate("""() => { const l = document.querySelector('[data-tab=gear] .rail-label');
        return l.scrollWidth <= l.parentElement.clientWidth; }""")
    # minden bringakártyán van fotó-mező (kép vagy „+ fotó” gomb)
    assert page.locator(".gear-card").count() == page.locator(".gear-card-head .gear-photo").count()
    shot(page, "gear")
    # a Könyvtárban már nincs Felszerelés fül
    page.click('[data-tab="library"]:visible')
    page.wait_for_timeout(1000)
    assert page.locator('[data-lib-type="gear"]').count() == 0
    assert page.locator("#gearMain").is_hidden()
    assert not real_errors(page), real_errors(page)
    assert not page.blocked_writes, page.blocked_writes
