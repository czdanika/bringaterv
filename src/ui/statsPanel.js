/**
 * Bringaterv – Stats Dashboard
 * ==============================
 * Edzés-statisztikák renderelése a meglévő library adatokból.
 * Nincs backend-változás – minden számítás frontenden történik.
 */

import { estimateKcal } from '../calories.js';
import { getCyclistProfile } from './settings.js';

const MONTHS_HU = ['Jan','Feb','Már','Ápr','Máj','Jún','Júl','Aug','Sze','Okt','Nov','Dec'];
const MONTHS_LONG = ['január','február','március','április','május','június','július','augusztus','szeptember','október','november','december'];

const SPORT_LABELS = {
  cycling: 'Kerékpáros túrák', run: 'Futások', hike: 'Túrák', walk: 'Séták', other: 'Egyéb',
};
const SPORT_COLORS = {
  cycling: '#3B82F6', run: '#22C55E', hike: '#A855F7', walk: '#F59E0B', other: '#6B7280',
};

// ── Segédfüggvények ───────────────────────────────────────────────────────────

function sportKey(r) {
  const t = (r.sport_type || r.type || '').toLowerCase();
  if (!t || t === 'route' || t === 'workout') return 'cycling';
  if (t.includes('cycl') || t.includes('ride') || t.includes('bike')
      || t === 'asphalt' || t === 'gravel' || t === 'mtb') return 'cycling';
  if (t.includes('hik')) return 'hike';
  if (t.includes('walk')) return 'walk';
  if (t.includes('run')) return 'run';
  return 'other';
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtKm(km) {
  if (km >= 1000) return (km / 1000).toFixed(1).replace('.', ',') + ' e km';
  return Math.round(km).toLocaleString('hu-HU') + ' km';
}

function fmtMin(min) {
  if (!min || min < 1) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}p`;
  if (m === 0) return `${h}ó`;
  return `${h}ó ${m}p`;
}

/** Hosszú forma: "2 nap 4 óra 37 perc" / "17 óra 56 perc" / "53 perc" */
function fmtMinVerbose(min) {
  if (!min || min < 1) return '—';
  const totalMin = Math.round(min);
  const days = Math.floor(totalMin / 1440);
  const h    = Math.floor((totalMin % 1440) / 60);
  const m    = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} nap`);
  if (h > 0)    parts.push(`${h} óra`);
  if (m > 0 || parts.length === 0) parts.push(`${m} perc`);
  return parts.join(' ');
}

function calcKcalForRoutes(routes) {
  const profile = getCyclistProfile();
  return routes.reduce((sum, r) => {
    if (!r.distance || !r.duration) return sum;
    const { kcal } = estimateKcal(r.distance, r.duration / 60, r.elevation || 0, profile);
    return sum + kcal;
  }, 0);
}

function calcEddingtonMonth(routes) {
  const byDay = {};
  routes.forEach(r => {
    if (!r.date || !r.distance || r.distance < 0.5) return;
    const day = r.date.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + r.distance;
  });
  const dayDists = Object.values(byDay).sort((a, b) => b - a);
  let E = 0;
  for (let i = 0; i < dayDists.length; i++) {
    if (Math.floor(dayDists[i]) >= i + 1) E = i + 1;
    else break;
  }
  return E;
}

function fmtElev(m) {
  if (!m || m < 1) return '—';
  return Math.round(m).toLocaleString('hu-HU') + ' m';
}

// ── Havi időszakok ────────────────────────────────────────────────────────────

function getMonthPeriods(routes, period) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();

  if (period === 'year') {
    return Array.from({ length: curM + 1 }, (_, m) => ({
      year: curY, month: m, label: MONTHS_HU[m], highlight: m === curM,
    }));
  }

  if (period === '12m') {
    return Array.from({ length: 12 }, (_, i) => {
      let m = curM - (11 - i);
      let y = curY;
      while (m < 0) { m += 12; y--; }
      return { year: y, month: m, label: MONTHS_HU[m], highlight: m === curM && y === curY };
    });
  }

  // 'all' – egyedi év-hónapok az adatokból, max 24
  const seen = new Map();
  routes.forEach(r => {
    if (!r.date) return;
    const d = new Date(r.date);
    if (isNaN(d)) return;
    const k = `${d.getFullYear()}-${d.getMonth()}`;
    if (!seen.has(k)) seen.set(k, { year: d.getFullYear(), month: d.getMonth() });
  });
  const sorted = [...seen.values()].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
  const slice = sorted.slice(-24);
  const multiYear = slice.length > 1 && slice[0].year !== slice[slice.length - 1].year;
  return slice.map(({ year, month }) => ({
    year, month,
    label: multiYear ? `${MONTHS_HU[month]}'${String(year).slice(2)}` : MONTHS_HU[month],
    highlight: year === curY && month === curM,
  }));
}

// ── Canvas oszlopdiagram ──────────────────────────────────────────────────────

function roundFill(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawBarChart(canvas, bars, { unit = '', color = '#fc4c02', height = 180 } = {}) {
  const DPR = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth || 400;
  const H   = height;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const nonZero = bars.filter(b => b.value > 0);
  if (!nonZero.length) {
    ctx.fillStyle = cssVar('--text-muted') || '#999';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Nincs adat', W / 2, H / 2);
    return;
  }

  const PAD = { top: 14, right: 6, bottom: 28, left: 42 };
  const iW = W - PAD.left - PAD.right;
  const iH = H - PAD.top - PAD.bottom;
  const maxVal = Math.max(...bars.map(b => b.value));
  const n = bars.length;
  const gap  = Math.max(2, Math.floor(iW / n * 0.2));
  const barW = Math.max(4, (iW - gap * (n - 1)) / n);

  const textColor   = cssVar('--text-muted') || '#888';
  const borderColor = cssVar('--border')     || 'rgba(128,128,128,0.15)';

  // Y gridlines + labels (0, 50%, 100% of max)
  [0, 0.5, 1].forEach(frac => {
    const yLine = PAD.top + iH * (1 - frac);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, yLine);
    ctx.lineTo(W - PAD.right, yLine);
    ctx.stroke();
    if (frac > 0) {
      const val = maxVal * frac;
      const label = val >= 1000 ? (val / 1000).toFixed(1) + 'e' : Math.round(val) + unit;
      ctx.fillStyle    = textColor;
      ctx.font         = '9px system-ui, sans-serif';
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, PAD.left - 4, yLine);
    }
  });

  // Bars + X labels
  bars.forEach((bar, i) => {
    const x = PAD.left + i * (barW + gap);
    const bH = bar.value > 0 ? Math.max(2, (bar.value / maxVal) * iH) : 0;
    const y  = PAD.top + iH - bH;

    if (bH > 0) {
      ctx.fillStyle = bar.highlight ? color : color + '70';
      roundFill(ctx, x, y, barW, bH, Math.min(3, barW / 2));
    }

    const fontSize = Math.max(7, Math.min(10, Math.floor(barW * 0.85)));
    ctx.fillStyle    = bar.highlight ? (cssVar('--text') || '#fff') : textColor;
    ctx.font         = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(bar.label, x + barW / 2, H - PAD.bottom + 5);
  });
}

// ── Fő render ─────────────────────────────────────────────────────────────────

export function renderStats(allRoutes, { period = 'year', sport = 'all' } = {}) {
  const now  = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();

  // Dátum-szűrő határ
  let cutoff = null;
  if (period === 'year') cutoff = new Date(curY, 0, 1);
  else if (period === '12m') { cutoff = new Date(curY, curM - 11, 1); }

  // Szűrés
  const routes = allRoutes.filter(r => {
    if (!r.date) return false;
    const d = new Date(r.date);
    if (isNaN(d)) return false;
    if (cutoff && d < cutoff) return false;
    if (sport !== 'all' && sportKey(r) !== sport) return false;
    return true;
  });

  // ── KPI kártyák ──
  const totalKm   = routes.reduce((s, r) => s + (r.distance  || 0), 0);
  const totalDur  = routes.reduce((s, r) => s + (r.duration  || 0), 0);
  const totalElev = routes.reduce((s, r) => s + (r.elevation || 0), 0);
  const count     = routes.length;

  const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  setEl('statsKpiKm',    totalKm > 0   ? fmtKm(totalKm)   : '—');
  setEl('statsKpiTime',  totalDur > 0  ? fmtMin(totalDur)  : '—');
  setEl('statsKpiElev',  totalElev > 0 ? fmtElev(totalElev): '—');
  setEl('statsKpiCount', count);

  // ── Havi diagramok ──
  const periods = getMonthPeriods(routes, period);

  const monthlyData = periods.map(({ year, month, label, highlight }) => {
    const monthRoutes = routes.filter(r => {
      const d = new Date(r.date);
      return d.getFullYear() === year && d.getMonth() === month;
    });
    return {
      label, highlight,
      km:   monthRoutes.reduce((s, r) => s + (r.distance  || 0), 0),
      elev: monthRoutes.reduce((s, r) => s + (r.elevation || 0), 0),
    };
  });

  const kmCanvas   = document.getElementById('statsKmChart');
  const elevCanvas = document.getElementById('statsElevChart');
  if (kmCanvas)   drawBarChart(kmCanvas,   monthlyData.map(b => ({ label: b.label, value: Math.round(b.km * 10) / 10, highlight: b.highlight })),   { unit: 'km' });
  if (elevCanvas) drawBarChart(elevCanvas, monthlyData.map(b => ({ label: b.label, value: Math.round(b.elev),         highlight: b.highlight })), { unit: 'm'  });

  // ── Sporttípus bontás ──
  const sportBd = document.getElementById('statsSportBreakdown');
  if (sportBd) {
    const bySport = {};
    routes.forEach(r => {
      const s = sportKey(r);
      bySport[s] = (bySport[s] || 0) + (r.distance || 0);
    });
    const totalSport = Object.values(bySport).reduce((a, b) => a + b, 0) || 1;
    const entries = Object.entries(bySport).sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      sportBd.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Nincs adat</div>';
    } else {
      sportBd.innerHTML = entries.map(([sp, km]) => {
        const pct   = Math.round(km / totalSport * 100);
        const color = SPORT_COLORS[sp] || '#6B7280';
        return `<div class="stats-sport-row">
          <div class="stats-sport-name">${SPORT_LABELS[sp] || sp}</div>
          <div class="stats-sport-bar-wrap"><div class="stats-sport-bar" style="width:${pct}%;background:${color}"></div></div>
          <div class="stats-sport-val">${Math.round(km)} km <span style="opacity:.55">${pct}%</span></div>
        </div>`;
      }).join('');
    }
  }

  // ── Személyes rekordok (teljes adatbázisból, nem csak szűrt) ──
  const recordsEl = document.getElementById('statsRecords');
  if (recordsEl) {
    const base = allRoutes.filter(r => r.date);
    const withDist  = base.filter(r => (r.distance  || 0) > 0);
    const withElev  = base.filter(r => (r.elevation || 0) > 0);
    const withDur   = base.filter(r => (r.duration  || 0) > 0);
    // Sebesség-rekordhoz: min 5 perc időtartam (kizárja a hibás GPS adatokat)
    // és max 120 km/h (fizikailag ésszerű felső határ)
    const withSpeed = base.filter(r => {
      const d = r.distance || 0, t = r.duration || 0;
      if (d <= 0 || t < 5) return false;
      return (d / (t / 60)) <= 120;
    });

    const bestDist  = withDist.length  ? withDist.reduce((a, b)  => b.distance > a.distance   ? b : a) : null;
    const bestElev  = withElev.length  ? withElev.reduce((a, b)  => b.elevation > a.elevation  ? b : a) : null;
    const bestDur   = withDur.length   ? withDur.reduce((a, b)   => b.duration > a.duration   ? b : a) : null;
    const bestSpeed = withSpeed.length ? withSpeed.reduce((a, b) => {
      return (b.distance / b.duration) > (a.distance / a.duration) ? b : a;
    }) : null;

    const records = [
      { label: 'Leghosszabb táv',       val: bestDist  ? `${bestDist.distance.toFixed(1)} km`                                 : '—', route: bestDist },
      { label: 'Legtöbb szint',          val: bestElev  ? `${Math.round(bestElev.elevation).toLocaleString('hu-HU')} m`        : '—', route: bestElev },
      { label: 'Leghosszabb edzés',      val: bestDur   ? fmtMin(bestDur.duration)                                             : '—', route: bestDur  },
      { label: 'Legjobb átlagsebesség',  val: bestSpeed ? `${(bestSpeed.distance / (bestSpeed.duration / 60)).toFixed(1)} km/h`: '—', route: bestSpeed },
    ];

    recordsEl.innerHTML = records.map(r => {
      const hasRoute = r.route?.id;
      return `
      <div class="stats-record-card ${hasRoute ? 'stats-record-clickable' : ''}"
           ${hasRoute ? `data-record-route-id="${r.route.id}" data-record-route-name="${(r.route.name || '').replace(/"/g, '&quot;')}"` : ''}>
        <div class="stats-record-body">
          <div class="stats-record-val">${r.val}</div>
          <div class="stats-record-label">${r.label}</div>
          ${r.route?.name ? `<div class="stats-record-sub" title="${r.route.name}">${r.route.name}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
}

// ── Havi statisztikák táblázat ────────────────────────────────────────────────
export function renderMonthlyTable(allRoutes, { sport = 'all' } = {}) {
  const tbody = document.getElementById('statsMonthlyBody');
  if (!tbody) return;

  const routes = allRoutes.filter(r => {
    if (!r.date) return false;
    if (sport !== 'all' && sportKey(r) !== sport) return false;
    return true;
  });

  // Csoportosítás év-hónap szerint
  const monthMap = new Map();
  routes.forEach(r => {
    const d = new Date(r.date);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthMap.has(key)) monthMap.set(key, { year: d.getFullYear(), month: d.getMonth(), routes: [] });
    monthMap.get(key).routes.push(r);
  });

  const sorted = [...monthMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const now = new Date();

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="stats-monthly-empty">Nincs adat</td></tr>';
    return;
  }

  // Összesítők a lábléchez
  const totKm   = routes.reduce((s, r) => s + (r.distance  || 0), 0);
  const totElev = routes.reduce((s, r) => s + (r.elevation || 0), 0);
  const totDur  = routes.reduce((s, r) => s + (r.duration  || 0), 0);
  const totKcal = calcKcalForRoutes(routes);

  const rows = [];
  for (const [key, { year, month, routes: mrs }] of sorted) {
    const isCur  = year === now.getFullYear() && month === now.getMonth();
    const label  = `${year}. ${MONTHS_LONG[month]}`;
    const km     = mrs.reduce((s, r) => s + (r.distance  || 0), 0);
    const elev   = mrs.reduce((s, r) => s + (r.elevation || 0), 0);
    const dur    = mrs.reduce((s, r) => s + (r.duration  || 0), 0);
    const kcal   = calcKcalForRoutes(mrs);
    const edd    = calcEddingtonMonth(mrs);

    // Fősor – chevron a hónap cellán belül (7 oszlop)
    rows.push(`<tr class="stats-monthly-row" data-month-key="${key}" role="button" tabindex="0" aria-expanded="false">
      <td class="stats-monthly-month ${isCur ? 'stats-monthly-cur' : ''}"><span class="stats-monthly-chevron">›</span> ${label}</td>
      <td class="num"><strong>${mrs.length}</strong></td>
      <td class="num">${km   > 0 ? Math.round(km) + ' km'  : '—'}</td>
      <td class="num">${elev > 0 ? Math.round(elev).toLocaleString('hu-HU') + ' m' : '—'}</td>
      <td class="num">${dur  > 0 ? fmtMinVerbose(dur) : '—'}</td>
      <td class="num">${kcal > 0 ? Math.round(kcal).toLocaleString('hu-HU') + ' kcal' : '—'}</td>
      <td class="num">${edd}</td>
    </tr>`);

    // Sport-bontás sorok (alapból rejtve)
    const bySport = new Map();
    mrs.forEach(r => {
      const sk = sportKey(r);
      if (!bySport.has(sk)) bySport.set(sk, []);
      bySport.get(sk).push(r);
    });
    // Sorrendben: cycling, run, hike, walk, other
    for (const sk of ['cycling', 'run', 'hike', 'walk', 'other']) {
      const group = bySport.get(sk);
      if (!group?.length) continue;
      const gKm   = group.reduce((s, r) => s + (r.distance  || 0), 0);
      const gElev = group.reduce((s, r) => s + (r.elevation || 0), 0);
      const gDur  = group.reduce((s, r) => s + (r.duration  || 0), 0);
      const gKcal = calcKcalForRoutes(group);
      rows.push(`<tr class="stats-monthly-sub" data-month-parent="${key}" hidden>
        <td class="stats-monthly-sub-label">${SPORT_LABELS[sk] || sk}</td>
        <td class="num">${group.length}</td>
        <td class="num">${gKm   > 0 ? Math.round(gKm) + ' km'  : '—'}</td>
        <td class="num">${gElev > 0 ? Math.round(gElev).toLocaleString('hu-HU') + ' m' : '—'}</td>
        <td class="num">${gDur  > 0 ? fmtMinVerbose(gDur) : '—'}</td>
        <td class="num">${gKcal > 0 ? Math.round(gKcal).toLocaleString('hu-HU') + ' kcal' : '—'}</td>
        <td></td>
      </tr>`);
    }
  }

  tbody.innerHTML = rows.join('');

  // Expand / collapse kattintás
  tbody.addEventListener('click', (e) => {
    const row = e.target.closest('.stats-monthly-row');
    if (!row) return;
    const key = row.dataset.monthKey;
    const expanded = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', String(!expanded));
    row.querySelector('.stats-monthly-chevron').textContent = expanded ? '›' : '⌄';
    tbody.querySelectorAll(`[data-month-parent="${key}"]`).forEach(sub => {
      sub.hidden = expanded;
    });
  });

  // Lábléc
  const tfoot = tbody.closest('table')?.tFoot;
  if (tfoot) {
    tfoot.innerHTML = `<tr class="stats-monthly-total">
      <td><strong>Összesen</strong></td>
      <td class="num"><strong>${routes.length}</strong></td>
      <td class="num"><strong>${totKm   > 0 ? Math.round(totKm) + ' km' : '—'}</strong></td>
      <td class="num"><strong>${totElev > 0 ? Math.round(totElev).toLocaleString('hu-HU') + ' m' : '—'}</strong></td>
      <td class="num"><strong>${totDur  > 0 ? fmtMinVerbose(totDur) : '—'}</strong></td>
      <td class="num"><strong>${totKcal > 0 ? Math.round(totKcal).toLocaleString('hu-HU') + ' kcal' : '—'}</strong></td>
      <td></td>
    </tr>`;
  }
}

// ── Teljes személyes rekordok nézet ──────────────────────────────────────────
export function renderRecordsFull(allRoutes) {
  const el = document.getElementById('statsRecordsFull');
  if (!el) return;

  const base      = allRoutes.filter(r => r.date);
  const withDist  = base.filter(r => (r.distance  || 0) > 0);
  const withElev  = base.filter(r => (r.elevation || 0) > 0);
  const withDur   = base.filter(r => (r.duration  || 0) > 0);
  const withSpeed = base.filter(r => {
    const d = r.distance || 0, t = r.duration || 0;
    if (d <= 0 || t < 5) return false;
    return (d / (t / 60)) <= 120;
  });

  const bestDist  = withDist.length  ? withDist.reduce((a, b)  => b.distance > a.distance   ? b : a) : null;
  const bestElev  = withElev.length  ? withElev.reduce((a, b)  => b.elevation > a.elevation  ? b : a) : null;
  const bestDur   = withDur.length   ? withDur.reduce((a, b)   => b.duration > a.duration   ? b : a) : null;
  const bestSpeed = withSpeed.length ? withSpeed.reduce((a, b) =>
    (b.distance / b.duration) > (a.distance / a.duration) ? b : a) : null;

  const fmtDate = r => r?.date ? new Date(r.date).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  const records = [
    { label: 'Leghosszabb táv',       val: bestDist  ? `${bestDist.distance.toFixed(1)} km`                                   : '—', route: bestDist,  date: fmtDate(bestDist) },
    { label: 'Legtöbb szint',          val: bestElev  ? `${Math.round(bestElev.elevation).toLocaleString('hu-HU')} m`          : '—', route: bestElev,  date: fmtDate(bestElev) },
    { label: 'Leghosszabb edzés',      val: bestDur   ? fmtMin(bestDur.duration)                                               : '—', route: bestDur,   date: fmtDate(bestDur) },
    { label: 'Legjobb átlagsebesség',  val: bestSpeed ? `${(bestSpeed.distance / (bestSpeed.duration / 60)).toFixed(1)} km/h`  : '—', route: bestSpeed, date: fmtDate(bestSpeed) },
  ];

  el.innerHTML = records.map(r => {
    const hasRoute = r.route?.id;
    return `
    <div class="stats-record-full-card ${hasRoute ? 'stats-record-clickable' : ''}"
         ${hasRoute ? `data-record-route-id="${r.route.id}" data-record-route-name="${(r.route.name || '').replace(/"/g, '&quot;')}"` : ''}>
      <div class="stats-record-full-val">${r.val}</div>
      <div class="stats-record-full-label">${r.label}</div>
      ${r.route?.name ? `<div class="stats-record-full-name" title="${r.route.name}">${r.route.name}</div>` : ''}
      ${r.date ? `<div class="stats-record-full-date">${r.date}</div>` : ''}
      ${hasRoute ? `<div class="stats-record-open-hint">Megnyitás elemzéshez →</div>` : ''}
    </div>`;
  }).join('');
}

// ── Eddington-szám ────────────────────────────────────────────────────────────

function calcEddington(routes) {
  // Napok szerinti összesítés (több edzés = összeadódik)
  const byDay = {};
  routes.forEach(r => {
    if (!r.date || !r.distance || r.distance < 0.5) return;
    const day = r.date.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + r.distance;
  });
  const dayDists = Object.values(byDay).sort((a, b) => b - a);

  // E = legnagyobb N ahol >= N nap van >= N km-rel
  let E = 0;
  for (let i = 0; i < dayDists.length; i++) {
    if (Math.floor(dayDists[i]) >= i + 1) E = i + 1;
    else break;
  }

  const next        = E + 1;
  const daysAtNext  = dayDists.filter(d => d >= next).length;
  const daysNeeded  = next - daysAtNext;
  const maxDist     = Math.min(Math.ceil(Math.max(...dayDists, 0)), 250);

  // Histogram: hány nap volt >= N km (minden N-re)
  const histogram = [];
  for (let km = 1; km <= maxDist; km++) {
    histogram.push({ km, days: dayDists.filter(d => d >= km).length });
  }

  return { E, next, daysAtNext, daysNeeded, histogram, totalDays: dayDists.length };
}

export function renderEddington(allRoutes) {
  const el = document.getElementById('statsViewEddington');
  if (!el) return;

  // Sport-csoportok meghatározása (csak amik léteznek)
  const sportGroups = [{ key: 'all', label: 'Összes', routes: allRoutes }];
  for (const sk of ['cycling', 'run', 'hike', 'walk', 'other']) {
    const gr = allRoutes.filter(r => sportKey(r) === sk);
    if (gr.length > 0) {
      sportGroups.push({ key: sk, label: SPORT_LABELS[sk] || sk, routes: gr });
    }
  }

  // Eddington per sport előszámítás
  const eddByKey = {};
  sportGroups.forEach(g => { eddByKey[g.key] = calcEddington(g.routes); });

  // Chipek renderelése
  const chipsEl = el.querySelector('#eddSportChips') || el.querySelector('.edd-sport-chips');
  if (chipsEl) {
    chipsEl.innerHTML = sportGroups.map(g => {
      const E = eddByKey[g.key].E;
      return `<button class="edd-sport-chip${g.key === 'all' ? ' is-active' : ''}" data-sport="${g.key}">
        ${g.label} <span class="edd-chip-val">${E || 0}</span>
      </button>`;
    }).join('');
    chipsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.edd-sport-chip');
      if (!btn) return;
      chipsEl.querySelectorAll('.edd-sport-chip').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      _renderEddingtonDetail(el, eddByKey[btn.dataset.sport]);
    });
  }

  // Alapértelmezett: összes
  _renderEddingtonDetail(el, eddByKey['all']);
}

function _renderEddingtonDetail(el, { E, next, daysAtNext, daysNeeded, histogram }) {
  const pct = next > 0 ? Math.round((daysAtNext / next) * 100) : 0;

  el.querySelector('.edd-number').textContent = E || '—';
  el.querySelector('.edd-explain').textContent = E
    ? `Legalább ${E} km-t teljesítettél ${E} különböző napon.`
    : 'Még nincs elegendő adat.';

  const prog = el.querySelector('.edd-progress-wrap');
  if (prog) {
    prog.innerHTML = `
      <div class="edd-next-label">Következő szint: <strong>E = ${next}</strong></div>
      <div class="edd-progress-bar-wrap">
        <div class="edd-progress-bar" style="width:${pct}%"></div>
      </div>
      <div class="edd-next-sub">${daysAtNext}/${next} nap — még <strong>${daysNeeded}</strong> nap hiányzik ${next}+ km-rel</div>`;
  }

  const canvas = el.querySelector('.edd-chart');
  if (canvas && histogram.length) {
    drawEddingtonChart(canvas, histogram, E);
  }
}

function drawEddingtonChart(canvas, histogram, E) {
  const DPR = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth || 600;
  const H   = 220;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const PAD = { top: 14, right: 20, bottom: 32, left: 48 };
  const iW  = W - PAD.left - PAD.right;
  const iH  = H - PAD.top  - PAD.bottom;

  const maxKm   = histogram[histogram.length - 1].km;
  const maxDays = histogram[0].days;

  const toX = km   => PAD.left + ((km - 1) / Math.max(maxKm - 1, 1)) * iW;
  const toY = days => PAD.top  + iH - (days / maxDays) * iH;

  const textColor   = cssVar('--text-muted') || '#888';
  const borderColor = cssVar('--border')     || 'rgba(128,128,128,.15)';
  const brandColor  = '#fc4c02';

  // Grid
  [0, 0.5, 1].forEach(f => {
    const y = PAD.top + iH * (1 - f);
    ctx.strokeStyle = borderColor; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    if (f > 0) {
      ctx.fillStyle = textColor; ctx.font = '9px system-ui,sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.round(maxDays * f), PAD.left - 4, y);
    }
  });

  // Y=X diagonal (szaggatott)
  const diagMax = Math.min(maxKm, maxDays);
  ctx.strokeStyle = textColor + '60'; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(toX(1), toY(1));
  ctx.lineTo(toX(diagMax), toY(diagMax));
  ctx.stroke();
  ctx.setLineDash([]);

  // Bars
  const barW = Math.max(1, iW / maxKm * 0.8);
  histogram.forEach(({ km, days }) => {
    const x  = toX(km) - barW / 2;
    const bH = Math.max(1, (days / maxDays) * iH);
    const y  = PAD.top + iH - bH;
    ctx.fillStyle = km <= E ? brandColor : brandColor + '44';
    ctx.fillRect(x, y, barW, bH);
  });

  // E marker
  if (E > 0 && E <= maxKm) {
    const xE = toX(E);
    ctx.strokeStyle = brandColor; ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(xE, PAD.top); ctx.lineTo(xE, PAD.top + iH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = brandColor; ctx.font = 'bold 10px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(`E=${E}`, xE, PAD.top - 2);
  }

  // X axis labels
  const step = Math.max(1, Math.round(maxKm / 8));
  ctx.fillStyle = textColor; ctx.font = '9px system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let km = step; km <= maxKm; km += step) {
    ctx.fillText(km + 'km', toX(km), H - PAD.bottom + 5);
  }
}

// ── Edzésterhelés (CTL / ATL / TSB) ──────────────────────────────────────────

function calcTrainingLoad(routes) {
  const a7  = 1 - Math.exp(-1 / 7);   // ATL alpha
  const a42 = 1 - Math.exp(-1 / 42);  // CTL alpha

  // Napi terhelés: percek összege (+ szintemelkedés bónusz)
  const dayLoad = {};
  routes.forEach(r => {
    if (!r.date) return;
    const day = r.date.slice(0, 10);
    const load = (r.duration || 0) + (r.elevation || 0) / 20;
    dayLoad[day] = (dayLoad[day] || 0) + load;
  });

  const dates = Object.keys(dayLoad).sort();
  if (!dates.length) return [];

  const start = new Date(dates[0]);
  const end   = new Date();
  const result = [];
  let atl = 0, ctl = 0;

  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key  = d.toISOString().slice(0, 10);
    const load = dayLoad[key] || 0;
    atl = load * a7  + atl * (1 - a7);
    ctl = load * a42 + ctl * (1 - a42);
    result.push({ date: key, load, atl: Math.round(atl * 10) / 10, ctl: Math.round(ctl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10 });
  }
  return result;
}

function drawLineChart(canvas, series, { height = 220 } = {}) {
  const DPR = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth || 600;
  const H   = height;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const allData = series.flatMap(s => s.data);
  if (!allData.length) return;

  const PAD = { top: 16, right: 16, bottom: 32, left: 48 };
  const iW  = W - PAD.left - PAD.right;
  const iH  = H - PAD.top  - PAD.bottom;
  const n   = series[0].data.length;

  const allVals  = allData.map(d => d.v);
  const dataMin  = Math.min(...allVals);
  const dataMax  = Math.max(...allVals);
  const yRange   = dataMax - dataMin || 1;

  const toX = i => PAD.left + (i / Math.max(n - 1, 1)) * iW;
  const toY = v => PAD.top  + iH - ((v - dataMin) / yRange) * iH;

  const textColor   = cssVar('--text-muted') || '#888';
  const borderColor = cssVar('--border')     || 'rgba(128,128,128,.15)';

  // Grid
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = PAD.top + iH * (1 - f);
    ctx.strokeStyle = borderColor; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    const val = dataMin + yRange * f;
    ctx.fillStyle = textColor; ctx.font = '9px system-ui,sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(val), PAD.left - 4, y);
  });

  // Nulla vonal (TSB-hez)
  if (dataMin < 0 && dataMax > 0) {
    ctx.strokeStyle = textColor + '50'; ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    const y0 = toY(0);
    ctx.beginPath(); ctx.moveTo(PAD.left, y0); ctx.lineTo(W - PAD.right, y0); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Vonalak
  series.forEach(({ data, color, fill }) => {
    if (!data.length) return;
    if (fill) {
      const y0 = Math.min(toY(0), PAD.top + iH);
      ctx.fillStyle = color + '18';
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(data[0].v));
      data.forEach((d, i) => ctx.lineTo(toX(i), toY(d.v)));
      ctx.lineTo(toX(data.length - 1), y0);
      ctx.lineTo(toX(0), y0);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    data.forEach((d, i) => { const x = toX(i), y = toY(d.v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
  });

  // X tengelycímkék (~6 darab)
  const labelStep = Math.max(1, Math.floor(n / 6));
  ctx.fillStyle = textColor; ctx.font = '9px system-ui,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i < n; i += labelStep) {
    const date = series[0].data[i]?.date || '';
    const lbl  = date.length >= 7 ? date.slice(5, 10).replace('-', '.') : date;
    ctx.fillText(lbl, toX(i), H - PAD.bottom + 5);
  }
}

export function renderTrainingLoad(routes, { months = 6 } = {}) {
  const el = document.getElementById('statsViewTraining');
  if (!el) return;

  const timeSeries = calcTrainingLoad(routes);
  if (!timeSeries.length) {
    el.querySelector('.training-charts').innerHTML = '<div class="stats-empty">Nincs elegendő adat az edzésterhelés számításához.</div>';
    return;
  }

  // Aktuális értékek (utolsó nap)
  const last = timeSeries[timeSeries.length - 1];
  const setV = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  setV('trainingCTL', Math.round(last.ctl));
  setV('trainingATL', Math.round(last.atl));
  setV('trainingTSB', (last.tsb > 0 ? '+' : '') + Math.round(last.tsb));

  // Forma zóna
  const formEl     = document.getElementById('trainingForm');
  const formDescEl = document.getElementById('trainingFormDesc');
  if (formEl) {
    const tsb = last.tsb;
    const { label, cls, desc } = tsb > 10
      ? { label: 'Friss',      cls: 'form--fresh',    desc: 'Kipihent, csúcsra kész.' }
      : tsb > -10
      ? { label: 'Edzés zóna', cls: 'form--training', desc: 'Optimális fejlődési állapot.' }
      : tsb > -30
      ? { label: 'Fáradt',     cls: 'form--tired',    desc: 'Érdemes lassítani egy kicsit.' }
      : { label: 'Túlterhelt', cls: 'form--overload', desc: 'Pihenő szükséges a sérülés elkerüléséhez.' };
    formEl.textContent     = label;
    formEl.className       = `training-form-badge ${cls}`;
    if (formDescEl) formDescEl.textContent = desc;
  }

  // Szűrés a választott időszakra (months = null/0 → összes)
  let recent = timeSeries;
  if (months && months > 0) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
    recent = timeSeries.filter(d => new Date(d.date) >= cutoff);
  }
  if (!recent.length) recent = timeSeries;

  // Grafikon cím időszak-felirata
  const rangeLabelEl = document.getElementById('trainingCtlRangeLabel');
  if (rangeLabelEl) {
    rangeLabelEl.textContent =
      !months || months <= 0 ? 'teljes időszak'
      : months === 12        ? 'elmúlt 1 év'
      : `elmúlt ${months} hónap`;
  }

  // Mindenből arányos ritkítás (gyors render)
  const sample = (arr, step) => arr.filter((_, i) => i % step === 0 || i === arr.length - 1);
  const step   = Math.max(1, Math.floor(recent.length / 300));
  const data   = sample(recent, step);

  const ctlCanvas  = el.querySelector('.training-ctl-chart');
  const tsbCanvas  = el.querySelector('.training-tsb-chart');

  if (ctlCanvas) {
    drawLineChart(ctlCanvas, [
      { data: data.map(d => ({ date: d.date, v: d.ctl })), color: '#3B82F6', fill: true },
      { data: data.map(d => ({ date: d.date, v: d.atl })), color: '#22C55E' },
    ]);
  }
  if (tsbCanvas) {
    drawLineChart(tsbCanvas, [
      { data: data.map(d => ({ date: d.date, v: d.tsb })), color: '#fc4c02', fill: true },
    ], { height: 140 });
  }
}

// ── Hőtérkép (canvas-alapú) ───────────────────────────────────────────────────

export function renderHeatmapCanvas(canvas, tracks) {
  const DPR = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 600;
  const H   = canvas.offsetHeight || 500;
  canvas.width  = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // Sötét háttér
  ctx.fillStyle = '#0e1117';
  ctx.fillRect(0, 0, W, H);

  if (!tracks.length) {
    ctx.fillStyle = '#888';
    ctx.font = '14px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Nincs betöltött útvonal', W / 2, H / 2);
    return;
  }

  // Bounding box – Tukey-fence alapú track szűrés
  // Track kezdőpontokból IQR-t számítunk, outliereket kizárjuk.
  const firstPts = tracks.map(pts => pts[0]).filter(Boolean);
  const sortedLats = [...firstPts.map(p => p[0])].sort((a,b)=>a-b);
  const sortedLngs = [...firstPts.map(p => p[1])].sort((a,b)=>a-b);
  const q = (arr, p) => arr[Math.floor(arr.length * p)] ?? arr[0];
  const iqrLat = q(sortedLats, 0.75) - q(sortedLats, 0.25);
  const iqrLng = q(sortedLngs, 0.75) - q(sortedLngs, 0.25);
  const fenceLo = (arr, iqr) => q(arr, 0.25) - 1.5 * Math.max(iqr, 0.5);
  const fenceHi = (arr, iqr) => q(arr, 0.75) + 1.5 * Math.max(iqr, 0.5);
  const latLo = fenceLo(sortedLats, iqrLat), latHi = fenceHi(sortedLats, iqrLat);
  const lngLo = fenceLo(sortedLngs, iqrLng), lngHi = fenceHi(sortedLngs, iqrLng);

  const localTracks = tracks.filter(pts => {
    const [lat, lng] = pts[0] || [];
    return lat >= latLo && lat <= latHi && lng >= lngLo && lng <= lngHi;
  });
  const renderTracks = localTracks.length >= 1 ? localTracks : tracks;

  // Bounding box: Tukey-fence az összes ponton
  // Ez a legsűrűbb területre fókuszál, kizárva az outlier pontokat
  const bLats = [], bLngs = [];
  renderTracks.forEach(pts => pts.forEach(([lat, lng]) => { bLats.push(lat); bLngs.push(lng); }));
  bLats.sort((a,b)=>a-b); bLngs.sort((a,b)=>a-b);
  const qv = (arr, p) => arr[Math.floor(arr.length * p)] ?? arr[0];
  const iqLat = qv(bLats,.75) - qv(bLats,.25);
  const iqLng = qv(bLngs,.75) - qv(bLngs,.25);
  let minLat = qv(bLats,.25) - 2.0 * Math.max(iqLat, 0.02);
  let maxLat = qv(bLats,.75) + 2.0 * Math.max(iqLat, 0.02);
  let minLng = qv(bLngs,.25) - 2.0 * Math.max(iqLng, 0.02);
  let maxLng = qv(bLngs,.75) + 2.0 * Math.max(iqLng, 0.02);

  const dLat   = maxLat - minLat || 0.01;
  const dLng   = maxLng - minLng || 0.01;
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos(midLat * Math.PI / 180);
  const scale  = Math.min(W / (dLng * cosLat), H / dLat) * 0.9;
  const offX   = (W - dLng * cosLat * scale) / 2;
  const offY   = (H - dLat * scale) / 2;

  const toX = lng => offX + (lng - minLng) * cosLat * scale;
  const toY = lat => offY + (maxLat - lat) * scale;

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = 1.2;

  renderTracks.forEach(pts => {
    if (pts.length < 2) return;
    ctx.strokeStyle = 'rgba(252,76,2,0.12)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    pts.forEach(([lat, lng], i) => { const x = toX(lng), y = toY(lat); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();

    ctx.strokeStyle = 'rgba(252,76,2,0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    pts.forEach(([lat, lng], i) => { const x = toX(lng), y = toY(lat); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
  });
}
