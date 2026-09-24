// @ts-check
/*
 * Quick charts of a symbol for the GDX viewer (the chart view of media/table.js):
 * horizontal bars, lines and heatmaps drawn as SVG from the chart data of the host
 * (src/table.ts, TableView.chart).
 *
 * Colors: the validated reference palette of the dataviz method (8 categorical slots,
 * fixed order; light and dark steps), a one-hue sequential ramp and a blue/red diverging
 * pair with a gray midpoint. Text uses the theme's colors, never a series color.
 */
(function () {
  'use strict';

  const PALETTE = {
    light: {
      series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
      other: '#898781',
      // Sequential ramp, near zero (receding toward the surface) to large.
      seq: ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'],
      neutral: '#f0efec',
      negative: '#e34948',
      positive: '#2a78d6',
    },
    dark: {
      series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
      other: '#898781',
      seq: ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'],
      neutral: '#383835',
      negative: '#e66767',
      positive: '#3987e5',
    },
  };

  function palette() {
    const c = document.body.classList;
    return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? PALETTE.light : PALETTE.dark;
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  function div(cls, ...children) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }
  function span(cls, text) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // Text measuring (labels are in the editor font, like the table) -----------------

  const FONT_SIZE = 12;
  let measureCtx = null;
  function measure(text, mono) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const st = getComputedStyle(document.body);
    const family = mono ? st.getPropertyValue('--vscode-editor-font-family') || 'monospace' : st.fontFamily;
    measureCtx.font = `${FONT_SIZE}px ${family}`;
    return measureCtx.measureText(text).width;
  }
  /** The text, shortened with an ellipsis to fit `max` pixels. */
  function fit(text, max, mono) {
    if (measure(text, mono) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(text.slice(0, mid) + '…', mono) <= max) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + '…';
  }

  // Scales -----------------------------------------------------------------------------

  /** Round tick values covering [min, max]. */
  function niceTicks(min, max, count) {
    if (!(max > min)) {
      const d = min === 0 ? 1 : Math.abs(min) * 0.1;
      min -= d;
      max += d;
    }
    const raw = (max - min) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const err = raw / mag;
    const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number((Math.round(v / step) * step).toPrecision(12)));
    return { ticks, step, lo: ticks[0], hi: ticks[ticks.length - 1] };
  }

  function tickFormat(step) {
    const abs = Math.abs(step);
    if (abs >= 1e4) return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format;
    if (abs < 1e-4) return (v) => (v === 0 ? '0' : v.toExponential(1));
    const decimals = Math.max(0, -Math.floor(Math.log10(abs) + 1e-9));
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format;
  }

  function linear(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    return (v) => r0 + (v - d0) * k;
  }

  // Colors (interpolated in OKLab) -----------------------------------------------------

  function hexToLab(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const r = lin((n >> 16) & 255);
    const g = lin((n >> 8) & 255);
    const b = lin(n & 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
  }
  function labToHex([L, A, B]) {
    const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
    const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
    const q = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
    const enc = (c) => {
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, c)) * 255);
    };
    const rgb = [enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q), enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q), enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q)];
    return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  }
  function mix(a, b, t) {
    const x = hexToLab(a);
    const y = hexToLab(b);
    return labToHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  /** A color of a ramp of steps for t in [0, 1]. */
  function ramp(steps, t) {
    const x = Math.min(1, Math.max(0, t)) * (steps.length - 1);
    const i = Math.min(steps.length - 2, Math.floor(x));
    return mix(steps[i], steps[i + 1], x - i);
  }

  // Tooltip ----------------------------------------------------------------------------

  function tooltip(root) {
    const el = div('chart-tip');
    el.hidden = true;
    root.append(el);
    return {
      /** rows: [{ color, kind: 'bar'|'line', label, value }] */
      show(title, rows, x, y) {
        el.replaceChildren(div('tip-title', title));
        for (const r of rows) {
          const row = div('tip-row');
          if (r.color) {
            const key = span(r.kind === 'line' ? 'tip-key line' : 'tip-key');
            key.style.background = r.color;
            row.append(key);
          }
          const strong = document.createElement('strong');
          strong.textContent = r.value;
          row.append(strong);
          if (r.label) row.append(span('tip-label', r.label));
          el.append(row);
        }
        el.hidden = false;
        const box = root.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = x + 14;
        if (left + w > box.width - 4) left = Math.max(4, x - w - 14);
        let top = y + 14;
        if (top + h > root.offsetHeight - 4) top = Math.max(4, y - h - 14);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
      },
      hide() {
        el.hidden = true;
      },
    };
  }

  function legend(data, kind, pal) {
    if (data.series.length < 2) return null;
    const el = div('chart-legend');
    el.setAttribute('role', 'list');
    for (const sr of data.series) {
      const item = span('legend-item');
      item.setAttribute('role', 'listitem');
      const key = span(kind === 'line' ? 'legend-key line' : 'legend-key');
      key.style.background = seriesColor(sr, pal);
      item.append(key, document.createTextNode(sr.name));
      el.append(item);
    }
    return el;
  }

  function seriesColor(sr, pal) {
    return sr.slot < 0 ? pal.other : pal.series[sr.slot % pal.series.length];
  }

  /** The color of a value: by its sign for differences (data.signColors), else its series' color. */
  function valueColor(data, sr, v, pal) {
    return data.signColors ? (v < 0 ? pal.negative : pal.positive) : seriesColor(sr, pal);
  }


  // Bar chart (horizontal) --------------------------------------------------------------

  function barChart(root, data, width) {
    const pal = palette();
    const n = data.categories.length;
    const ns = data.series.length;
    const single = ns === 1;
    const bar = single ? 16 : ns <= 3 ? 10 : 8;
    const band = ns * bar + (ns - 1) * 2 + 12;
    const axisH = 22;
    const labelW = Math.max(40, Math.min(width * 0.35, Math.max(...data.categories.map((c) => measure(c, true))) + 8));
    const all = data.series.flatMap((sr) => sr.values.filter((v) => v !== null));
    const min = Math.min(0, ...all);
    const max = Math.max(0, ...all);
    // Values at the bar tips: one series only, and not too many bars.
    const tips = single && n <= 60;
    const tipW = tips ? Math.max(...data.series[0].texts.filter((t) => t !== null).map((t) => measure(t, true))) + 6 : 0;
    const x0 = labelW + 12 + (min < 0 ? tipW : 0);
    const x1 = Math.max(x0 + 80, width - 12 - (max > 0 ? tipW : 0));
    const nice = niceTicks(min, max, Math.max(2, Math.floor((x1 - x0) / 90)));
    const x = linear(nice.lo, nice.hi, x0, x1);
    const height = axisH + n * band + 8;
    const fmt = tickFormat(nice.step);
    const svg = s('svg', { width: x1 + (max > 0 ? tipW : 0) + 12, height, class: 'chart-svg', role: 'img', 'aria-label': `Bar chart of ${ns} series over ${n} categories` });
    const grid = s('g');
    for (const t of nice.ticks) {
      grid.append(s('line', { class: t === 0 ? 'baseline' : 'grid', x1: x(t), x2: x(t), y1: axisH - 4, y2: height - 8 }));
      grid.append(s('text', { x: x(t), y: 12, 'text-anchor': 'middle', class: 'tick' }, fmt(t)));
    }
    svg.append(grid);
    const hover = s('rect', { class: 'band-hover hover-only', x: 0, width: x1 + tipW + 12, height: band, visibility: 'hidden' });
    svg.append(hover);
    const marks = s('g');
    data.categories.forEach((cat, i) => {
      const top = axisH + i * band + 6;
      marks.append(s('text', { x: labelW, y: top + (band - 12) / 2 + 4, 'text-anchor': 'end', class: 'cat mono' }, fit(cat, labelW - 4, true)));
      data.series.forEach((sr, k) => {
        const v = sr.values[i];
        if (v === null) return;
        const y = top + k * (bar + 2);
        marks.append(s('path', { d: barPath(x(0), x(v), y, bar), fill: valueColor(data, sr, v, pal) }));
        if (tips) {
          const end = x(v);
          marks.append(s('text', { x: v < 0 ? end - 4 : end + 4, y: y + bar / 2 + 4, 'text-anchor': v < 0 ? 'end' : 'start', class: 'value mono' }, sr.texts[i]));
        }
      });
    });
    svg.append(marks);
    const tip = tooltip(root);
    const at = (i, p) => {
      if (i < 0 || i >= n) return tip.hide(), hover.setAttribute('visibility', 'hidden');
      hover.setAttribute('y', String(axisH + i * band));
      hover.setAttribute('visibility', 'visible');
      tip.show(data.categories[i], data.series.map((sr) => ({ color: valueColor(data, sr, sr.values[i] ?? 0, pal), kind: 'bar', label: single ? '' : sr.name, value: sr.texts[i] ?? '–' })), p.x, p.y);
    };
    interactive(root, svg, {
      count: n,
      locate: (p) => Math.floor((p.y - axisH) / band),
      anchor: (i) => ({ x: x0, y: axisH + (i + 1) * band }),
      show: at,
      keys: { ArrowDown: 1, ArrowUp: -1 },
      hide: () => at(-1),
    });
    return svg;
  }

  /** A horizontal bar from the baseline x0 to x1, rounded (4px) at its data end only. */
  function barPath(x0, x1, y, h) {
    const w = Math.abs(x1 - x0);
    const r = Math.min(4, h / 2, w);
    if (w < 0.5) return `M${x0},${y}h0.5v${h}h-0.5z`;
    if (x1 >= x0) return `M${x0},${y}H${x1 - r}a${r},${r} 0 0 1 ${r},${r}V${y + h - r}a${r},${r} 0 0 1 ${-r},${r}H${x0}Z`;
    return `M${x0},${y}H${x1 + r}a${r},${r} 0 0 0 ${-r},${r}V${y + h - r}a${r},${r} 0 0 0 ${r},${r}H${x0}Z`;
  }

  // Line chart --------------------------------------------------------------------------

  function lineChart(root, data, width) {
    const pal = palette();
    const n = data.categories.length;
    const all = data.series.flatMap((sr) => sr.values.filter((v) => v !== null));
    const nice = niceTicks(Math.min(...all), Math.max(...all), 6);
    const fmt = tickFormat(nice.step);
    const axisW = Math.max(...nice.ticks.map((t) => measure(fmt(t), false))) + 10;
    const x0 = axisW + 8;
    const x1 = Math.max(x0 + 100, width - 24);
    const top = 8;
    const plotH = 300;
    const y = linear(nice.lo, nice.hi, top + plotH, top);
    const px = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1));
    const labelMax = Math.min(140, Math.max(...data.categories.map((c) => measure(c, true))));
    const every = Math.max(1, Math.ceil((n * (labelMax + 12)) / (x1 - x0)));
    const height = top + plotH + 28;
    const svg = s('svg', { width: x1 + 24, height, class: 'chart-svg', role: 'img', 'aria-label': `Line chart of ${data.series.length} series over ${n} categories` });
    for (const t of nice.ticks) {
      svg.append(s('line', { class: t === 0 ? 'baseline' : 'grid', x1: x0, x2: x1, y1: y(t), y2: y(t) }));
      svg.append(s('text', { x: axisW, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, fmt(t)));
    }
    svg.append(s('line', { class: 'baseline', x1: x0, x2: x1, y1: top + plotH, y2: top + plotH }));
    data.categories.forEach((cat, i) => {
      if (i % every === 0) svg.append(s('text', { x: px(i), y: top + plotH + 18, 'text-anchor': 'middle', class: 'cat mono' }, fit(cat, labelMax, true)));
    });
    const markers = n <= 50;
    for (const sr of data.series) {
      const color = seriesColor(sr, pal);
      let d = '';
      let pen = false;
      sr.values.forEach((v, i) => {
        if (v === null) return void (pen = false);
        d += `${pen ? 'L' : 'M'}${px(i)},${y(v)}`;
        pen = true;
      });
      svg.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (markers) sr.values.forEach((v, i) => v !== null && svg.append(s('circle', { cx: px(i), cy: y(v), r: 4, fill: color, class: 'ring' })));
      // A lone point between gaps would be invisible without a marker.
      else sr.values.forEach((v, i) => v !== null && sr.values[i - 1] == null && sr.values[i + 1] == null && svg.append(s('circle', { cx: px(i), cy: y(v), r: 3, fill: color })));
    }
    const cross = s('line', { class: 'crosshair hover-only', y1: top, y2: top + plotH, visibility: 'hidden' });
    const dots = s('g', { class: 'hover-only' });
    svg.append(cross, dots);
    const tip = tooltip(root);
    const at = (i, p) => {
      dots.replaceChildren();
      if (i < 0 || i >= n) return tip.hide(), cross.setAttribute('visibility', 'hidden');
      cross.setAttribute('x1', String(px(i)));
      cross.setAttribute('x2', String(px(i)));
      cross.setAttribute('visibility', 'visible');
      for (const sr of data.series) {
        const v = sr.values[i];
        if (v !== null) dots.append(s('circle', { cx: px(i), cy: y(v), r: 5, fill: seriesColor(sr, pal), class: 'ring' }));
      }
      tip.show(data.categories[i], data.series.map((sr) => ({ color: seriesColor(sr, pal), kind: 'line', label: data.series.length > 1 ? sr.name : '', value: sr.texts[i] ?? '–' })), p.x, p.y);
    };
    interactive(root, svg, {
      count: n,
      anchor: (i) => ({ x: px(i), y: top + 20 }),
      locate: (p) => (p.x < x0 - 12 || p.x > x1 + 12 ? -1 : n === 1 ? 0 : Math.round(((p.x - x0) / (x1 - x0)) * (n - 1))),
      show: at,
      keys: { ArrowRight: 1, ArrowLeft: -1 },
      hide: () => at(-1),
    });
    return svg;
  }

  // Heatmap -----------------------------------------------------------------------------

  function heatmap(root, data, width) {
    const pal = palette();
    const rows = data.series;
    const cols = data.categories;
    const all = rows.flatMap((r) => r.values.filter((v) => v !== null));
    const min = Math.min(...all);
    const max = Math.max(...all);
    const diverging = min < 0 && max > 0;
    const m = Math.max(Math.abs(min), Math.abs(max));
    const color = diverging
      ? (v) => (v < 0 ? mix(pal.neutral, pal.negative, -v / m) : mix(pal.neutral, pal.positive, v / m))
      : (v) => ramp(pal.seq, max === min ? 1 : (v - min) / (max - min));
    const rowW = Math.max(40, Math.min(width * 0.3, Math.max(...rows.map((r) => measure(r.name, true))) + 8));
    const cw = Math.max(12, Math.min(48, Math.floor((width - rowW - 24) / cols.length)));
    const ch = 20;
    const gap = cw >= 16 ? 2 : 1;
    const colLabelMax = Math.min(120, Math.max(...cols.map((c) => measure(c, true))));
    const rotate = colLabelMax + 6 > cw;
    const headH = rotate ? colLabelMax + 10 : 20;
    const x0 = rowW + 8;
    const w = x0 + cols.length * cw + 12;
    const height = headH + rows.length * ch + 8;
    const svg = s('svg', { width: w, height, class: 'chart-svg', role: 'img', 'aria-label': `Heatmap of ${rows.length} rows by ${cols.length} columns` });
    cols.forEach((c, j) => {
      const cx = x0 + j * cw + (cw - gap) / 2;
      svg.append(
        rotate
          ? s('text', { x: cx + 4, y: headH - 6, transform: `rotate(-90 ${cx + 4} ${headH - 6})`, class: 'cat mono' }, fit(c, colLabelMax, true))
          : s('text', { x: cx, y: headH - 6, 'text-anchor': 'middle', class: 'cat mono' }, fit(c, cw - 4, true)),
      );
    });
    rows.forEach((r, i) => {
      const y = headH + i * ch;
      svg.append(s('text', { x: rowW, y: y + ch / 2 + 3, 'text-anchor': 'end', class: 'cat mono' }, fit(r.name, rowW - 4, true)));
      r.values.forEach((v, j) => {
        if (v !== null) svg.append(s('rect', { x: x0 + j * cw, y, width: cw - gap, height: ch - gap, rx: 2, fill: color(v) }));
      });
    });
    const outline = s('rect', { class: 'cell-hover hover-only', width: cw - gap, height: ch - gap, rx: 2, visibility: 'hidden' });
    svg.append(outline);
    const tip = tooltip(root);
    const nc = cols.length;
    const at = (k, p) => {
      if (k < 0) return tip.hide(), outline.setAttribute('visibility', 'hidden');
      const i = Math.floor(k / nc);
      const j = k % nc;
      outline.setAttribute('x', String(x0 + j * cw));
      outline.setAttribute('y', String(headH + i * ch));
      outline.setAttribute('visibility', 'visible');
      const text = rows[i].texts[j];
      tip.show(`${rows[i].name} · ${cols[j]}`, [{ value: text ?? 'no record', label: '' }], p.x, p.y);
    };
    interactive(root, svg, {
      count: rows.length * nc,
      anchor: (k) => ({ x: x0 + ((k % nc) + 1) * cw, y: headH + (Math.floor(k / nc) + 1) * ch }),
      locate: (p) => {
        const i = Math.floor((p.y - headH) / ch);
        const j = Math.floor((p.x - x0) / cw);
        return i < 0 || j < 0 || i >= rows.length || j >= nc ? -1 : i * nc + j;
      },
      show: at,
      keys: { ArrowRight: 1, ArrowLeft: -1, ArrowDown: nc, ArrowUp: -nc },
      hide: () => at(-1),
    });
    const legendEl = div('chart-scale');
    const bar = span('scale-bar');
    const stops = diverging ? [-m, 0, m] : [min, max];
    const steps = 12;
    const colors = Array.from({ length: steps + 1 }, (_, k) => color(stops[0] + ((stops[stops.length - 1] - stops[0]) * k) / steps));
    bar.style.background = `linear-gradient(to right, ${colors.join(', ')})`;
    const fmtScale = tickFormat(niceTicks(stops[0], stops[stops.length - 1], 4).step);
    const scale = { colors, from: fmtScale(stops[0]), to: fmtScale(stops[stops.length - 1]), notes: /** @type {string[]} */ ([]) };
    if (diverging) scale.notes.push('gray: 0');
    if (rows.some((r) => r.values.some((v) => v === null))) scale.notes.push('blank: no record');
    legendEl.append(span('scale-label', scale.from), bar, span('scale-label', scale.to), ...scale.notes.map((t) => span('muted', t)));
    return { svg, legend: legendEl, scale };
  }

  /**
   * Hover and keyboard focus: `locate` maps a point of the SVG to a mark index, `anchor` gives
   * a mark's tooltip position in the SVG (for the keyboard), and `show` shows the mark with the
   * tooltip at a point of the chart root (which also holds the legend above the SVG).
   */
  function interactive(root, svg, o) {
    let current = -1;
    const offset = () => {
      const a = svg.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      return { x: a.left - b.left, y: a.top - b.top };
    };
    svg.setAttribute('tabindex', '0');
    svg.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const off = offset();
      const p = { x: e.clientX - box.left, y: e.clientY - box.top };
      current = o.locate(p);
      if (current >= 0 && current < o.count) o.show(current, { x: p.x + off.x, y: p.y + off.y });
      else o.hide();
    });
    svg.addEventListener('pointerleave', () => o.hide());
    svg.addEventListener('blur', () => o.hide());
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return o.hide();
      const d = o.keys[e.key];
      if (d === undefined) return;
      e.preventDefault();
      current = current < 0 ? 0 : Math.max(0, Math.min(o.count - 1, current + d));
      const a = o.anchor(current);
      const off = offset();
      o.show(current, { x: a.x + off.x, y: a.y + off.y });
    });
  }

  /**
   * Renders chart data (see TableView.chart) into a new element of the given width.
   * Returns null if there is nothing to chart.
   */
  function render(data, width) {
    const hasValues = data.series.some((sr) => sr.values.some((v) => v !== null));
    if (!hasValues) return null;
    const root = div('chart');
    const type = data.chart.type;
    // For the image export (toSvg).
    const info = { data, scale: null };
    // @ts-ignore
    root.gdxChart = info;
    if (type === 'heatmap') {
      const hm = heatmap(root, data, width - 24);
      info.scale = hm.scale;
      root.prepend(hm.legend);
      root.append(hm.svg);
    } else {
      const lg = legend(data, type, palette());
      if (lg) root.append(lg);
      root.append(type === 'line' ? lineChart(root, data, width - 24) : barChart(root, data, width - 24));
    }
    // The tooltip was added before the chart; keep it on top.
    const tip = root.querySelector('.chart-tip');
    if (tip) root.append(tip);
    return root;
  }

  // Image export -------------------------------------------------------------------------

  /** Presentation properties copied from the computed styles, so the image does not depend on the theme's CSS. */
  const INLINE = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size', 'font-weight'];

  function inlineClone(node) {
    if (node.nodeType !== 1) return node.cloneNode(false);
    const el = /** @type {Element} */ (node);
    if (el.classList.contains('hover-only')) return null;
    const copy = el.cloneNode(false);
    const cs = getComputedStyle(el);
    for (const p of INLINE) {
      const v = cs.getPropertyValue(p);
      if (v) /** @type {Element} */ (copy).setAttribute(p, v);
    }
    for (const a of ['class', 'tabindex', 'role', 'aria-label']) /** @type {Element} */ (copy).removeAttribute(a);
    for (const c of el.childNodes) {
      const cc = inlineClone(c);
      if (cc) copy.appendChild(cc);
    }
    return copy;
  }

  /** Lines of at most `max` pixels. */
  function wrap(text, max, mono) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (line && measure(next, mono) > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * A standalone SVG image of a rendered chart (the element returned by render): a title,
   * a subtitle and notes, the legend or color scale, and the chart, with the theme's colors
   * written into the elements. Returns { svg, width, height }.
   */
  function toSvg(chartRoot, head) {
    const info = chartRoot.gdxChart;
    const src = chartRoot.querySelector('svg.chart-svg');
    const body = getComputedStyle(document.body);
    const fg = body.color;
    const muted = body.getPropertyValue('--vscode-descriptionForeground').trim() || fg;
    const bg = body.getPropertyValue('--vscode-editor-background').trim() || body.backgroundColor;
    const sans = body.fontFamily;
    const mono = body.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
    const pal = palette();
    const pad = 16;
    const cw = Number(src.getAttribute('width'));
    const ch = Number(src.getAttribute('height'));
    const width = Math.max(cw, 360) + 2 * pad;
    const inner = width - 2 * pad;
    const out = s('svg', { xmlns: SVG, width, height: 0, viewBox: '', 'font-family': sans, 'font-size': FONT_SIZE });
    const bgRect = s('rect', { x: 0, y: 0, width, height: 0, fill: bg });
    out.append(bgRect);
    let y = pad;
    const text = (t, size, color, weight, family) => {
      out.append(s('text', { x: pad, y: y + size, fill: color, 'font-size': size, 'font-weight': weight, 'font-family': family }, t));
      y += size + 6;
    };
    if (head.title) text(head.title, 14, fg, 600, sans);
    if (head.subtitle) for (const l of wrap(head.subtitle, inner, false)) text(l, FONT_SIZE, muted, 400, sans);
    if (head.notes) for (const l of wrap(head.notes, inner, false)) text(l, FONT_SIZE, muted, 400, sans);
    y += 4;
    if (info.scale) {
      // The heatmap's color scale.
      const sc = info.scale;
      const gid = 'scale';
      const grad = s('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 }, ...sc.colors.map((c, k) => s('stop', { offset: k / (sc.colors.length - 1), 'stop-color': c })));
      out.append(s('defs', null, grad));
      let x = pad;
      out.append(s('text', { x, y: y + 10, fill: fg, 'font-family': mono }, sc.from));
      x += measure(sc.from, true) + 6;
      out.append(s('rect', { x, y: y + 1, width: 160, height: 10, rx: 2, fill: `url(#${gid})` }));
      x += 166;
      out.append(s('text', { x, y: y + 10, fill: fg, 'font-family': mono }, sc.to));
      x += measure(sc.to, true) + 14;
      for (const n of sc.notes) {
        out.append(s('text', { x, y: y + 10, fill: muted }, n));
        x += measure(n, false) + 14;
      }
      y += 22;
    } else if (info.data.series.length > 1) {
      // The legend, wrapped to the width.
      const line = info.data.chart.type === 'line';
      let x = pad;
      for (const sr of info.data.series) {
        const w = 16 + measure(sr.name, true);
        if (x > pad && x + w > pad + inner) {
          x = pad;
          y += 18;
        }
        const color = seriesColor(sr, pal);
        out.append(line ? s('rect', { x, y: y + 5, width: 12, height: 2, rx: 1, fill: color }) : s('rect', { x, y: y + 1, width: 10, height: 10, rx: 2, fill: color }));
        out.append(s('text', { x: x + (line ? 16 : 14), y: y + 10, fill: fg, 'font-family': mono }, sr.name));
        x += w + 14;
      }
      y += 22;
    }
    const chart = s('g', { transform: `translate(${pad},${y})` });
    for (const c of src.childNodes) {
      const cc = inlineClone(c);
      if (cc) chart.append(cc);
    }
    out.append(chart);
    const height = Math.ceil(y + ch + pad);
    out.setAttribute('height', String(height));
    out.setAttribute('viewBox', `0 0 ${width} ${height}`);
    bgRect.setAttribute('height', String(height));
    return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out), width, height };
  }

  /** Largest side of a PNG in pixels (browsers limit canvas sizes). */
  const MAX_PNG_SIDE = 16000;

  /** A PNG of an SVG image, at twice the resolution if the size allows. Resolves to a Blob. */
  function toPng(image) {
    const scale = Math.min(2, MAX_PNG_SIDE / Math.max(image.width, image.height));
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([image.svg], { type: 'image/svg+xml' }));
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, image.width, image.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be created.'))), 'image/png');
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('The chart could not be drawn as an image.'));
      };
      img.src = url;
    });
  }

  // @ts-ignore
  window.GdxChart = { render, toSvg, toPng };
})();
