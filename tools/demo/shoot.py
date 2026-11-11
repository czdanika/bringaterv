#!/usr/bin/env python3
"""Bringaterv – a Mi ez? oldal képernyőképei a bemutató fiókból (tools/demo/seed_demo.py).

  tests/.venv/bin/python tools/demo/shoot.py            # mind
  tests/.venv/bin/python tools/demo/shoot.py elemzes    # csak a megnevezettek

Asztal: 1440×840 (közösségi térkép 1440×690), mobil: iPhone 13 (2×) → 780×1688. JPEG a screenshots/ mappába.
Az AI-elemzéshez (elemzes-ai, mobil-ai-elemzes) valódi AI-hívás megy a bemutató fiók napi keretéből.
"""

import re
import sys
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
ENV = dict(l.strip().split("=", 1) for l in (ROOT / "tests/.env").read_text().splitlines() if "=" in l and not l.startswith("#"))
BASE = ENV.get("BT_BASE", "http://192.168.0.136:8088")
USER, PASS = ENV["DEMO_USER"], ENV["DEMO_PASS"]
OUT = ROOT / "screenshots"
ONLY = set(sys.argv[1:])

INIT = """
(() => {
  let _L;
  Object.defineProperty(window, "L", { configurable: true, get() { return _L; },
    set(v) { _L = v; try { v.Map.addInitHook(function () { window.__map = this; }); } catch (e) {} } });
  try { localStorage.setItem("bringaterv_install_dismissed", String(Date.now())); localStorage.setItem("bringaterv.whatsNewSeen", "99.0.0"); } catch (e) {}
})();
"""


def api_ids():
    tok = requests.post(f"{BASE}/api/auth/login", json={"username": USER, "password": PASS}, timeout=20).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    # térkép: „Standard” alaptérkép a képekhez
    st = requests.get(f"{BASE}/api/user/settings", headers=h, timeout=20).json() or {}
    st["mapStyle"] = "standard"
    requests.put(f"{BASE}/api/user/settings", headers=h, json=st, timeout=20)
    lib = requests.get(f"{BASE}/api/routes", headers=h, timeout=30).json()
    items = lib.get("routes", lib) if isinstance(lib, dict) else lib
    workouts = [e for e in items if e.get("type") == "workout"]
    long_ride = sorted([e for e in workouts if e.get("name") == "Hétvégi hosszú túra"], key=lambda e: e.get("date") or "")[-1]
    plan = next(e for e in items if e.get("name") == "Balaton-felvidéki gravel")
    return long_ride["id"], plan["id"]


def login(pg):
    pg.goto(BASE + "/login.html")
    pg.fill("#username", USER); pg.fill("#password", PASS); pg.check("#privacyConsent"); pg.click("button.login-btn")
    pg.wait_for_selector('[data-tab="plan"]', state="visible", timeout=30000)
    pg.wait_for_function("window.__map !== undefined", timeout=30000)
    pg.wait_for_timeout(2500)


def home(pg):
    pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="plan"]', state="visible", timeout=30000); settle(pg, 1500)


def settle(pg, ms=2500):
    try:
        pg.wait_for_load_state("networkidle", timeout=12000)
    except Exception:
        pass                                   # a térképcsempék / háttérkérések miatt nem mindig csendes
    pg.wait_for_timeout(ms)


def shot(pg, name, clip=None):
    if ONLY and name not in ONLY:
        return
    pg.evaluate("document.querySelector('.install-banner')?.remove()")
    path = OUT / f"{name}.jpg"
    pg.screenshot(path=str(path), type="jpeg", quality=86, clip=clip)
    print("  ✓", path.relative_to(ROOT))


def want(*names):
    return not ONLY or any(n in ONLY for n in names)


def open_workout(pg, wid):
    pg.goto(f"{BASE}/?open={wid}")
    pg.wait_for_selector("#fileDetails:not([hidden])", timeout=30000)
    settle(pg, 3000)


def open_plan(pg, pid):
    pg.goto(f"{BASE}/?open={pid}")
    pg.wait_for_selector("#loadPreviewSkipBtn", state="visible", timeout=30000)
    if pg.locator("#loadPreviewAnchorCheck").is_visible() and pg.is_checked("#loadPreviewAnchorCheck"):
        pg.uncheck("#loadPreviewAnchorCheck")          # csak rajt / cél – a köztes fordulópontok nélkül
    pg.click("#loadPreviewSkipBtn")
    pg.wait_for_selector("#loadPreviewOverlay", state="hidden", timeout=15000)
    pg.wait_for_selector('#tabPlan:not([hidden])', timeout=30000)
    # az útvonal (BRouter) elkészültéig
    pg.wait_for_function("/[1-9]/.test(document.querySelector('#distanceValue')?.textContent || '')", timeout=60000)
    settle(pg, 3500)


def suggest(pg, mobile=False):
    # üres tervező (a korábban betöltött terv piszkozatként visszajönne, és akkor a javaslat-gomb rejtve van)
    pg.evaluate("localStorage.removeItem('bringaterv.planDraft')")
    pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="plan"]', state="visible", timeout=30000); settle(pg, 1500)
    pg.click('[data-tab="plan"]:visible'); pg.wait_for_timeout(800)
    pg.locator("[data-open-suggest]:visible").first.click()
    pg.wait_for_selector("#suggestPanel:not([hidden])", timeout=10000)
    # rajt: Balatonfüred (kattintás a térképen)
    pg.evaluate("window.__map.setView([46.96, 17.89], 11, { animate: false })"); pg.wait_for_timeout(800)
    pt = pg.evaluate("(() => { const p = window.__map.latLngToContainerPoint([46.958, 17.893]); const r = window.__map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; })()")
    pg.mouse.click(pt[0], pt[1]); pg.wait_for_timeout(1500)
    pg.locator('[data-sg-hills="hilly"]').first.click()
    pg.evaluate("(() => { const r = document.getElementById('sgKm'); r.value = 50; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()")
    pg.wait_for_timeout(500)
    pg.click("#sgGo")
    pg.wait_for_selector("#sgResults .sg-card", timeout=180000)
    settle(pg, 3000)


def main():
    OUT.mkdir(exist_ok=True)
    wid, plan_id = api_ids()
    with sync_playwright() as p:
        br = p.chromium.launch(channel="chrome")
        # ── asztal ──
        ctx = br.new_context(viewport={"width": 1440, "height": 840}, locale="hu-HU", timezone_id="Europe/Budapest")
        ctx.add_init_script(INIT)
        pg = ctx.new_page()
        login(pg)
        if want("kezdolap"):
            pg.click('[data-tab="home"]:visible'); settle(pg, 3500); shot(pg, "kezdolap")
        if want("tervezes"):
            open_plan(pg, plan_id)
            for sel in ("#gradeMapTogglePlan",):
                if pg.locator(sel).count() and not pg.is_checked(sel):
                    pg.locator(sel).evaluate("el => el.click()")
            if pg.locator("#elevationPanel").is_hidden():
                pg.locator("#elevationBtn").evaluate("el => el.click()")      # szintprofil a térkép alján
            settle(pg, 2500); shot(pg, "tervezes")
        if want("utvonal-javaslat"):
            pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="plan"]', state="visible"); settle(pg, 2000)
            suggest(pg); shot(pg, "utvonal-javaslat")
        if want("elemzes", "elemzes-ai"):
            open_workout(pg, wid)
            pg.click("#hrLegend .toggle-switch"); pg.wait_for_timeout(600)
            pg.click("#hrLegend .speed-legend-expand"); pg.wait_for_timeout(400)
            for b in ("#gradeLegendChartBtn", "#hrChartBtn"):
                pg.locator(b).evaluate("el => el.click()"); pg.wait_for_timeout(700)
            settle(pg, 2000); shot(pg, "elemzes")
            if want("elemzes-ai"):
                for b in ("#gradeLegendChartBtn", "#hrChartBtn"):
                    pg.locator(b).evaluate("el => el.click()")
                pg.click("#hrLegend .toggle-switch"); pg.wait_for_timeout(400)
                if pg.locator('[data-ai="run"]').count():
                    if pg.locator("#fAiCtx").count():
                        pg.fill("#fAiCtx", "hétvégi edzőkör")
                    pg.locator('[data-ai="run"]').first.click()
                    pg.wait_for_selector("#fAiPoints, #fAiLead, .f-ai-lead", timeout=180000)
                settle(pg, 2000); shot(pg, "elemzes-ai")
        if want("konyvtar"):
            pg.evaluate("localStorage.setItem('bringaterv.libraryView', 'list')")
            pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="library"]', state="visible"); settle(pg, 1500)
            pg.click('[data-tab="library"]:visible'); settle(pg, 2500)
            pg.click('[data-lib-type="workout"]'); settle(pg, 1500)
            pg.locator(".library-list-row").first.click(); settle(pg, 3000); shot(pg, "konyvtar")
        if want("kozossegi-terkep"):
            pg.evaluate("localStorage.setItem('bringaterv.libraryView', 'map')")
            pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="library"]', state="visible"); settle(pg, 1500)
            pg.click('[data-tab="library"]:visible'); settle(pg, 1500)
            pg.click('[data-lib-type="sample"]'); settle(pg, 4000)
            pg.set_viewport_size({"width": 1440, "height": 690}); settle(pg, 1500)
            pg.locator("#libraryMap .leaflet-control-zoom-in").click(); settle(pg, 3000)
            shot(pg, "kozossegi-terkep")
            pg.set_viewport_size({"width": 1440, "height": 840})
            pg.evaluate("localStorage.setItem('bringaterv.libraryView', 'cards')")
        if want("rekordok"):
            home(pg); pg.click('[data-tab="stats"]:visible'); settle(pg, 1500)
            pg.click('[data-stats-view="records"]'); settle(pg, 3500)
            try:
                pg.wait_for_function("!/Számítás folyamatban|számítása/.test(document.querySelector('#statsMain')?.textContent || '')", timeout=180000)
            except Exception:
                pass
            settle(pg, 1500); shot(pg, "rekordok")
        if want("felszereles"):
            home(pg); pg.click('[data-tab="gear"]:visible'); pg.wait_for_selector(".gear-card", timeout=20000); settle(pg, 3000); shot(pg, "felszereles")
        ctx.close()

        # ── mobil (iPhone 13, 2×) ──
        if want("mobil-tervezes", "mobil-utvonal-javaslat", "mobil-ai-elemzes"):
            # a teljes kijelző (390×844) 2×-esen → 780×1688, mint a Mi ez? oldal képkerete (a gyári iPhone 13
            # profil 390×664-es nézetet és 3×-ost ad – a telefon zömök lenne)
            ctx = br.new_context(**{**p.devices["iPhone 13"], "viewport": {"width": 390, "height": 844},
                                    "screen": {"width": 390, "height": 844}, "device_scale_factor": 2},
                                 locale="hu-HU", timezone_id="Europe/Budapest")
            ctx.add_init_script(INIT)
            pg = ctx.new_page()
            login(pg)
            if want("mobil-tervezes"):
                open_plan(pg, plan_id)
                if pg.locator("#gradeMapTogglePlan").count() and not pg.is_checked("#gradeMapTogglePlan"):
                    pg.locator("#gradeMapTogglePlan").evaluate("el => el.click()")
                settle(pg, 2000); shot(pg, "mobil-tervezes")
            if want("mobil-utvonal-javaslat"):
                pg.goto(BASE + "/"); pg.wait_for_selector('[data-tab="plan"]', state="visible"); settle(pg, 2000)
                suggest(pg, mobile=True); shot(pg, "mobil-utvonal-javaslat")
            if want("mobil-ai-elemzes"):
                open_workout(pg, wid)
                pg.evaluate("document.querySelector('.app-shell').dataset.sheet = 'half'"); settle(pg, 1500)
                if pg.locator("#fFileAi").count():
                    pg.locator("#fFileAi").scroll_into_view_if_needed()
                settle(pg, 1200); shot(pg, "mobil-ai-elemzes")
            ctx.close()
        br.close()


if __name__ == "__main__":
    main()
