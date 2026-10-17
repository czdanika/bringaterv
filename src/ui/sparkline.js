/**
 * Bringaterv – mini grafikonok (sparkline), táblázatsorok végére
 * ================================================================
 * Inline SVG-t adnak vissza stringként, így bármelyik innerHTML-es sablonba
 * beilleszthetők. A szín alapból a márkaszín (currentColor a .spark osztályon).
 *
 *   sparkBars([0, 2, 5, 1, 0, 7])              → oszlopok (pl. havi használat)
 *   sparkStep([{x: t1, y: 28.3}, …], { lowerIsBetter: true })
 *                                              → rekord-fejlődés lépcsős vonallal
 */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Oszlopos sparkline. A nulla értékek halvány alapvonal-szakaszként látszanak
 * (mint a Dreeve „Last 12 months” oszlopa), így az üres hónap is olvasható.
 * @param {number[]} values
 * @param {{ width?: number, height?: number, gap?: number, labels?: string[], title?: string }} [opts]
 */
export function sparkBars(values, opts = {}) {
  const { width = 120, height = 28, gap = 2, labels = [], title = "" } = opts;
  const n = values.length;
  if (!n) return "";
  const max = Math.max(...values, 0);
  const bw = (width - gap * (n - 1)) / n;
  const bars = values.map((v, i) => {
    const x = (i * (bw + gap)).toFixed(1);
    const tip = labels[i] ? `<title>${esc(labels[i])}</title>` : "";
    if (!v || max <= 0) {
      return `<rect class="spark-zero" x="${x}" y="${height - 1.5}" width="${bw.toFixed(1)}" height="1.5" rx="0.75">${tip}</rect>`;
    }
    const h = Math.max(2, (v / max) * (height - 2));
    return `<rect class="spark-bar" x="${x}" y="${(height - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1">${tip}</rect>`;
  }).join("");
  return `<svg class="spark spark--bars" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"${title ? ` aria-label="${esc(title)}"` : ""}>${bars}</svg>`;
}

/**
 * Lépcsős vonal – rekord fejlődése az időben. Minden pont egy új rekord;
 * a vonal a mai napig kitart. lowerIsBetter esetén (idő) a jobb érték van fent.
 * @param {{x: number, y: number}[]} points  x: időbélyeg (ms), y: érték
 * @param {{ width?: number, height?: number, lowerIsBetter?: boolean, until?: number }} [opts]
 */
export function sparkStep(points, opts = {}) {
  const { width = 96, height = 26, lowerIsBetter = false, until = Date.now() } = opts;
  if (!points.length) return "";
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(until, ...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 3;
  const sx = (x) => (x1 === x0 ? width - pad : pad + ((x - x0) / (x1 - x0)) * (width - 2 * pad));
  const sy = (y) => {
    if (y1 === y0) return height / 2;
    const r = (y - y0) / (y1 - y0);
    return pad + (lowerIsBetter ? r : 1 - r) * (height - 2 * pad);
  };
  let d = `M${sx(points[0].x).toFixed(1)},${sy(points[0].y).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` H${sx(points[i].x).toFixed(1)} V${sy(points[i].y).toFixed(1)}`;
  }
  d += ` H${sx(x1).toFixed(1)}`;
  const dots = points.map((p, i) =>
    `<circle class="${i === points.length - 1 ? "spark-dot spark-dot--last" : "spark-dot"}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${i === points.length - 1 ? 2.6 : 1.6}"/>`).join("");
  return `<svg class="spark spark--step" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path class="spark-line" d="${d}"/>${dots}</svg>`;
}
