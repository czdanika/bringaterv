# Admin felület: közösségi útvonalak miniatűrje + térkép ablak (admin jogú fiók kell).

import pytest

from conftest import BASE, login, no_horizontal_overflow, real_errors, shot


def open_admin(pg):
    login(pg)
    pg.goto(BASE + "/admin.html")
    pg.wait_for_timeout(2000)
    if "admin.html" not in pg.url:
        pytest.skip("a fiók nem admin")


def test_samples_thumbnails_and_map(page):
    open_admin(page)
    page.click('[data-section="samples"]:visible')
    page.wait_for_function("document.querySelectorAll('.trk-thumb svg').length > 0", timeout=20000)
    thumbs = page.locator(".trk-thumb").count()
    drawn = page.locator(".trk-thumb svg").count()
    assert drawn == thumbs, f"{thumbs - drawn} miniatűr üres"
    assert no_horizontal_overflow(page)
    shot(page, "admin-samples")

    page.locator(".trk-thumb").first.click()
    page.wait_for_function("document.querySelectorAll('#trackMap path.leaflet-interactive').length >= 2",
                           timeout=30000)
    assert "Hiba" not in page.text_content("#trackMapSub")
    shot(page, "admin-map")

    page.locator(".leaflet-control-layers").first.hover()
    page.locator(".leaflet-control-layers-base label", has_text="Domborzat").click()
    page.wait_for_function("[...document.querySelectorAll('#trackMap img.leaflet-tile')]"
                           ".some(i => i.src.includes('opentopomap'))", timeout=15000)

    page.keyboard.press("Escape")
    assert page.locator("#trackMapModal").is_hidden()
    assert not real_errors(page), real_errors(page)


def test_samples_filter(page):
    open_admin(page)
    page.click('[data-section="samples"]:visible')
    page.wait_for_selector("#samplesWrap tbody tr")
    rows = lambda: page.locator("#samplesWrap tbody tr").count()
    total = rows()
    page.fill("#sfQuery", "balaton")
    assert 0 < rows() < total
    assert "/" in page.text_content("#sfCount")
    page.fill("#sfQuery", "")
    page.select_option("#sfDist", "100-")
    kms = [float(t.split()[0]) for t in page.locator('#samplesWrap td[data-label="Távolság"]').all_text_contents()]
    assert kms and all(k >= 100 for k in kms), kms
    page.click("#sfReset")
    assert rows() == total
    assert no_horizontal_overflow(page)
    assert not real_errors(page), real_errors(page)
