/**
 * „Pedálozás” kártya az Elemzésben (wattmérő + kadencia): kadencia–watt pontdiagram
 * négy negyeddel (az FTP-nél / átlagnál és az átlagkadenciánál osztva), és – ha a wattmérő
 * kétoldali és az eredeti FIT-ben benne van – a bal / jobb láb aránya (első és második fél).
 *
 *   initPedaling({ api, parseFit, getGeometry, getRouteId, getLibraryData, getFtp })
 */
import { int } from "../format.js";

let _deps = null, _geomRef = null, _calc = null, _bal = null, _seq = 0;

const QUAD = [
  { k: "hf", label: "Erős, gyors", hint: "nagy watt, magas kadencia – sprint, tempós emelkedő", c: "#EF4444" },
  { k: "hs", label: "Erős, lassú", hint: "nagy watt, alacsony kadencia – nagy áttétel, meredek emelkedő (izomerő)", c: "#F59E0B" },
  { k: "lf", label: "Könnyű, gyors", hint: "kis watt, magas kadencia – könnyed pörgetés", c: "#3B82F6" },
  { k: "ls", label: "Könnyű, lassú", hint: "kis watt, alacsony kadencia – lazítás, gurulás közbeni tekerés", c: "#9CA3AF" },
];

function compute(g) {
  const pts = g.filter((p) => p.power != null && p.cad != null && p.cad > 0 && p.power > 0);
  if (pts.length < 60) return null;
  const cadAvg = pts.reduce((a, p) => a + p.cad, 0) / pts.length;
  const ftp = _deps.getFtp?.();
  const pAvg = pts.reduce((a, p) => a + p.power, 0) / pts.length;
  const pLine = ftp?.w || pAvg;
  const q = { hf: 0, hs: 0, lf: 0, ls: 0 };
  for (const p of pts) q[(p.power >= pLine ? "h" : "l") + (p.cad >= cadAvg ? "f" : "s")]++;
  for (const k in q) q[k] = q[k] / pts.length * 100;
  // a pontdiagramhoz legfeljebb ~1500 pont (egyenletesen)
  const step = Math.max(1, Math.floor(pts.length / 1500));
  const sample = pts.filter((_, i) => i % step === 0).map((p) => [p.cad, p.power]);
  return { cadAvg, pLine, pLineLbl: ftp?.w ? `FTP ${int(ftp.w)} W` : `átlag ${int(pAvg)} W`, q, sample };
}

function drawScatter(canvas, c) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 240, H = 150;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = { l: 30, r: 6, t: 6, b: 18 };
  const cmax = Math.max(120, ...c.sample.map((s) => s[0]));
  const pmax = Math.max(c.pLine * 1.6, ...c.sample.map((s) => s[1])) * 1.02;
  const X = (v) => P.l + (v - 30) / (cmax - 30) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - v / pmax) * (H - P.t - P.b);
  const muted = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#9ca3af";
  ctx.font = "9.5px Inter, system-ui, sans-serif";
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  for (const v of [100, 200, 300, 400, 500, 600, 800, 1000].filter((v) => v < pmax)) ctx.fillText(String(v), P.l - 4, Y(v) + 3);
  ctx.textAlign = "center";
  for (const v of [40, 60, 80, 100, 120].filter((v) => v <= cmax)) ctx.fillText(String(v), X(v), H - 5);
  for (const [cad, pw] of c.sample) {
    if (cad < 30) continue;
    const quad = QUAD.find((q) => q.k === (pw >= c.pLine ? "h" : "l") + (cad >= c.cadAvg ? "f" : "s"));
    ctx.fillStyle = quad.c + "55";
    ctx.fillRect(X(cad) - 1, Y(pw) - 1, 2, 2);
  }
  ctx.strokeStyle = muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(c.cadAvg), P.t); ctx.lineTo(X(c.cadAvg), H - P.b); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(P.l, Y(c.pLine)); ctx.lineTo(W - P.r, Y(c.pLine)); ctx.stroke();
  ctx.setLineDash([]);
}

function render() {
  const box = document.getElementById("fFilePedal");
  if (!box) return;
  const c = _calc;
  if (!c) { box.hidden = true; box.innerHTML = ""; return; }
  const quads = QUAD.map((q) => `<div class="pd-q" title="${q.label}: ${q.hint}"><i style="background:${q.c}"></i><b>${int(c.q[q.k])}%</b><span>${q.label}</span></div>`).join("");
  let bal = "";
  if (_bal) {
    const L = 100 - _bal.right, L1 = 100 - _bal.r1, L2 = 100 - _bal.r2;
    bal = `<div class="be-sec-t pd-bal-t">Bal / jobb láb</div>
      <div class="pd-bal"><span class="pd-l" style="flex:${L}">B ${int(L)}%</span><span class="pd-r" style="flex:${_bal.right}">J ${int(_bal.right)}%</span></div>
      <div class="pd-note">Első fél: ${int(L1)} / ${int(_bal.r1)} · második fél: ${int(L2)} / ${int(_bal.r2)}${Math.abs(L2 - L1) >= 2 ? " – fáradással nőhet az eltérés" : ""}</div>`;
  }
  box.innerHTML = `<div class="be-head"><span>Pedálozás</span>
      <span class="clb-hint" title="Minden mért pont a kadencia (vízszintes) és a teljesítmény (függőleges) szerint. A szaggatott vonalak: az átlagkadencia (${int(c.cadAvg)} rpm) és ${c.pLineLbl}. A négy negyed megmutatja, hogyan dolgoztál: erőből (nagy áttétel, alacsony kadencia) vagy pörgetésből. A bal / jobb arány csak kétoldali wattmérőnél, az eredeti FIT-fájlból látszik.">?</span></div>
    <canvas class="pd-canvas"></canvas>
    <div class="pd-axis"><span>kadencia (rpm) →</span><span>↑ W</span></div>
    <div class="pd-quads">${quads}</div>${bal}`;
  box.hidden = false;
  requestAnimationFrame(() => { const cv = box.querySelector(".pd-canvas"); if (cv) drawScatter(cv, c); });
}

async function refresh() {
  const g = _deps.getGeometry();
  if (g === _geomRef) return;
  _geomRef = g; _bal = null;
  const mySeq = ++_seq;
  const full = g?.full || g;
  _calc = full?.length ? compute(full) : null;
  render();
  if (!_calc) return;
  const id = _deps.getRouteId?.();
  const lib = _deps.getLibraryData?.() || {};
  const entry = id ? [...(lib.workouts || []), ...(lib.routes || [])].find((r) => r.id === id) : null;
  if (!entry?.has_fit) return;
  try {
    const fit = _deps.parseFit(await (await _deps.api.loadRouteFit(id)).arrayBuffer());
    if (mySeq !== _seq) return;
    const rs = fit.records.filter((r) => r && r.rightPct != null && r.power > 0);
    if (rs.length < 60) return;
    const avg = (a) => a.reduce((s, r) => s + r.rightPct, 0) / a.length;
    const h = Math.floor(rs.length / 2);
    _bal = { right: avg(rs), r1: avg(rs.slice(0, h)), r2: avg(rs.slice(h)) };
    render();
  } catch (err) {
    console.warn("Pedálegyensúly (FIT):", err);
  }
}

export function initPedaling(deps) {
  _deps = deps;
  document.addEventListener("bringaterv:geometry", () => setTimeout(refresh, 0));
  window.addEventListener("resize", () => { const cv = document.querySelector("#fFilePedal .pd-canvas"); if (cv && _calc) drawScatter(cv, _calc); });
  refresh();
}
