# Wahoo / Polar: beállítás-szekció (saját alkalmazás útmutatóval), import menüpont. Csak olvas.

import pytest

from conftest import BASE, login, no_horizontal_overflow, real_errors, shot

PROVIDERS = [("wahoo", "Wahoo"), ("polar", "Polar")]


@pytest.mark.parametrize("key,label", PROVIDERS)
def test_device_settings_and_menu(page, key, label):
    login(page)
    page.wait_for_function(
        f"!document.querySelector('#{key}ConnectionState .strava-conn-loading')", timeout=15000)
    status = page.evaluate(f"""async () => {{
        const r = await fetch('/api/{key}/status', {{headers: {{Authorization: 'Bearer ' + localStorage.getItem('bringaterv_jwt')}}}});
        return await r.json();
    }}""")
    text = page.text_content(f"#{key}ConnectionState")
    if not status["app_configured"]:
        # útmutató + űrlap; a Redirect URI a böngésző címéből jön (porttal / https-sel együtt)
        assert page.locator(f"#{key}ConnectionState .device-app-steps li").count() >= 4
        redirect = page.text_content(f"#{key}ConnectionState [data-dev-redirect]")
        assert redirect == f"{BASE}/api/{key}/callback", redirect
    elif status["connected"]:
        assert "Csatlakozva" in text
    else:
        assert page.locator(f"#{key}ConnectionState [data-dev-connect]").count() == 1
    page.click('[data-tab="library"]:visible')
    page.click("#libraryImportBtn")
    item = page.locator(f"#libraryImport{label}Item")
    assert item.is_visible()
    assert item.is_disabled() == (not status["connected"])
    assert page.locator(f"#libraryImport{label}Item img.brand-icon").evaluate("i => i.naturalWidth > 0")
    assert no_horizontal_overflow(page)
    assert not real_errors(page), real_errors(page)
    assert not page.blocked_writes, page.blocked_writes

