# Alap UI-tesztek: belépés, fülek bejárása mobilon és asztalon.

import pytest

from conftest import BASE, login, no_horizontal_overflow, real_errors, shot


def test_login_page(page):
    page.goto(BASE + "/login.html")
    assert page.locator("#loginForm").is_visible()
    assert no_horizontal_overflow(page)
    shot(page, "login")
    assert not real_errors(page)


@pytest.mark.parametrize("tab", ["home", "plan", "file", "library", "stats"])
def test_tab(page, tab):
    login(page)
    page.click(f'[data-tab="{tab}"]:visible')
    page.wait_for_timeout(1500)
    assert "is-active" in page.locator(f'[data-tab="{tab}"]').first.get_attribute("class")
    shot(page, f"tab-{tab}")
    assert no_horizontal_overflow(page), "vízszintes görgetés"
    assert not real_errors(page), real_errors(page)
    assert not page.blocked_writes, page.blocked_writes


@pytest.mark.parametrize("view", ["overview", "monthly", "records", "form", "heatmap", "year"])
def test_stats_views(page, view):
    login(page)
    page.click('[data-tab="stats"]:visible')
    page.click(f'[data-stats-view="{view}"]:visible')
    page.wait_for_timeout(1500)
    shot(page, f"stats-{view}")
    assert no_horizontal_overflow(page), "vízszintes görgetés"
    assert not real_errors(page), real_errors(page)
