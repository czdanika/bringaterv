# Böngészős (Playwright) tesztek közös fixture-jei.
#
# Futtatás:  tests/run.sh            (vagy: tests/.venv/bin/pytest tests)
# Környezet: BT_BASE (alap: http://192.168.0.136:8088), BT_USER, BT_PASS
#            BT_HEADED=1 → látható böngészőablak
#
# A tesztek alapból nem írnak a szerverre: minden POST/PUT/PATCH/DELETE /api/ hívást
# blokkolunk (kivéve a belépést), és a blokkolt hívásokat a teszt végén jelezzük.

import os
import re
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BT_BASE", "http://192.168.0.136:8088").rstrip("/")
USER = os.environ.get("BT_USER", "")
PASS = os.environ.get("BT_PASS", "")
SHOTS = Path(__file__).parent / "screenshots"

DEVICES = {
    "iphone":  "iPhone 13",
    "android": "Pixel 7",
    "desktop": None,
}

# A „Failed to load resource” konzolüzenetben nincs URL – helyette a hibás válaszokat
# a response-figyelő naplózza URL-lel, és ezeket szűrjük.
IGNORED_ERRORS = [
    re.compile(r"^Failed to load resource"),
    re.compile(r"api\.github\.com/repos/.*/releases/latest"),   # privát repó → 404
]

# Térkép-példány elérhetővé tétele a teszteknek (window.__map)
MAP_HOOK = """
(() => {
  let _L;
  Object.defineProperty(window, "L", {
    configurable: true,
    get() { return _L; },
    set(v) {
      _L = v;
      try { v.Map.addInitHook(function () { window.__map = this; }); } catch (e) {}
    },
  });
  try { localStorage.setItem("bringaterv_install_dismissed", String(Date.now())); localStorage.setItem("bringaterv.whatsNewSeen", "99.0.0"); localStorage.setItem("bringaterv.welcomeSeen", "1"); } catch (e) {}
})();
"""


@pytest.fixture(scope="session")
def pw():
    with sync_playwright() as p:
        yield p


@pytest.fixture(scope="session")
def browser(pw):
    b = pw.chromium.launch(channel="chrome", headless=not os.environ.get("BT_HEADED"))
    yield b
    b.close()


@pytest.fixture(params=list(DEVICES), ids=list(DEVICES))
def device(request):
    return request.param


@pytest.fixture
def page(pw, browser, device, request):
    name = DEVICES[device]
    opts = dict(pw.devices[name]) if name else {"viewport": {"width": 1440, "height": 900}}
    ctx = browser.new_context(**opts, locale="hu-HU", timezone_id="Europe/Budapest")
    ctx.add_init_script(MAP_HOOK)

    blocked = []

    def guard(route):
        req = route.request
        if req.method == "POST" and req.url.endswith("/api/gear/devices/auto-photos"):
            # a Felszerelés megnyitásakor magától fut (eszközképek, összevonás) – teszt alatt üres válasz
            route.fulfill(status=200, content_type="application/json", body='{"pending": 0}')
            return
        if req.method != "GET" and "/api/auth/login" not in req.url:
            blocked.append(f"{req.method} {req.url}")
            route.fulfill(status=503, body="blocked by test")
        else:
            route.continue_()

    ctx.route(re.compile(r".*/api/.*"), guard)

    pg = ctx.new_page()
    pg.errors = []
    pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
    pg.on("pageerror", lambda e: pg.errors.append(f"PAGEERROR {e}"))
    pg.on("response", lambda r: r.status >= 400 and pg.errors.append(f"HTTP {r.status} {r.url}"))
    pg.blocked_writes = blocked
    pg.device = device
    yield pg

    SHOTS.mkdir(exist_ok=True)
    try:
        pg.screenshot(path=SHOTS / f"{request.node.name}-end.png")
    except Exception:
        pass
    ctx.close()
    if blocked:
        print(f"\n[{request.node.name}] blokkolt írási kísérletek: {blocked}")


def login(pg):
    if not USER or not PASS:
        pytest.skip("BT_USER / BT_PASS nincs megadva")
    pg.goto(BASE + "/login.html")
    pg.fill("#username", USER)
    pg.fill("#password", PASS)
    pg.check("#privacyConsent")
    pg.click("button.login-btn")
    pg.wait_for_url(re.compile(r"/(index\.html)?$"), timeout=30000, wait_until="commit")
    pg.wait_for_selector('[data-tab="plan"]', state="visible", timeout=30000)
    pg.wait_for_function("window.__map !== undefined", timeout=30000)
    pg.wait_for_timeout(1000)   # a modulok init-je a térkép után fut le


def real_errors(pg):
    """Saját hibák (JS, a Pi API-ja, BRouter). Külső szolgáltatás (Open-Meteo, csempék,
    Waymarked Trails…) átmeneti hibáját csak kiírjuk, nem buktatja el a tesztet."""
    own = []
    for e in pg.errors:
        if any(r.search(e) for r in IGNORED_ERRORS):
            continue
        if e.startswith("HTTP ") and BASE not in e:
            print(f"\n  [figyelmeztetés, külső szolgáltatás] {e}")
            continue
        # Külső szolgáltatás CORS-hibája (pl. a Nominatim korlátozáskor CORS-fejléc nélkül ad 429-et)
        m = re.match(r"Access to fetch at '(https?://[^/']+)", e)
        if m and not BASE.startswith(m.group(1)):
            print(f"\n  [figyelmeztetés, külső szolgáltatás] {e[:160]}")
            continue
        own.append(e)
    return own


def no_horizontal_overflow(pg):
    return pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def shot(pg, name):
    SHOTS.mkdir(exist_ok=True)
    pg.screenshot(path=SHOTS / f"{pg.device}-{name}.png")
