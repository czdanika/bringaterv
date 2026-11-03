// ── Navigáció a megtervezett útvonalon (gyalog és kerékpárral) ───────────────
// Folyamatos GPS-követés (watchPosition), ráillesztés az útvonalra, hátralévő táv / idő / szint,
// letérés-figyelés (rezgés + hang), kanyar-utasítások felolvasva (BRouter voicehints, ha nincs:
// a vonal töréseiből), a képernyő ébren tartása (Wake Lock). A böngésző zárolt képernyőnél /
// háttérben nem ad helyet – a navigáció csak előtérben, bekapcsolt képernyővel működik.
// Induláskor az első GPS-jel dönt: az útvonal elején, közepén (melyik ágon), vagy messze vagy –
// szükség esetén bekötő szakaszt tervez az útra; a félbehagyott navigáció folytatható.
// Próba otthon: az URL-ben ?navsim (vagy ?navsim=KM:ELTOLÁS_M, pl. ?navsim=5:400 – az 5. km-től
// 400 m-re északra indul) → „Próba” gomb, ami végigmegy az útvonalon.

import { activityOf } from "../routeModes.js";
import { num } from "../format.js";

let _d = null;   // { mapAdapter, store, showToast, getSpeed(mode), getGeometry(), getHints(), canStart(), route(wps, mode) }
let nav = null;  // futó navigáció állapota
const $ = (id) => document.getElementById(id);

// tevékenységenként: letérési küszöb (m), követési zoom, bejelentési távok
const CFG = {
  foot: { off: 40, zoom: 17, far: () => 70, near: () => 15, vam: 300 },
  bike: { off: 50, zoom: 16, far: (v) => Math.min(300, Math.max(120, v * 15)), near: (v) => Math.min(60, Math.max(25, v * 4)), vam: 700 },
};

// BRouter parancskódok (geojson voicehints) → szöveg; az irányt a szög adja a nyílhoz
const CMD = {
  1: "egyenesen tovább", 2: "balra", 3: "enyhén balra", 4: "élesen balra", 5: "jobbra", 6: "enyhén jobbra",
  7: "élesen jobbra", 8: "tarts balra", 9: "tarts jobbra", 10: "fordulj vissza", 11: "fordulj vissza", 15: "fordulj vissza",
  13: "körforgalom", 14: "körforgalom", 17: "kijárat balra", 18: "kijárat jobbra",
};
const hintText = (h) => {
  if (h.cmd === "join") return "itt rátérsz az útvonalra";
  if (h.cmd === "trail") return `a ${h.trail?.ref || h.trail?.name || "jelzés"} jelzésen tovább`;
  if (h.cmd === 13 || h.cmd === 14) return h.exit ? `a körforgalomból a ${h.exit}. kijáraton` : "a körforgalomban tovább";
  return CMD[h.cmd] || (h.angle < 0 ? "balra" : "jobbra");
};
// Hangfájl-kulcs (assets/voice/*.json, tools/voice/generate.py) – a beépített természetes hangokhoz
const CMD_ID = { 1: "c", 2: "tl", 3: "tsll", 4: "tshl", 5: "tr", 6: "tslr", 7: "tshr", 8: "kl", 9: "kr", 10: "tu", 11: "tu", 15: "tu", 17: "el", 18: "er" };
function trailId(ref = "") {
  if (/^OKT/i.test(ref)) return "tokt";
  const m = /^([KPSZ])\s*([+▲●■]?)$/i.exec(ref.trim());
  return m ? `t${m[1].toLowerCase()}${{ "": "", "+": "+", "▲": "3", "●": "q", "■": "4" }[m[2]]}` : "tany";
}
const hintId = (h) => (h.cmd === "join" ? "join" : h.cmd === "trail" ? trailId(h.trail?.ref)
  : h.cmd === 13 || h.cmd === 14 ? (h.exit >= 1 && h.exit <= 6 ? `rb${h.exit}` : "rb") : CMD_ID[h.cmd] || (h.angle < 0 ? "tl" : "tr"));
const distKey = (m) => `d${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50}`;
const hintAngle = (h) => (h.cmd === "trail" || h.cmd === "join" ? 0 : [10, 11, 15].includes(h.cmd) ? 180 : h.cmd === 13 || h.cmd === 14 ? 90 : Math.max(-150, Math.min(150, h.angle || 0)));

// ── Geometria-segédek ──
const R = 6371000, RAD = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
// pont–szakasz távolság helyi síkban: { d, t } (t: 0..1 a szakaszon)
function segDist(p, a, b) {
  const kx = Math.cos(p.lat * RAD) * R * RAD, ky = R * RAD;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

// Kanyarok a vonal töréseiből (betöltött GPX-nél nincs BRouter-utasítás): ±25 m-es irányváltás > 45°
function geometryHints(g, cum) {
  const out = [];
  let a = 0, b = 0;
  for (let i = 1; i < g.length - 1; i++) {
    while (a < i && cum[i] - cum[a + 1] >= 25) a++;
    if (b < i) b = i;
    while (b < g.length - 1 && cum[b] - cum[i] < 25) b++;
    if (cum[i] - cum[a] < 15 || cum[b] - cum[i] < 15) continue;
    const d = ((bearing(g[i], g[b]) - bearing(g[a], g[i]) + 540) % 360) - 180;
    if (Math.abs(d) < 45) continue;
    const last = out[out.length - 1];
    if (last && cum[i] - cum[last.i] < 30) { if (Math.abs(d) > Math.abs(last.angle)) out[out.length - 1] = { i, angle: d }; continue; }
    out.push({ i, angle: d });
  }
  return out.map(({ i, angle }) => ({ i, angle, cmd: Math.abs(angle) > 120 ? (angle < 0 ? 4 : 7) : (angle < 0 ? 2 : 5) }));
}

// ── Beállítások (ezen az eszközön): bekapcsolás, utasítás-mód, hang ──
const ls = (k, def) => { try { return localStorage.getItem(k) ?? def; } catch { return def; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* privát mód */ } };
export const navEnabled = () => ls("bringaterv.navEnabled", "false") === "true";
const soundMode = () => ls("bringaterv.navSound", "speech");   // speech | beep | off
// hang: „piper:berta” / „piper:imre” (beépített, természetes), „” = a telefon automatikus hangja, vagy egy telefonhang neve
const voiceChoice = () => ls("bringaterv.navVoiceName", "piper:berta");
const PIPER = { "piper:berta": "Berta – természetes női hang", "piper:imre": "Imre – természetes férfi hang" };
const huVoices = () => { try { return speechSynthesis.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("hu")); } catch { return []; } };

// ── Hang, rezgés, ébren tartás ──
// `kind`: far (előre szól) | near (most) | off (letérés) | back | end – hangjelzés módban ebből lesz a dallam
// `keys`: a mondat a beépített hangfájlokból (ha mind megvan); különben a telefon felolvasója
function speak(text, kind = "far", force = false, keys = null) {
  if (!force && (!nav || nav.muted)) return;
  const mode = soundMode();
  if (mode === "beep") { beep(kind); return; }
  if (mode !== "speech") return;
  const choice = voiceChoice();
  if (PIPER[choice] && keys?.length) {
    playClips(choice.slice(6), keys.filter(Boolean)).then((ok) => { if (!ok) ttsSpeak(text, ""); });
    return;
  }
  ttsSpeak(text, PIPER[choice] ? "" : choice);
}
function ttsSpeak(text, want) {
  if (!("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "hu-HU";
    const voices = huVoices();
    const v = voices.find((x) => x.name === want) || voices.find((x) => /premium|enhanced|bővített|prémium/i.test(x.name)) || voices[0];
    if (v) u.voice = v;
    u.rate = 1.0;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* nincs hang – nem baj */ }
}
let _ac = null;
// iOS: a hangot felhasználói érintésre kell „feloldani” (indításkor / a Próba gombnál)
function audio() {
  _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
  if (_ac.state === "suspended") _ac.resume().catch(() => {});
  return _ac;
}
const _sprites = {};
function loadVoice(name) {
  if (!_sprites[name]) {
    _sprites[name] = Promise.all([
      fetch(`assets/voice/${name}.json`).then((r) => r.json()),
      fetch(`assets/voice/${name}.mp3`).then((r) => r.arrayBuffer()).then((b) => new Promise((res, rej) => audio().decodeAudioData(b, res, rej))),
    ]).then(([map, buf]) => ({ map, buf })).catch((e) => { delete _sprites[name]; throw e; });
  }
  return _sprites[name];
}
let _playing = [];
async function playClips(name, keys) {
  try {
    const { map, buf } = await loadVoice(name);
    if (!keys.every((k) => map[k])) return false;
    const ac = audio();
    _playing.forEach((s) => { try { s.stop(); } catch { /* már leállt */ } });
    _playing = [];
    let t = ac.currentTime + 0.05;
    for (const k of keys) {
      const [off, dur] = map[k];
      const src = ac.createBufferSource();
      src.buffer = buf; src.connect(ac.destination);
      src.start(t, off, dur);
      _playing.push(src);
      t += dur + 0.06;
    }
    return true;
  } catch { return false; }
}
function beep(kind) {
  try {
    audio();
    const tones = { far: [[880, 0.12]], near: [[880, 0.1], [1175, 0.16]], off: [[330, 0.18], [262, 0.18], [330, 0.18]],
                    back: [[660, 0.1], [880, 0.12]], end: [[523, 0.12], [659, 0.12], [784, 0.24]], test: [[880, 0.1], [1175, 0.16]] }[kind] || [[880, 0.12]];
    let t = _ac.currentTime + 0.02;
    for (const [f, d] of tones) {
      const o = _ac.createOscillator(), g = _ac.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(_ac.destination); o.start(t); o.stop(t + d + 0.02);
      t += d + 0.07;
    }
  } catch { /* nincs hang */ }
}

function initNavSettings(refresh) {
  const en = $("navEnabledToggle"), snd = $("navSoundSelect"), vs = $("navVoiceSelect");
  if (!en) return;
  const paint = () => {
    $("navSetFields").hidden = !en.checked;
    $("navVoiceWrap").hidden = snd.value !== "speech";
  };
  const fillVoices = () => {
    const voices = huVoices(), want = voiceChoice();
    const opt = (v, l) => `<option value="${v.replace(/"/g, "&quot;")}"${v === want ? " selected" : ""}>${l}</option>`;
    vs.innerHTML = `<optgroup label="Beépített (offline)">${Object.entries(PIPER).map(([v, l]) => opt(v, l)).join("")}</optgroup>
      <optgroup label="A telefon felolvasója">${opt("", "Automatikus")}${voices.map((v) => opt(v.name, `${v.name}${v.localService ? "" : " (online)"}`)).join("")}</optgroup>`;
  };
  en.checked = navEnabled();
  snd.value = soundMode();
  fillVoices();
  try { speechSynthesis.addEventListener?.("voiceschanged", fillVoices); } catch { /* nincs beszéd */ }
  paint();
  en.addEventListener("change", () => { lsSet("bringaterv.navEnabled", String(en.checked)); paint(); refresh(); });
  snd.addEventListener("change", () => { lsSet("bringaterv.navSound", snd.value); paint(); });
  vs.addEventListener("change", () => lsSet("bringaterv.navVoiceName", vs.value));
  $("navSoundTest").addEventListener("click", () => { audio(); buzz(80); speak("200 méter múlva balra, majd jobbra.", "test", true, ["d200", "i:tl", "m:tr"]); });
}
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* nincs rezgés */ } };
async function keepAwake() {
  try { nav.wake = await navigator.wakeLock?.request("screen"); } catch { nav.wake = null; }
}
// a böngésző háttérbe tételkor elengedi – visszatéréskor újra kérjük
function onVisible() { if (nav && document.visibilityState === "visible") keepAwake(); }

const fmtDist = (m) => (m >= 1000 ? `${num(m / 1000, m >= 10000 ? 0 : 1)} km` : `${m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50} m`);
const fmtClock = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const arrowSvg = (deg) => `<svg viewBox="0 0 24 24" width="40" height="40" style="transform:rotate(${deg}deg)" aria-hidden="true"><path d="M12 3 19 11h-4.5v10h-5V11H5z" fill="currentColor"/></svg>`;

// ── Indítás / befejezés ──
export function initNavigation(deps) {
  _d = deps;
  const wrap = document.querySelector(".map-wrap");
  if (!wrap || $("navTop")) return;
  wrap.insertAdjacentHTML("beforeend", `
    <div class="nav-top" id="navTop" hidden>
      <div class="nav-arrow" id="navArrow"></div>
      <div class="nav-instr"><b id="navDist"></b><span id="navText"></span><small id="navThen"></small></div>
    </div>
    <div class="nav-ask" id="navAsk" hidden></div>
    <div class="nav-bottom" id="navBottom" hidden>
      <div class="nav-stats">
        <div><b id="navRemKm">–</b><span>hátra</span></div>
        <div><b id="navEta">–</b><span>érkezés</span></div>
        <div><b id="navRemAsc">–</b><span>emelkedő</span></div>
        <div><b id="navSpeed">–</b><span>km/h</span></div>
      </div>
      <div class="nav-btns">
        <button type="button" class="nav-btn" id="navVoiceBtn" title="Hang be/ki"><i data-lucide="volume-2" aria-hidden="true"></i><span>Hang</span></button>
        <button type="button" class="nav-btn" id="navFollowBtn" title="Vissza a saját helyemre" hidden><i data-lucide="locate-fixed" aria-hidden="true"></i><span>Követés</span></button>
        <button type="button" class="nav-btn" id="navSimBtn" hidden><i data-lucide="play" aria-hidden="true"></i><span>Próba</span></button>
        <button type="button" class="nav-btn nav-btn--stop" id="navStopBtn"><i data-lucide="square" aria-hidden="true"></i><span>Befejezés</span></button>
      </div>
    </div>`);
  window.lucide?.createIcons({ nodes: [$("navBottom")] });
  $("mapNavFabBtn")?.addEventListener("click", start);
  $("navStopBtn").addEventListener("click", () => {
    if (nav?.arrived || confirm("Befejezed a navigációt?")) stop();
  });
  // a navigáció közbeni némítás csak erre az útra szól (a mód a Beállításokban)
  $("navVoiceBtn").addEventListener("click", () => {
    nav.muted = !nav.muted;
    paintVoice();
    if (!nav.muted) speak("Hang bekapcsolva", "back", false, ["e:voiceon"]);
  });
  $("navFollowBtn").addEventListener("click", () => { nav.follow = true; $("navFollowBtn").hidden = true; if (nav.pos) _d.mapAdapter.navFollow(nav.pos, zoomFor()); });
  $("navSimBtn").addEventListener("click", toggleSim);
  _d.mapAdapter.navOnUserMove(() => { if (nav && nav.follow) { nav.follow = false; $("navFollowBtn").hidden = false; } });
  document.addEventListener("visibilitychange", onVisible);
  // a gomb csak akkor látszik, ha a navigáció be van kapcsolva és van indítható útvonal
  const refresh = () => { const b = $("mapNavFabBtn"); if (b) b.hidden = !!nav || !navEnabled() || !_d.canStart(); };
  initNavSettings(refresh);
  _d.store.subscribe(refresh);
  window.addEventListener("bringaterv:tab", refresh);
  refresh();
}

export const isNavigating = () => !!nav;

function paintVoice() {
  const b = $("navVoiceBtn");
  b.classList.toggle("is-off", nav.muted);
  b.innerHTML = `<i data-lucide="${nav.muted ? "volume-x" : "volume-2"}" aria-hidden="true"></i><span>${nav.muted ? "Néma" : "Hang"}</span>`;
  window.lucide?.createIcons({ nodes: [b] });
}

const SIM = /[?&]navsim/.test(location.search);

// Az aktuális navigációs geometria (az útvonal, vagy bekötő szakasz + az útvonal maradéka)
function load(g, rawHints) {
  const cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + hav(g[i - 1], g[i]));
  // emelkedő a hátralévő részre: 3 m-es simítással (a magassági zaj ne adjon fölös métereket)
  const ascCum = [0];
  let base = g[0].ele, acc = 0;
  for (let i = 1; i < g.length; i++) {
    const e = g[i].ele;
    if (e != null && base != null) { if (e - base >= 3) { acc += e - base; base = e; } else if (base - e >= 3) base = e; }
    else if (e != null) base = e;
    ascCum.push(acc);
  }
  const hints = (rawHints?.length ? rawHints : geometryHints(g, cum)).filter((h) => h.cmd !== 1 && h.i > 0 && h.i < g.length - 1)
    .map((h) => ({ ...h, at: cum[h.i], said: 0 }));
  Object.assign(nav, { g, cum, ascCum, total: cum[cum.length - 1], hints, idx: 0, along: 0, simS: null });
}

// ── Félbehagyott navigáció: a haladás útvonalanként (14 napig) ──
const PROGRESS_KEY = "bringaterv.navProgress";
const routeSig = (g, total) => `${g.length}|${g[0].lat.toFixed(5)},${g[0].lng.toFixed(5)}|${g[g.length - 1].lat.toFixed(5)},${g[g.length - 1].lng.toFixed(5)}|${Math.round(total)}`;
// a haladás az eredeti útvonalon (bekötő szakasz esetén a csatlakozástól számolva)
const origAlong = () => (nav.approachLen ? nav.joinAt + Math.max(0, nav.along - nav.approachLen) : nav.along);
function saveProgress(force = false) {
  if (!nav?.orig || nav.phase !== "run" || (!force && Date.now() - nav.savedAt < 20000)) return;
  nav.savedAt = Date.now();
  try {
    const all = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    for (const k in all) if (Date.now() - all[k].at > 14 * 86400e3) delete all[k];
    if (nav.arrived) delete all[nav.orig.sig];
    else all[nav.orig.sig] = { along: origAlong(), at: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
  } catch { /* tele a tároló / privát mód */ }
}
function savedProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}")[nav.orig.sig];
    return p && Date.now() - p.at < 14 * 86400e3 && p.along > 200 && nav.orig.total - p.along > 300 ? p : null;
  } catch { return null; }
}

// ── Kérdés a navigációs ablakban (honnan indulsz) ──
function ask(title, text, opts) {
  return new Promise((resolve) => {
    const box = $("navAsk");
    box.innerHTML = `<b>${title}</b><p>${text}</p><div class="nav-ask-btns">${opts.map(([v, l], i) =>
      `<button type="button" class="nav-btn${i === 0 ? " nav-btn--primary" : ""}" data-v="${v}">${l}</button>`).join("")}</div>`;
    box.hidden = false;
    box.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; box.hidden = true; box.onclick = null; resolve(b.dataset.v); };
  });
}

// Az útvonal azon részei, amelyek közel vannak a ponthoz (körnél / oda-visszánál több is lehet)
function joinCandidates(p, maxD = 150) {
  const { g, cum } = nav.orig, out = [];
  for (let k = 0; k < g.length - 1; k++) {
    const s = segDist(p, g[k], g[k + 1]);
    if (s.d > maxD) continue;
    const at = cum[k] + s.t * (cum[k + 1] - cum[k]), last = out[out.length - 1];
    if (last && at - last.at < 300) { if (s.d < last.d) Object.assign(last, { at, d: s.d, k }); }
    else out.push({ at, d: s.d, k });
  }
  return out;
}
function nearestOnRoute(p) {
  const { g, cum } = nav.orig;
  let best = { d: Infinity, at: 0, k: 0 };
  for (let k = 0; k < g.length - 1; k++) { const s = segDist(p, g[k], g[k + 1]); if (s.d < best.d) best = { d: s.d, k, at: cum[k] + s.t * (cum[k + 1] - cum[k]) }; }
  return best;
}
const dirWord = (b) => ["észak", "északkelet", "kelet", "délkelet", "dél", "délnyugat", "nyugat", "északnyugat"][Math.round(b / 45) % 8];

// Első GPS-jel: honnan indul a navigáció (és kell-e bekötő szakasz)
async function setupStart(p, heading) {
  speak("Honnan indulsz?", "near", false, ["e:where"]);
  const saved = savedProgress();
  let target = null, approach = true;
  if (saved) {
    const d = new Date(saved.at);
    const when = new Date().toDateString() === d.toDateString() ? `ma ${fmtClock(d)}-kor` : `${d.getMonth() + 1}. ${d.getDate()}-én`;
    const a = await ask("Folytatod?", `Ezt az utat ${when} ${fmtDist(saved.along)}-nél hagytad abba (${fmtDist(nav.orig.total - saved.along)} volt hátra).`,
      [["resume", "Folytatom onnan"], ["fresh", "Nem, máshonnan"]]);
    if (!nav) return;
    if (a === "resume") target = saved.along;
  }
  if (target == null) {
    const cands = joinCandidates(p);
    if (!cands.length) {
      const n = nearestOnRoute(p);
      const a = await ask("Messze vagy az útvonaltól", `A legközelebbi pontja ${fmtDist(n.d)}-re van, ${dirWord(bearing(p, nav.orig.g[n.k]))} felé.`,
        [["near", "Vezess a legközelebbi ponthoz"], ["start", "Vezess a rajthoz"], ["none", "Csak mutasd az utat"]]);
      if (!nav) return;
      target = a === "start" ? 0 : n.at;
      approach = a !== "none";
    } else if (cands.length === 1 && cands[0].at < 150) {
      target = cands[0].at;   // a rajtnál vagy – nincs mit kérdezni
    } else {
      // melyik ágon: amelyik irányába épp haladsz, az az első (ha van irány)
      const g = nav.orig.g;
      const fits = (c) => heading != null && Math.abs(((bearing(g[c.k], g[Math.min(c.k + 1, g.length - 1)]) - heading + 540) % 360) - 180) < 60;
      cands.sort((a, b) => Number(fits(b)) - Number(fits(a)) || a.at - b.at);
      const opts = cands.slice(0, 3).map((c) => [String(c.at), `Innen, a ${fmtDist(c.at)}-nél${cands.length > 1 ? ` (${fmtDist(nav.orig.total - c.at)} hátra)` : ""}`]);
      opts.push(["0", nav.orig.total - cands[0].at > 50 && cands[0].at > 150 ? "Az elejéről (vezess a rajthoz)" : "Az elejéről"]);
      const text = cands.length > 1
        ? "Az útvonal itt többször is elhalad. Melyik részénél tartasz?"
        : `Az útvonal ${fmtDist(cands[0].at)}-énél vagy, ${fmtDist(nav.orig.total - cands[0].at)} van hátra.`;
      const a = await ask("Honnan folytatod?", text, opts);
      if (!nav) return;
      target = Number(a);
    }
  }
  await joinAt(p, target, approach);
}

// Rácsatlakozás az eredeti útvonal `target` m-es pontjára; messze esetén bekötő szakasszal
async function joinAt(p, target, approach) {
  const { g, cum, hints } = nav.orig;
  let k = 0;
  while (k < g.length - 2 && cum[k + 1] <= target) k++;
  const t = (target - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]);
  const jp = { lat: g[k].lat + t * (g[k + 1].lat - g[k].lat), lng: g[k].lng + t * (g[k + 1].lng - g[k].lng), ele: g[k + 1].ele };
  if (approach && hav(p, jp) > nav.cfg.off) {
    try {
      const r = await _d.route([p, jp], nav.mode);
      if (!nav) return;
      const ag = r.geometry;
      const shift = ag.length - k - 1;   // az eredeti j. pont (j > k) helye az összefűzöttben
      const combined = [...ag, ...g.slice(k + 1)];
      const h = [...(r.hints || []), { i: ag.length - 1, cmd: "join" },
        ...(hints || []).filter((x) => x.i > k).map((x) => ({ ...x, i: x.i + shift }))];
      load(combined, h);
      nav.approachLen = nav.cum[ag.length - 1];
      nav.joinAt = target;
      _d.mapAdapter.navSetApproach?.(ag);
      speak(`${fmtDist(nav.approachLen)} a bekötés az útvonalra.`, "near", false, ["e:approach"]);
      return;
    } catch { _d.showToast("A bekötő szakaszt nem sikerült megtervezni – a piros vonal mutatja az utat."); }
  }
  // közvetlenül az útvonalon (vagy bekötés nélkül): onnan számol
  nav.idx = k; nav.along = target; nav.approachLen = 0; nav.joinAt = 0;
  if (target > 150) speak(`Folytatás ${fmtDist(target)}-től.`, "near", false, ["e:resume"]);
}

function start() {
  const g = _d.getGeometry();
  if (!g || g.length < 2) { _d.showToast("Előbb tervezz egy útvonalat."); return; }
  if (!navigator.geolocation && !location.search.includes("navsim")) { _d.showToast("A böngésző nem támogatja a helymeghatározást."); return; }
  const mode = _d.store.getState().mode;
  const act = activityOf(mode);
  const rawHints = _d.getHints?.();
  nav = { mode, act, cfg: CFG[act], plannedKmh: _d.getSpeed(mode) || (act === "foot" ? 5 : 20),
          phase: "locating", pos: null, last: null, v: 0, movingSec: 0, startAt: Date.now(), walked: 0,
          off: false, offCount: 0, follow: true, muted: false, arrived: false, watch: null, sim: null, wake: null,
          orig: null, approachLen: 0, joinAt: 0, savedAt: 0 };
  load(g, rawHints);
  // az eredeti útvonal (a haladás mentéséhez, a bekötő szakasz nélkül)
  // (betöltött GPX-nél a vonal töréseiből – a bekötés után is ezek kellenek)
  nav.orig = { g, cum: nav.cum, total: nav.total, hints: rawHints?.length ? rawHints : geometryHints(g, nav.cum), sig: routeSig(g, nav.total) };
  document.body.classList.add("is-navigating");
  $("navTop").hidden = false; $("navBottom").hidden = false;
  $("navFollowBtn").hidden = true;
  $("navSimBtn").hidden = !SIM;
  $("navAsk").hidden = true;
  $("mapNavFabBtn").hidden = true;
  paintVoice();
  _d.mapAdapter.invalidateSize();
  keepAwake().then(() => { if (!nav?.wake) _d.showToast("A képernyő magától elsötétülhet – a telefon beállításaiban növeld a kikapcsolási időt."); });
  // iOS: a hangot felhasználói érintésre kell „feloldani” – ez az első mondat
  audio();
  if (PIPER[voiceChoice()]) loadVoice(voiceChoice().slice(6)).catch(() => {});
  speak(`Navigáció indul. ${fmtDist(nav.total)} az útvonal.`, "near", false, ["e:start"]);
  renderBanner();
  if (navigator.geolocation && !SIM) {
    nav.watch = navigator.geolocation.watchPosition(onFix, (err) => {
      if (err.code === 1) { _d.showToast("A helymeghatározás nincs engedélyezve – a böngésző beállításaiban engedélyezd."); stop(); }
      else _d.showToast("Nincs GPS-jel – keresem…");
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
}

export function stop() {
  if (!nav) return;
  saveProgress(true);
  $("navAsk").hidden = true;
  if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
  clearInterval(nav.sim);
  try { nav.wake?.release(); } catch { /* már elengedve */ }
  try { speechSynthesis.cancel(); } catch { /* nincs hang */ }
  nav = null;
  document.body.classList.remove("is-navigating");
  $("navTop").hidden = true; $("navBottom").hidden = true;
  _d.mapAdapter.navClear();
  _d.mapAdapter.invalidateSize();
  $("mapNavFabBtn").hidden = !navEnabled() || !_d.canStart();
}

const zoomFor = () => (nav.act === "bike" && nav.v > 6 ? nav.cfg.zoom - 1 : nav.cfg.zoom);

// ── Helyzet-frissítés ──
function onFix(pos) {
  if (!nav) return;
  const c = pos.coords;
  const p = { lat: c.latitude, lng: c.longitude };
  const now = pos.timestamp || Date.now();
  // sebesség és irány: a GPS-é, ha van, különben az előző helyből
  let heading = c.heading != null && !Number.isNaN(c.heading) && (c.speed ?? 0) > 0.5 ? c.heading : null;
  let v = c.speed != null && !Number.isNaN(c.speed) ? c.speed : null;
  if (nav.last) {
    const d = hav(nav.last.p, p), dt = (now - nav.last.t) / 1000;
    if (dt > 0 && v == null) v = d / dt;
    if (heading == null && d > 3) heading = bearing(nav.last.p, p);
    if (d < 200) nav.walked += d;
    if ((v ?? 0) > 0.5 && dt < 30) nav.movingSec += dt;
  }
  if (heading == null) heading = nav.heading ?? null;
  nav.heading = heading;
  nav.last = { p, t: now };
  if (v != null) nav.v = nav.v ? 0.75 * nav.v + 0.25 * v : v;
  nav.pos = p;
  _d.mapAdapter.navShow({ ...p, heading, accuracy: c.accuracy || 0 });

  // első jel: honnan indulunk (közben a további jeleket csak megjelenítjük)
  if (nav.phase === "locating") {
    nav.phase = "setup";
    if (nav.follow) _d.mapAdapter.navFollow(p, zoomFor());
    setupStart(p, heading).then(() => { if (!nav) return; nav.phase = "run"; onFix(pos); })
      .catch(() => { if (nav) nav.phase = "run"; });
    return;
  }
  if (nav.phase !== "run") return;

  // ráillesztés: az előző hely környékén (előre jobban), ha messze van, az egész útvonalon
  const { g } = nav;
  const scan = (from, to) => {
    let best = { d: Infinity, k: nav.idx, t: 0 };
    for (let k = Math.max(0, from); k < Math.min(g.length - 1, to); k++) {
      const s = segDist(p, g[k], g[k + 1]);
      if (s.d < best.d) best = { d: s.d, k, t: s.t };
    }
    return best;
  };
  let best = scan(nav.idx - 30, nav.idx + 800);
  if (best.d > nav.cfg.off * 2) { const all = scan(0, g.length - 1); if (all.d < best.d - 20) best = all; }
  const along = nav.cum[best.k] + best.t * (nav.cum[best.k + 1] - nav.cum[best.k]);
  if (best.d <= nav.cfg.off) { nav.idx = best.k; nav.along = Math.max(nav.along - 30, along); }
  const snapped = { lat: g[best.k].lat + best.t * (g[best.k + 1].lat - g[best.k].lat), lng: g[best.k].lng + best.t * (g[best.k + 1].lng - g[best.k].lng) };

  // letérés: két egymás utáni hely a küszöbön túl (és a pontosság elég jó)
  const acc = c.accuracy || 0;
  if (best.d > nav.cfg.off && acc < nav.cfg.off * 1.5) nav.offCount++;
  else if (best.d < nav.cfg.off * 0.6) nav.offCount = 0;
  if (!nav.off && nav.offCount >= 2) { nav.off = true; buzz([250, 120, 250]); speak("Letértél az útvonalról.", "off", false, ["e:off"]); }
  else if (nav.off && nav.offCount === 0) { nav.off = false; buzz(120); speak("Visszatértél az útvonalra.", "back", false, ["e:back"]); }
  nav.offDist = best.d;

  _d.mapAdapter.navShow({ ...p, heading, accuracy: acc });
  _d.mapAdapter.navSetOffLine(nav.off ? p : null, nav.off ? snapped : null);
  _d.mapAdapter.navSetPassed([...g.slice(0, nav.idx + 1), snapped]);
  if (nav.follow) _d.mapAdapter.navFollow(p, zoomFor());

  announce();
  // célba érés: az útvonal végén, rajta
  if (!nav.arrived && nav.total - nav.along < 30 && best.d < nav.cfg.off) arrive();
  saveProgress();
  renderBanner();
}

function announce() {
  if (nav.off || nav.arrived) return;
  const next = nav.hints.find((h) => h.at > nav.along + 5);
  if (!next) return;
  const d = next.at - nav.along, far = nav.cfg.far(nav.v), near = nav.cfg.near(nav.v);
  const after = nav.hints.find((h) => h.at > next.at && h.at - next.at < 60);
  const then = after ? `, majd ${hintText(after)}` : "";
  const thenKey = after ? `m:${hintId(after)}` : null;
  if (next.cmd !== "trail" && next.said < 1 && d <= far && d > near * 1.5) {
    next.said = 1;
    speak(`${fmtDist(d)} múlva ${hintText(next)}${then}.`, "far", false, [distKey(d), `i:${hintId(next)}`, thenKey]);
  } else if (next.said < 2 && d <= near) {
    next.said = 2; buzz(80);
    speak(`${next.cmd === "trail" ? "Innen " : "Most "}${hintText(next)}${then}.`, "near", false, [`n:${hintId(next)}`, thenKey]);
  }
}

function arrive() {
  nav.arrived = true;
  saveProgress(true);   // célba ért útnál a mentett haladás törlődik
  buzz([200, 100, 200, 100, 400]);
  const min = Math.round((Date.now() - nav.startAt) / 60000);
  speak("Megérkeztél.", "end", false, ["e:end"]);
  $("navArrow").innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M5 21V4h9l1 2h5v9h-7l-1-2H7v8z" fill="currentColor"/></svg>';
  $("navDist").textContent = "Megérkeztél";
  $("navText").textContent = `${fmtDist(nav.walked || nav.total)} · ${Math.floor(min / 60)} ó ${min % 60} p`;
  $("navThen").textContent = "";
}

function renderBanner() {
  if (!nav) return;
  const rem = Math.max(0, nav.total - nav.along);
  $("navRemKm").textContent = fmtDist(rem);
  const remAsc = Math.max(0, nav.ascCum[nav.ascCum.length - 1] - nav.ascCum[nav.idx]);
  $("navRemAsc").textContent = `${Math.round(remAsc)} m`;
  $("navSpeed").textContent = nav.v ? num(nav.v * 3.6, 0) : "–";
  // érkezés: az első 2 perc mozgásig a tervezési sebességgel, utána a valós tempóval (+ emelkedő)
  const kmh = nav.movingSec > 120 && nav.v > 0.5 ? Math.max(nav.v * 3.6, nav.plannedKmh * 0.4) : nav.plannedKmh;
  const hours = rem / 1000 / kmh + remAsc / nav.cfg.vam;
  $("navEta").textContent = rem > 0 ? fmtClock(new Date(Date.now() + hours * 3600e3)) : "–";
  if (nav.arrived) return;
  const top = $("navTop");
  top.classList.toggle("is-off", nav.off);
  if (!nav.pos || nav.phase === "locating") { $("navArrow").innerHTML = arrowSvg(0); $("navDist").textContent = "GPS keresése…"; $("navText").textContent = "Maradj szabad ég alatt"; $("navThen").textContent = ""; return; }
  if (nav.off) {
    $("navArrow").innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true"><path d="M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z" fill="currentColor"/></svg>';
    $("navDist").textContent = "Letértél az útról";
    $("navText").textContent = `${fmtDist(nav.offDist)}-re van – a piros szaggatott vonal mutatja`;
    $("navThen").textContent = "";
    return;
  }
  const next = nav.hints.find((h) => h.at > nav.along + 5);
  if (!next) { $("navArrow").innerHTML = arrowSvg(0); $("navDist").textContent = fmtDist(rem); $("navText").textContent = "a célig"; $("navThen").textContent = ""; return; }
  $("navArrow").innerHTML = arrowSvg(hintAngle(next));
  $("navDist").textContent = fmtDist(next.at - nav.along);
  $("navText").textContent = hintText(next);
  const after = nav.hints.find((h) => h.at > next.at);
  $("navThen").textContent = after ? `majd ${fmtDist(after.at - next.at)} múlva ${hintText(after)}` : "";
}

// ── Próba: végigmegy az útvonalon a tervezési sebesség háromszorosával ──
function pointAt(s) {
  let k = nav.cum.findIndex((c) => c >= s);
  if (k < 1) k = 1;
  const a = nav.g[k - 1], b = nav.g[k], t = (s - nav.cum[k - 1]) / Math.max(1e-6, nav.cum[k] - nav.cum[k - 1]);
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng), heading: bearing(a, b) };
}
function toggleSim() {
  if (nav.sim) { clearInterval(nav.sim); nav.sim = null; $("navSimBtn").querySelector("span").textContent = "Próba"; return; }
  $("navSimBtn").querySelector("span").textContent = "Megállít";
  const step = nav.plannedKmh / 3.6 * 3;   // m / mp
  const fix = (p, speed) => onFix({ timestamp: Date.now(), coords: { latitude: p.lat, longitude: p.lng, accuracy: 5, speed, heading: p.heading } });
  if (nav.phase === "locating") {
    // ?navsim=KM:ELTOLÁS – az első hely az útvonal KM-énél, ELTOLÁS m-rel északra
    const [km, offM] = (/[?&]navsim=([\d.]+)(?::(\d+))?/.exec(location.search) || []).slice(1).map(Number);
    const p0 = pointAt(Math.min(nav.total, (km || 0) * 1000));
    fix({ lat: p0.lat + (offM || 0) / 111000, lng: p0.lng, heading: null }, 0);
  }
  nav.sim = setInterval(() => {
    if (nav.phase !== "run") return;
    nav.simS = Math.min(nav.total, (nav.simS ?? nav.along) + step);
    fix(pointAt(nav.simS), step);
    if (nav.simS >= nav.total) toggleSim();
  }, 1000);
}
