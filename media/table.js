// @ts-check
/* Shared helpers and the paged table (list view, table view, column filters) used by the GDX viewer and the diff panel. */
(function () {
  'use strict';

  /**
   * Creates an element. `attrs` may contain `class`, `title`, `on<event>` handlers,
   * `dataset` and any other attribute.
   * @param {string} tag
   * @param {Record<string, any> | null} [attrs]
   * @param {...(Node | string | null | undefined | false)} children
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  /** Like `el.replaceChildren(...)`, but skips null/undefined/false children. */
  function fill(el, ...children) {
    el.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
  }

  const SVG = 'http://www.w3.org/2000/svg';
  function funnelIcon() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M1.5 2h13l-5 6v5.5l-3-1.5V8z');
    svg.append(path);
    return svg;
  }

  const SPECIAL = new Set(['eps', 'na', '+inf', '-inf', 'undf', 'inf']);
  const SPECIALS = [
    ['eps', 'EPS'],
    ['na', 'NA'],
    ['pinf', '+INF'],
    ['minf', '-INF'],
    ['undf', 'UNDF'],
  ];

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const fmt = new Intl.NumberFormat();
  const plural = (n, word) => `${fmt.format(n)} ${word}${n === 1 ? '' : 's'}`;

  // Popups -------------------------------------------------------------------

  let openPopupInstance = null;

  /** Shows `content` in a popup below `anchor`; closes on Escape or a click outside. */
  function openPopup(anchor, content, options) {
    if (openPopupInstance) openPopupInstance.close();
    const popup = h('div', { class: 'popup', role: 'dialog', 'aria-label': (options && options.label) || 'Filter' }, content);
    document.body.append(popup);
    const rect = anchor.getBoundingClientRect();
    // Below the anchor if it fits, else on the side with more room (scrolling if needed).
    const place = () => {
      popup.style.maxHeight = '';
      const w = popup.offsetWidth;
      const hgt = popup.offsetHeight;
      const below = window.innerHeight - rect.bottom - 6;
      const above = rect.top - 6;
      const left = Math.max(4, Math.min(rect.left, window.innerWidth - w - 4));
      let top;
      if (hgt <= below || below >= above) {
        top = rect.bottom + 2;
        if (hgt > below) popup.style.maxHeight = below + 'px';
      } else {
        popup.style.maxHeight = above + 'px';
        top = rect.top - 2 - Math.min(hgt, above);
      }
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
    };
    place();
    const onDown = (e) => {
      if (!popup.contains(e.target) && !anchor.contains(e.target)) close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(true);
      }
    };
    function close(refocus) {
      document.removeEventListener('mousedown', onDown, true);
      popup.removeEventListener('keydown', onKey);
      popup.remove();
      if (openPopupInstance === instance) openPopupInstance = null;
      if (refocus && anchor.focus) anchor.focus();
    }
    document.addEventListener('mousedown', onDown, true);
    popup.addEventListener('keydown', onKey);
    const instance = { popup, close, place };
    openPopupInstance = instance;
    return instance;
  }

  const MAX_LISTED_LABELS = 2000;

  /** Checklist of the labels of a column (keys, set texts, diff status). */
  function labelFilterContent(table, column, name, current) {
    const status = h('div', { class: 'muted' }, 'Loading labels…');
    const list = h('div', { class: 'labels', role: 'group', 'aria-label': 'Labels' });
    const counter = h('span', { class: 'muted' });
    const note = h('div', { class: 'muted small' });
    const search = h('input', { type: 'search', placeholder: 'Search labels…', 'aria-label': 'Search labels' });
    const hideUnselected = h('input', { type: 'checkbox' });
    const apply = h('button', { class: 'primary' }, 'Apply');
    let values = [];
    let truncated = false;
    let selected = new Set();
    let shown = [];
    let boxes = [];
    let last = -1;

    /** Updates the check boxes and the counter after the selection changed. */
    function sync() {
      if (hideUnselected.checked) return render();
      boxes.forEach((b, i) => (b.checked = selected.has(shown[i])));
      counter.textContent = `${fmt.format(selected.size)} of ${fmt.format(values.length)} selected`;
      apply.disabled = selected.size === 0;
    }

    /** Rebuilds the list (after the listed labels changed). */
    function render() {
      shown = hideUnselected.checked ? values.filter((v) => selected.has(v)) : values;
      boxes = [];
      const items = shown.slice(0, MAX_LISTED_LABELS).map((v, i) => {
        const box = h('input', { type: 'checkbox' });
        boxes.push(box);
        return h(
          'label',
          {
            class: 'label-item',
            title: v === '' ? '(empty)' : v,
            onclick: (e) => {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) return selectOnly(v);
              const on = !selected.has(v);
              if (e.shiftKey && last >= 0) {
                const [a, b] = last < i ? [last, i] : [i, last];
                for (const x of shown.slice(a, b + 1)) on ? selected.add(x) : selected.delete(x);
              } else {
                on ? selected.add(v) : selected.delete(v);
              }
              last = i;
              sync();
            },
            onauxclick: (e) => {
              if (e.button === 1) {
                e.preventDefault();
                selectOnly(v);
              }
            },
          },
          box,
          h('span', { class: v === '' ? 'muted' : '' }, v === '' ? '(empty)' : v),
        );
      });
      list.replaceChildren(...items);
      boxes.forEach((b, i) => (b.checked = selected.has(shown[i])));
      note.textContent =
        shown.length > MAX_LISTED_LABELS
          ? `Showing ${fmt.format(MAX_LISTED_LABELS)} of ${fmt.format(shown.length)} labels. Search to narrow them down.`
          : truncated
            ? 'The column has more labels than can be listed.'
            : '';
      counter.textContent = `${fmt.format(selected.size)} of ${fmt.format(values.length)} selected`;
      apply.disabled = selected.size === 0;
    }

    function selectOnly(v) {
      selected = new Set([v]);
      commit();
    }

    function commit() {
      if (selected.size === values.length && !truncated) {
        table.setFilter(column, undefined);
      } else {
        const deselected = values.filter((v) => !selected.has(v));
        // The shorter list is sent; exclusion also covers labels beyond a truncated list.
        table.setFilter(
          column,
          truncated || deselected.length < selected.size
            ? { type: 'labels', column, labels: deselected, exclude: true }
            : { type: 'labels', column, labels: [...selected] },
        );
      }
      table.closePopup();
    }

    // Like GAMS Studio: the search selects the matching labels and deselects all others.
    search.addEventListener(
      'input',
      debounce(() => {
        const needle = search.value.trim().toLowerCase();
        selected = new Set(values.filter((v) => !needle || v.toLowerCase().includes(needle)));
        last = -1;
        sync();
      }, 150),
    );
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && selected.size) commit();
    });
    hideUnselected.addEventListener('change', render);
    apply.addEventListener('click', commit);

    const content = h(
      'div',
      { class: 'filter-popup' },
      h('div', { class: 'popup-title' }, `Filter ${name}`),
      search,
      h('label', { class: 'check' }, hideUnselected, 'Hide unselected'),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => ((selected = new Set(values)), sync()) }, 'All'),
        h('button', { onclick: () => ((selected = new Set(values.filter((v) => !selected.has(v)))), sync()) }, 'Invert'),
        h('button', { onclick: () => ((selected = new Set()), sync()) }, 'None'),
        counter,
      ),
      status,
      list,
      note,
      h('div', { class: 'muted small' }, 'Ctrl+click or middle-click shows only that label; Shift+click selects a range.'),
      h(
        'div',
        { class: 'row end' },
        apply,
        h('button', { onclick: () => (table.setFilter(column, undefined), table.closePopup()) }, 'Reset'),
        h('button', { onclick: () => table.closePopup(true) }, 'Cancel'),
      ),
    );

    return {
      content,
      focus: () => search.focus(),
      setValues(m) {
        values = m.values;
        truncated = m.truncated;
        if (!current) selected = new Set(values);
        else if (current.exclude) {
          const out = new Set(current.labels);
          selected = new Set(values.filter((v) => !out.has(v)));
        } else {
          const keep = new Set(current.labels);
          selected = new Set(values.filter((v) => keep.has(v)));
        }
        status.remove();
        render();
      },
    };
  }

  /** Min/max range and special value visibility for a numeric column. */
  function rangeFilterContent(table, column, name, current) {
    const cur = current || {};
    const min = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'no limit', 'aria-label': 'Minimum', value: cur.min ?? '' });
    const max = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'no limit', 'aria-label': 'Maximum', value: cur.max ?? '' });
    const exclude = h('input', { type: 'checkbox' });
    exclude.checked = !!cur.exclude;
    const hidden = new Set(cur.hideSpecials || []);
    const specials = SPECIALS.map(([key, label]) => {
      const box = h('input', { type: 'checkbox', dataset: { key } });
      box.checked = !hidden.has(key);
      return h('label', { class: 'check' }, box, label);
    });
    const error = h('div', { class: 'error-text' });
    const parse = (input) => {
      const t = input.value.trim();
      if (t === '') return undefined;
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    };
    function commit() {
      const lo = parse(min);
      const hi = parse(max);
      min.classList.toggle('invalid', Number.isNaN(lo));
      max.classList.toggle('invalid', Number.isNaN(hi));
      if (Number.isNaN(lo) || Number.isNaN(hi)) {
        error.textContent = 'Enter numbers such as 10, -2.5 or 1e-6.';
        return;
      }
      if (lo !== undefined && hi !== undefined && lo > hi) {
        error.textContent = 'The minimum is larger than the maximum.';
        return;
      }
      const hideSpecials = specials.map((l) => l.querySelector('input')).filter((b) => !b.checked).map((b) => b.dataset.key);
      if (lo === undefined && hi === undefined && !hideSpecials.length) {
        table.setFilter(column, undefined);
      } else {
        table.setFilter(column, { type: 'range', column, min: lo, max: hi, exclude: exclude.checked || undefined, hideSpecials: hideSpecials.length ? hideSpecials : undefined });
      }
      table.closePopup();
    }
    const onEnter = (e) => e.key === 'Enter' && commit();
    min.addEventListener('keydown', onEnter);
    max.addEventListener('keydown', onEnter);
    const content = h(
      'div',
      { class: 'filter-popup' },
      h('div', { class: 'popup-title' }, `Filter ${name}`),
      h('div', { class: 'grid2' }, h('span', null, 'Min'), min, h('span', null, 'Max'), max),
      h('label', { class: 'check' }, exclude, 'Exclude the range'),
      error,
      h('div', { class: 'muted small' }, 'Show special values:'),
      h('div', { class: 'row wrap' }, ...specials),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'primary', onclick: commit }, 'Apply'),
        h('button', { onclick: () => (table.setFilter(column, undefined), table.closePopup()) }, 'Reset'),
        h('button', { onclick: () => table.closePopup(true) }, 'Cancel'),
      ),
    );
    return { content, focus: () => min.focus() };
  }

  /** Number format (g/f/e), precision and trailing zeros; changes apply immediately. */
  function formatContent(table) {
    const current = Object.assign({ style: 'g', precision: 6, squeeze: true }, table.effectiveFormat || {}, table.state.format || {});
    const styles = [
      ['g', 'g — automatic', 'Fixed notation for numbers of moderate size, scientific otherwise'],
      ['f', 'f — fixed', 'Fixed number of decimals'],
      ['e', 'e — scientific', 'Scientific notation'],
    ];
    const radios = styles.map(([value, label, title]) => {
      const r = h('input', { type: 'radio', name: 'gdx-format-style', value });
      r.checked = current.style === value;
      return h('label', { class: 'check', title }, r, label);
    });
    const precision = h('input', { type: 'number', class: 'narrow', 'aria-label': 'Precision' });
    const precisionLabel = h('span', null, 'Precision');
    const full = h('input', { type: 'checkbox' });
    const fullLabel = h('label', { class: 'check', title: 'The fewest digits that reproduce the stored value exactly' }, full, 'Full');
    const squeeze = h('input', { type: 'checkbox' });
    const squeezeLabel = h('label', { class: 'check' }, squeeze, 'Squeeze trailing zeros');
    let style = current.style;
    let prec = current.precision === 'full' ? 6 : current.precision;
    full.checked = current.precision === 'full' && style !== 'f';
    squeeze.checked = !!current.squeeze;

    function sync() {
      const fixed = style === 'f';
      if (fixed) full.checked = false;
      precision.min = fixed ? '0' : '1';
      precision.max = fixed ? '14' : '17';
      prec = Math.min(Number(precision.max), Math.max(Number(precision.min), prec));
      precision.value = String(prec);
      precision.disabled = full.checked;
      full.disabled = fixed;
      fullLabel.classList.toggle('disabled', fixed);
      squeeze.disabled = full.checked;
      squeezeLabel.classList.toggle('disabled', full.checked);
      precisionLabel.textContent = fixed ? 'Decimals' : 'Significant digits';
    }
    const apply = () => {
      sync();
      table.setFormat({ style, precision: full.checked ? 'full' : prec, squeeze: full.checked ? true : squeeze.checked });
    };
    radios.forEach((l) => l.querySelector('input').addEventListener('change', (e) => ((style = e.target.value), apply())));
    precision.addEventListener(
      'input',
      debounce(() => {
        const n = Math.round(Number(precision.value));
        if (precision.value !== '' && Number.isFinite(n)) {
          prec = n;
          apply();
        }
      }, 250),
    );
    full.addEventListener('change', apply);
    squeeze.addEventListener('change', apply);
    sync();
    const content = h(
      'div',
      { class: 'filter-popup' },
      h('div', { class: 'popup-title' }, 'Number format'),
      h('div', { class: 'col' }, ...radios),
      h('div', { class: 'row' }, precisionLabel, precision, fullLabel),
      squeezeLabel,
      h('div', { class: 'muted small' }, 'Sorting, filters and Copy use the exact values. Hover a value to see it exactly.'),
      h('div', { class: 'row end' }, h('button', { onclick: () => (table.setFormat(undefined), table.closePopup(true)), title: 'Use the format from the settings (gdx.numberFormat)' }, 'Use Defaults')),
    );
    return { content, focus: () => radios.find((l) => l.querySelector('input').checked).querySelector('input').focus() };
  }

  /** Title attribute for a formatted cell: its exact value, if the format changed it. */
  const exactTitle = (row, i) => (row.exact && row.exact[i] !== row.cells[i] ? row.exact[i] : undefined);

  // Search ------------------------------------------------------------------

  /**
   * Same rules as src/search.ts: case-insensitive; * and ? are wildcards unless `regex`;
   * `exact` matches whole cells. Returns undefined (empty), a RegExp, or { error }.
   */
  function compileSearch(search) {
    const text = (search && search.text) || '';
    if (text.trim() === '') return undefined;
    let source = search.regex ? text : text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    if (search.exact) source = '^(?:' + source + ')$';
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      return { error: String((err && err.message) || err).replace(/^Invalid regular expression: /, '') };
    }
  }

  /**
   * A search field with toggle buttons (like GAMS Studio's): exact match, regular expression
   * and optional extra toggles, e.g. "all columns" or "filter rows".
   * @param {{ placeholder: string, label: string, toggles: { key: string, text: string | Node, title: string }[], value: any, onChange: (value: any) => void, onKeyDown?: (e: KeyboardEvent) => void }} o
   */
  function searchBox(o) {
    const value = Object.assign({ text: '' }, o.value || {});
    const input = h('input', { type: 'search', placeholder: o.placeholder, 'aria-label': o.label, value: value.text || '' });
    const fire = () => o.onChange(Object.assign({}, value));
    input.addEventListener('input', debounce(() => ((value.text = input.value), fire()), 200));
    if (o.onKeyDown) input.addEventListener('keydown', o.onKeyDown);
    const buttons = o.toggles.map((t) => {
      const b = h('button', { class: 'toggle', title: t.title, 'aria-label': t.title, 'aria-pressed': String(!!value[t.key]) }, t.text);
      b.addEventListener('click', () => {
        value[t.key] = !value[t.key];
        b.setAttribute('aria-pressed', String(value[t.key]));
        fire();
      });
      return b;
    });
    const el = h('span', { class: 'searchbox' }, input, h('span', { class: 'toggles' }, ...buttons));
    return {
      el,
      input,
      value,
      set(v) {
        Object.assign(value, { text: '' }, v || {});
        for (const k of Object.keys(value)) if (k !== 'text' && !(v && k in v)) value[k] = false;
        input.value = value.text || '';
        o.toggles.forEach((t, i) => buttons[i].setAttribute('aria-pressed', String(!!value[t.key])));
      },
      setError(msg) {
        input.classList.toggle('invalid', !!msg);
        input.title = msg ? 'Invalid regular expression: ' + msg : '';
      },
    };
  }

  const EXACT = { key: 'exact', text: '[ab]', title: 'Exact match: the whole cell must match' };
  const REGEX = { key: 'regex', text: '.*', title: 'Regular expression (otherwise * and ? are wildcards)' };

  // Table -------------------------------------------------------------------

  const DEFAULT_STATE = () => ({
    search: { text: '' },
    columnFilters: [],
    sortColumn: undefined,
    sortDescending: false,
    hidden: [],
    page: 0,
    view: 'list',
    rowDims: undefined,
    colDims: undefined,
    colPage: 0,
    format: undefined,
    /** Column widths set by the user (px), by column key. */
    colWidths: {},
    /** Column order of the list view (all column indexes), undefined for the natural order. */
    order: undefined,
  });

  /**
   * A table whose rows live in the extension host. It asks for pages through
   * `onQuery(state)`, for the labels of a column through `onColumnValues(column)`,
   * and renders the answers with `show(page)` and `showColumnValues(message)`.
   */
  class GdxTable {
    /**
     * @param {{ onQuery: (q: any) => void, onColumnValues: (column: number) => void, onCopy: (req: any) => void, tools?: Node[], filterPlaceholder?: string, pivot?: boolean }} options
     */
    constructor(options) {
      this.onQuery = options.onQuery;
      this.onCopy = options.onCopy;
      /** Called when the state changed without a query (e.g. column widths). */
      this.onStateChange = options.onStateChange || (() => {});
      this.lastPage = null;
      this.suppressClickUntil = 0;
      /** Selected cells: { anchor: {r, c}, focus: {r, c} } in positions of the whole view, { all: true }, or null. */
      this.sel = null;
      this.cellMap = new Map();
      this.highlighted = [];
      this.extent = { kind: 'list', rows: 0, cols: 0, r0: 0, r1: -1, c0: 0, c1: -1 };
      this.dragging = false;
      this.lastCopy = 0;
      this.onColumnValues = options.onColumnValues;
      this.pivotSupported = !!options.pivot;
      this.state = DEFAULT_STATE();
      this.columns = [];
      this.dims = 0;
      this.popup = null;
      this.pendingValues = null;

      /** Search info of the last page ({ count, hits, current, error }) and the current match. */
      this.searchInfo = null;
      this.findCurrent = undefined;
      this.pendingFind = undefined;
      this.search = searchBox({
        placeholder: options.filterPlaceholder || 'Search records…',
        label: 'Search records',
        toggles: [EXACT, REGEX, { key: 'filterRows', text: funnelIcon(), title: 'Filter rows: show only rows with a match (otherwise matches are highlighted)' }],
        value: this.state.search,
        onChange: (v) => {
          this.state.search = v;
          this.findCurrent = undefined;
          if (v.filterRows || !v.text) {
            this.state.page = 0;
            this.query();
          } else {
            this.find(0);
          }
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.findNext(e.shiftKey ? -1 : 1);
          }
        },
      });
      this.filterInput = this.search.input;
      this.findLabel = h('span', { class: 'count find-count', 'aria-live': 'polite' });
      this.prevButton = h('button', { class: 'toggle', title: 'Previous match (Shift+F3)', 'aria-label': 'Previous match', onclick: () => this.findNext(-1) }, '↑');
      this.nextButton = h('button', { class: 'toggle', title: 'Next match (F3)', 'aria-label': 'Next match', onclick: () => this.findNext(1) }, '↓');
      this.findNav = h('span', { class: 'find-nav' }, this.findLabel, this.prevButton, this.nextButton);
      this.countLabel = h('span', { class: 'count' });
      this.selLabel = h('span', { class: 'count sel-count' });
      this.listButton = h('button', { class: 'seg', 'aria-pressed': 'true', title: 'One row per record', onclick: () => this.setView('list') }, 'List');
      this.tableButton = h('button', { class: 'seg', 'aria-pressed': 'false', title: 'Rows and columns by dimension', onclick: () => this.setView('table') }, 'Table');
      this.viewToggle = h('span', { class: 'segmented', role: 'group', 'aria-label': 'View' }, this.listButton, this.tableButton);
      this.fieldsButton = h('button', { title: 'Choose the fields to show', onclick: () => this.openFields() }, 'Fields ▾');
      this.formatButton = h('button', { title: 'Number format and precision', onclick: () => this.openFormat() }, 'Format ▾');
      this.clearButton = h('button', { title: 'Remove all column filters', onclick: () => this.clearFilters() }, 'Clear filters');
      this.resetButton = h('button', { title: 'Reset filters, sorting, fields and layout', onclick: () => this.resetView() }, 'Reset');
      this.chipBar = h('div', { class: 'chipbar' });
      this.scroll = h('div', { class: 'scroll' });
      this.pager = h('div', { class: 'pager' });
      this.el = h(
        'div',
        { class: 'gdx-table' },
        h(
          'div',
          { class: 'toolbar' },
          this.search.el,
          this.findNav,
          this.countLabel,
          this.selLabel,
          h('span', { class: 'spacer' }),
          this.viewToggle,
          this.fieldsButton,
          this.formatButton,
          this.clearButton,
          this.resetButton,
          ...(options.tools || []),
        ),
        this.chipBar,
        this.scroll,
        this.pager,
      );
      this.updateToolbar();
      this.installSelection();
    }

    // Cell selection and copying ----------------------------------------------

    installSelection() {
      const sc = this.scroll;
      sc.tabIndex = 0;
      sc.setAttribute('aria-label', 'Records. Arrow keys move, Shift extends the selection, Ctrl+A selects all, Ctrl+C copies.');
      const cellOf = (el) => {
        const td = el && el.closest && el.closest('[data-r]');
        return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null;
      };
      sc.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('button, input, .resize')) return;
        const cell = cellOf(t);
        const rowSel = t.closest('[data-row]');
        const colSel = t.closest('[data-c0]');
        if (!cell && !rowSel && !colSel) return;
        e.preventDefault();
        sc.focus({ preventScroll: true });
        const ext = this.extent;
        if (cell) {
          this.select(e.shiftKey && this.sel && this.sel.anchor ? this.sel.anchor : cell, cell);
          this.dragging = true;
        } else if (rowSel) {
          const r = Number(/** @type {HTMLElement} */ (rowSel).dataset.row);
          const from = e.shiftKey && this.sel && this.sel.anchor ? this.sel.anchor.r : r;
          this.select({ r: from, c: 0 }, { r, c: ext.cols - 1 });
        } else if (colSel) {
          const el = /** @type {HTMLElement} */ (colSel);
          const c0 = Number(el.dataset.c0);
          const c1 = Number(el.dataset.c1);
          const from = e.shiftKey && this.sel && this.sel.anchor ? this.sel.anchor.c : c0;
          this.select({ r: 0, c: Math.min(from, c0) }, { r: ext.rows - 1, c: Math.max(from, c1) });
        }
      });
      sc.addEventListener('mouseover', (e) => {
        if (!this.dragging || !this.sel || !this.sel.anchor) return;
        const cell = cellOf(e.target);
        if (cell) this.select(this.sel.anchor, cell);
      });
      document.addEventListener('mouseup', () => (this.dragging = false));
      sc.addEventListener('keydown', (e) => this.onTableKey(e));
      sc.addEventListener('contextmenu', (e) => {
        const cell = cellOf(e.target);
        if (!cell && !this.sel) return;
        e.preventDefault();
        if (cell && !this.isSelected(cell)) this.select(cell, cell);
        this.openContextMenu(e.clientX, e.clientY);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'F3') {
          e.preventDefault();
          this.findNext(e.shiftKey ? -1 : 1);
        }
      });
      // VS Code runs its copy command in the webview (a "copy" event) for Ctrl+C.
      document.addEventListener('copy', (e) => {
        if (!this.sel || !(document.activeElement === sc || sc.contains(document.activeElement))) return;
        e.preventDefault();
        if (Date.now() - this.lastCopy > 300) this.copy('tab', true);
      });
    }

    /** Highlights the matches on the page and updates the counter. */
    paintSearch(info) {
      this.searchInfo = info || null;
      const s = this.state.search || {};
      const active = !!s.text && !s.filterRows;
      this.search.setError(info && info.error);
      this.findNav.hidden = !active;
      if (!info || !active) return;
      if (info.current) this.findCurrent = info.current.index;
      const cur = info.current ? info.current.hit : null;
      const same = (a, b) => a && b && a.r === b.r && a.c === b.c && (a.kind || '') === (b.kind || '');
      let curEl = null;
      for (const hit of info.hits) {
        let el;
        if (hit.kind === 'row') el = this.rowHeadMap.get(hit.r + ',' + hit.c);
        else if (hit.kind === 'col') {
          const range = (this.colHeadRanges[hit.r] || []).find((x) => hit.c >= x.c0 && hit.c <= x.c1);
          el = range && range.el;
        } else el = this.cellMap.get(hit.r + ',' + hit.c);
        if (!el) continue;
        el.classList.add('hit');
        if (same(hit, cur)) {
          el.classList.add('hit-cur');
          curEl = el;
        }
      }
      if (curEl) curEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.findLabel.textContent = info.error
        ? 'Invalid expression'
        : !info.count
          ? 'No results'
          : this.findCurrent !== undefined
            ? fmt.format(this.findCurrent + 1) + ' of ' + fmt.format(info.count)
            : plural(info.count, 'match').replace('matchs', 'matches');
      this.findLabel.classList.toggle('find-error', !!info.error);
      this.prevButton.disabled = this.nextButton.disabled = !info.count;
    }

    isSelected(cell) {
      if (!this.sel) return false;
      if (this.sel.all) return true;
      const { anchor: a, focus: f } = this.sel;
      return cell.r >= Math.min(a.r, f.r) && cell.r <= Math.max(a.r, f.r) && cell.c >= Math.min(a.c, f.c) && cell.c <= Math.max(a.c, f.c);
    }

    select(anchor, focus) {
      this.sel = anchor ? { anchor, focus } : null;
      this.paintSelection();
    }

    selectAll() {
      if (!this.extent.rows || !this.extent.cols) return;
      this.sel = { all: true };
      this.paintSelection();
      // VS Code may also run "select all" on the page's text.
      setTimeout(() => window.getSelection() && window.getSelection().removeAllRanges(), 0);
    }

    /** The selection as sent to the extension (whole-view positions). */
    selectionRequest() {
      if (!this.sel) return null;
      if (this.sel.all) return { all: true };
      const { anchor: a, focus: f } = this.sel;
      return { rows: [Math.min(a.r, f.r), Math.max(a.r, f.r)], cols: [Math.min(a.c, f.c), Math.max(a.c, f.c)] };
    }

    /** Copies the selection; without a selection nothing, or everything if `everything` is set. */
    copy(separator, labels, everything) {
      const selection = this.selectionRequest() || (everything ? { all: true } : null);
      if (!selection) return;
      this.lastCopy = Date.now();
      this.onCopy({ selection, separator, labels: labels !== false, query: JSON.parse(JSON.stringify(this.state)) });
    }

    paintSelection() {
      for (const el of this.highlighted) el.classList.remove('sel', 'cur');
      this.highlighted = [];
      const ext = this.extent;
      let count = 0;
      if (this.sel) {
        const all = !!this.sel.all;
        const a = all ? { r: 0, c: 0 } : this.sel.anchor;
        const f = all ? { r: ext.rows - 1, c: ext.cols - 1 } : this.sel.focus;
        const [r0, r1] = [Math.max(Math.min(a.r, f.r), ext.r0), Math.min(Math.max(a.r, f.r), ext.r1)];
        const [c0, c1] = [Math.max(Math.min(a.c, f.c), ext.c0), Math.min(Math.max(a.c, f.c), ext.c1)];
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const el = this.cellMap.get(r + ',' + c);
            if (el) {
              el.classList.add('sel');
              this.highlighted.push(el);
            }
          }
        }
        if (!all) {
          const cur = this.cellMap.get(f.r + ',' + f.c);
          if (cur) {
            cur.classList.add('cur');
            this.highlighted.push(cur);
          }
        }
        count = all ? ext.rows * ext.cols : (Math.abs(a.r - f.r) + 1) * (Math.abs(a.c - f.c) + 1);
      }
      this.selLabel.textContent = !this.sel ? '' : this.sel.all ? '· all ' + fmt.format(count) + ' cells selected' : count > 1 ? '· ' + fmt.format(count) + ' cells selected' : '';
    }

    onTableKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selectAll();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this.copy('tab', true);
        return;
      }
      if (e.key === 'Escape' && this.sel) {
        this.select(null);
        return;
      }
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -Infinity], End: [0, Infinity] };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const ext = this.extent;
      if (ext.r1 < ext.r0 || ext.c1 < ext.c0) return;
      const from = this.sel && this.sel.focus ? this.sel.focus : null;
      const clampR = (r) => Math.min(ext.r1, Math.max(ext.r0, r));
      const clampC = (c) => Math.min(ext.c1, Math.max(ext.c0, c));
      const focus = from ? { r: clampR(from.r + move[0]), c: clampC(from.c + move[1]) } : { r: ext.r0, c: ext.c0 };
      const anchor = e.shiftKey && this.sel && this.sel.anchor ? this.sel.anchor : focus;
      this.select(anchor, focus);
      const el = this.cellMap.get(focus.r + ',' + focus.c);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    openContextMenu(x, y) {
      const pivot = this.extent.kind === 'pivot';
      const item = (label, key, run) =>
        h('button', { class: 'menu-item', role: 'menuitem', onclick: () => (this.closePopup(true), run()) }, h('span', null, label), key ? h('span', { class: 'key-hint' }, key) : null);
      const items = [
        item('Copy (tab-separated)', 'Ctrl+C', () => this.copy('tab', true)),
        item('Copy (comma-separated)', '', () => this.copy('comma', true)),
        pivot ? item('Copy without labels (tab-separated)', '', () => this.copy('tab', false)) : null,
        pivot ? item('Copy without labels (comma-separated)', '', () => this.copy('comma', false)) : null,
        h('div', { class: 'menu-sep', role: 'separator' }),
        item('Select all', 'Ctrl+A', () => this.selectAll()),
        item('Auto-fit columns', '', () => this.autoFit()),
      ].filter(Boolean);
      const menu = h('div', { class: 'menu', role: 'menu' }, ...items);
      menu.addEventListener('keydown', (e) => {
        const buttons = [...menu.querySelectorAll('button')];
        const i = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
        }
      });
      const point = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false, focus: () => this.scroll.focus() };
      this.closePopup();
      this.popup = openPopup(point, menu, { label: 'Copy' });
      /** @type {HTMLElement} */ (menu.querySelector('button')).focus();
    }

    // Column widths ------------------------------------------------------------

    /** Makes a header cell resizable; `key` identifies the column in the saved widths. */
    sizable(th, key) {
      th.dataset.wkey = key;
      th.classList.add('sizable');
      const handle = h('span', { class: 'resize', title: 'Drag to resize; double-click to fit the content', 'aria-hidden': 'true' });
      handle.addEventListener('mousedown', (e) => this.startResize(e, th));
      handle.addEventListener('click', (e) => e.stopPropagation());
      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        delete this.state.colWidths[key];
        this.onStateChange();
        this.rerender();
      });
      th.append(handle);
      return th;
    }

    /** The header row with one cell per column (the last one). */
    leafRow(table) {
      return table.tHead ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    }

    /** Switches the table to fixed column widths: the current widths, except those set by the user. */
    freeze(table) {
      if (table.classList.contains('fixed')) return;
      const leaf = this.leafRow(table);
      if (!leaf) return;
      const widths = [...leaf.cells].map((c) => this.state.colWidths[c.dataset.wkey] || c.getBoundingClientRect().width);
      const group = h('colgroup', null, ...widths.map(() => h('col')));
      [...group.children].forEach((col, i) => (/** @type {HTMLElement} */ (col).style.width = widths[i] + 'px'));
      table.insertBefore(group, table.firstChild);
      table.classList.add('fixed');
      table.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
    }

    /** Applies saved column widths after rendering. */
    applyWidths(table) {
      const leaf = this.leafRow(table);
      if (leaf && [...leaf.cells].some((c) => this.state.colWidths[c.dataset.wkey])) this.freeze(table);
    }

    startResize(e, th) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const table = th.closest('table');
      this.freeze(table);
      const index = [...th.parentElement.cells].indexOf(th);
      const col = /** @type {HTMLElement} */ (table.querySelector('colgroup').children[index]);
      const startX = e.clientX;
      const start = parseFloat(col.style.width);
      const tableStart = parseFloat(table.style.width);
      this.suppressClickUntil = Infinity;
      th.classList.add('resizing');
      const move = (ev) => {
        const w = Math.max(24, start + ev.clientX - startX);
        col.style.width = w + 'px';
        table.style.width = tableStart + (w - start) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        th.classList.remove('resizing');
        this.suppressClickUntil = Date.now() + 300;
        this.state.colWidths[th.dataset.wkey] = Math.round(parseFloat(col.style.width));
        this.onStateChange();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    /** Moves column `from` before (or after) column `to` in the list view; indexes of all columns. */
    moveColumn(from, to, after) {
      const p = this.lastPage;
      if (!p || p.kind !== 'list' || from === to) return;
      // The current order: the shown columns, then the hidden ones.
      const shown = p.columnIndex;
      const order = [...shown, ...p.allColumns.map((_, i) => i).filter((i) => !shown.includes(i))].filter((i) => i !== from);
      const at = order.indexOf(to);
      if (at < 0) return;
      order.splice(after ? at + 1 : at, 0, from);
      this.state.order = order.every((c, i) => c === i) ? undefined : order;
      this.query();
    }

    /** Header cell drag and drop for reordering columns. */
    reorderable(th, ci) {
      th.draggable = true;
      th.addEventListener('dragstart', (e) => {
        // Resizing a column starts on its handle and must not move it.
        if (/** @type {HTMLElement} */ (e.target).closest && /** @type {HTMLElement} */ (e.target).closest('.resize')) {
          e.preventDefault();
          return;
        }
        this.dragColumn = ci;
        e.dataTransfer.setData('text/plain', 'column ' + ci);
        e.dataTransfer.effectAllowed = 'move';
        th.classList.add('dragging');
      });
      th.addEventListener('dragend', () => {
        this.dragColumn = undefined;
        th.classList.remove('dragging');
        th.closest('tr').querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
      });
      const after = (e) => {
        const r = th.getBoundingClientRect();
        return e.clientX > r.left + r.width / 2;
      };
      th.addEventListener('dragover', (e) => {
        if (this.dragColumn === undefined || this.dragColumn === ci) return;
        e.preventDefault();
        th.classList.toggle('drop-after', after(e));
        th.classList.toggle('drop-before', !after(e));
      });
      th.addEventListener('dragleave', () => th.classList.remove('drop-before', 'drop-after'));
      th.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = this.dragColumn;
        th.classList.remove('drop-before', 'drop-after');
        if (from !== undefined) this.moveColumn(from, ci, after(e));
      });
      return th;
    }

    /** Fits all columns to their content again. */
    autoFit() {
      this.state.colWidths = {};
      this.onStateChange();
      this.rerender();
    }

    rerender() {
      if (this.lastPage) this.show(this.lastPage);
    }

    focusSearch() {
      this.filterInput.focus();
      this.filterInput.select();
    }

    /** Shows match `index` of the search (the extension changes pages as needed). */
    find(index) {
      this.pendingFind = index;
      this.query();
    }

    findNext(dir) {
      const s = this.state.search;
      if (!s || !s.text || s.filterRows) return;
      const count = this.searchInfo ? this.searchInfo.count : 0;
      if (!count) return;
      this.find(this.findCurrent === undefined ? (dir > 0 ? 0 : -1) : this.findCurrent + dir);
    }

    /** True if the rows or columns of the view changed since the last call (not when paging). */
    shapeChanged() {
      const s = this.state;
      const rowSearch = s.search && s.search.filterRows ? s.search : null;
      const key = JSON.stringify([rowSearch, s.columnFilters, s.sortColumn, s.sortDescending, s.hidden, s.view, s.rowDims, s.colDims, s.order]);
      if (key !== this.shapeKey) {
        this.shapeKey = key;
        return true;
      }
      return false;
    }

    /** Restores a saved state (or the defaults), e.g. when switching symbols. */
    reset(state) {
      this.closePopup();
      this.state = Object.assign(DEFAULT_STATE(), state || {});
      // Saved by older versions: a text filter (which filtered rows).
      if (typeof this.state.filter === 'string') {
        if (this.state.filter && !(this.state.search && this.state.search.text)) this.state.search = { text: this.state.filter, filterRows: true };
        delete this.state.filter;
      }
      if (!this.state.colWidths) this.state.colWidths = {};
      this.search.set(this.state.search);
      this.state.search = this.search.value;
      this.findCurrent = undefined;
      this.searchInfo = null;
      this.columns = [];
      this.sel = null;
      this.shapeKey = undefined;
      this.updateToolbar();
    }

    /** The number of dimensions of the shown symbol; the table view needs at least two. */
    setDimension(n) {
      this.dims = n;
      if (this.state.view === 'table' && !this.canPivot()) this.state.view = 'list';
      this.updateToolbar();
    }

    canPivot() {
      return this.pivotSupported && this.dims >= 2;
    }

    query() {
      if (this.shapeChanged()) {
        this.sel = null;
        this.findCurrent = undefined;
      }
      this.el.classList.add('loading');
      const q = JSON.parse(JSON.stringify(this.state));
      if (this.pendingFind !== undefined) q.findIndex = this.pendingFind;
      this.pendingFind = undefined;
      this.onQuery(q);
    }

    showMessage(text, cls) {
      this.closePopup();
      this.el.classList.remove('loading');
      this.scroll.replaceChildren(h('div', { class: cls || 'empty' }, text));
      this.pager.replaceChildren();
      this.chipBar.hidden = true;
      this.countLabel.textContent = '';
      this.cellMap = new Map();
      this.highlighted = [];
      this.extent = { kind: 'list', rows: 0, cols: 0, r0: 0, r1: -1, c0: 0, c1: -1 };
      this.selLabel.textContent = '';
      this.rowHeadMap = new Map();
      this.colHeadRanges = [];
    }

    setView(view) {
      if (view === this.state.view || (view === 'table' && !this.canPivot())) return;
      this.state.view = view;
      this.state.page = 0;
      this.state.colPage = 0;
      this.updateToolbar();
      this.query();
    }

    filterFor(col) {
      return this.state.columnFilters.find((f) => f.column === col);
    }

    setFilter(col, filter) {
      this.state.columnFilters = this.state.columnFilters.filter((f) => f.column !== col);
      if (filter) this.state.columnFilters.push(filter);
      this.state.page = 0;
      this.state.colPage = 0;
      this.query();
    }

    clearFilters() {
      this.state.columnFilters = [];
      this.state.page = 0;
      this.state.colPage = 0;
      this.query();
    }

    resetView() {
      const keepSearch = this.state.search;
      this.state = Object.assign(DEFAULT_STATE(), { search: keepSearch });
      this.query();
    }

    closePopup(refocus) {
      if (this.popup) {
        this.popup.close(refocus);
        this.popup = null;
      }
      this.pendingValues = null;
    }

    isValueColumn(i) {
      const c = this.columns[i];
      return !!c && (c.kind === 'value' || c.kind === 'text');
    }

    openFilter(col, anchor) {
      const c = this.columns[col];
      if (!c) return;
      const current = this.filterFor(col);
      const view = c.kind === 'value' ? rangeFilterContent(this, col, c.name, current) : labelFilterContent(this, col, c.name, current);
      this.popup = openPopup(anchor, view.content, { label: `Filter ${c.name}` });
      if (view.setValues) {
        this.pendingValues = { column: col, view };
        this.onColumnValues(col);
      }
      view.focus();
    }

    showColumnValues(m) {
      if (this.pendingValues && this.pendingValues.column === m.column) {
        this.pendingValues.view.setValues(m);
        if (this.popup) this.popup.place();
      }
    }

    setFormat(format) {
      this.state.format = format;
      this.query();
    }

    openFormat() {
      const view = formatContent(this);
      this.closePopup();
      this.popup = openPopup(this.formatButton, view.content, { label: 'Number format' });
      view.focus();
    }

    openFields() {
      const values = this.columns.map((c, i) => i).filter((i) => this.isValueColumn(i));
      const squeezedNow = new Set((this.squeezeInfo && this.squeezeInfo.columns) || []);
      const hidden = new Set(this.state.hidden);
      const boxes = values.map((i) => {
        const box = h('input', {
          type: 'checkbox',
          onchange: () => {
            const on = boxes.filter((b) => b.checked);
            if (!on.length) {
              box.checked = true;
              return;
            }
            // Squeezed fields are hidden by squeezing, not by the user's choice.
            this.state.hidden = values.filter((v, k) => !boxes[k].checked && !squeezedNow.has(v));
            this.state.colPage = 0;
            this.query();
          },
        });
        box.checked = !hidden.has(i);
        return box;
      });
      const squeeze = this.squeezeInfo || { available: false, active: false, columns: [] };
      const squeezed = new Set(squeeze.columns);
      values.forEach((i, k) => {
        if (squeezed.has(i)) {
          boxes[k].disabled = true;
          boxes[k].checked = false;
        }
      });
      const squeezeBox = h('input', {
        type: 'checkbox',
        onchange: () => {
          this.state.squeeze = squeezeBox.checked;
          this.state.colPage = 0;
          this.closePopup(true);
          this.query();
        },
      });
      squeezeBox.checked = !!squeeze.active;
      const content = h(
        'div',
        { class: 'filter-popup' },
        h('div', { class: 'popup-title' }, 'Fields'),
        ...values.map((i, k) =>
          h(
            'label',
            { class: 'check' + (squeezed.has(i) ? ' disabled' : ''), title: squeezed.has(i) ? 'Hidden: default value in every record' : undefined },
            boxes[k],
            this.columns[i].name + (squeezed.has(i) ? ' (defaults only)' : ''),
          ),
        ),
        squeeze.available
          ? h(
              'label',
              { class: 'check sep-above', title: 'Hide fields that have the default value of the variable or equation type in every record (setting gdx.squeezeDefaults)' },
              squeezeBox,
              'Squeeze defaults',
            )
          : null,
      );
      this.closePopup();
      this.popup = openPopup(this.fieldsButton, content, { label: 'Fields' });
      if (boxes[0]) boxes[0].focus();
    }

    updateToolbar() {
      const table = this.state.view === 'table';
      this.viewToggle.hidden = !this.canPivot();
      this.listButton.setAttribute('aria-pressed', String(!table));
      this.tableButton.setAttribute('aria-pressed', String(table));
      this.fieldsButton.hidden = this.columns.filter((_, i) => this.isValueColumn(i)).length < 2;
      this.formatButton.hidden = !this.columns.some((c) => c.kind === 'value');
      this.formatButton.classList.toggle('active', !!this.state.format);
      const n = this.state.columnFilters.length;
      this.clearButton.hidden = n === 0;
      this.clearButton.textContent = `Clear filters (${n})`;
    }

    filterButton(col, name) {
      const active = !!this.filterFor(col);
      const btn = h(
        'button',
        {
          class: 'funnel' + (active ? ' active' : ''),
          title: active ? `Change the filter on ${name}` : `Filter ${name}`,
          'aria-label': active ? `Change the filter on ${name}` : `Filter ${name}`,
          onclick: (e) => {
            e.stopPropagation();
            this.openFilter(col, btn);
          },
          onkeydown: (e) => e.stopPropagation(),
        },
        funnelIcon(),
      );
      return btn;
    }

    /** Renders a page sent by the host (list or pivot). */
    show(p) {
      this.lastPage = p;
      this.el.classList.remove('loading');
      this.columns = p.allColumns;
      this.effectiveFormat = p.format;
      this.squeezeInfo = p.squeeze;
      this.state.page = p.page;
      if (p.kind === 'pivot') {
        this.state.rowDims = p.rowDims;
        this.state.colDims = p.colDims;
        this.state.colPage = p.colPage;
        this.shapeChanged();
        this.renderPivot(p);
      } else {
        this.renderList(p);
      }
      this.updateToolbar();
      this.paintSelection();
      this.paintSearch(p.search);
    }

    sortBy(col) {
      if (this.state.sortColumn === col) {
        if (this.state.sortDescending) {
          this.state.sortColumn = undefined;
          this.state.sortDescending = false;
        } else {
          this.state.sortDescending = true;
        }
      } else {
        this.state.sortColumn = col;
        this.state.sortDescending = false;
      }
      this.state.page = 0;
      this.query();
    }

    renderList(p) {
      this.chipBar.hidden = true;
      this.rowHeadMap = new Map();
      this.colHeadRanges = [];
      const header = h(
        'tr',
        null,
        h('th', { class: 'rownum', title: 'Record number' }, '#'),
        ...p.columnIndex.map((ci, pos) => {
          const c = p.allColumns[ci];
          const sorted = this.state.sortColumn === ci;
          // Like GAMS Studio: the original position of each index, which matters once columns are moved.
          const keyPos = c.kind === 'key' ? p.allColumns.slice(0, ci + 1).filter((x) => x.kind === 'key').length : 0;
          const th = h(
            'th',
            {
              class: c.kind + (this.filterFor(ci) ? ' filtered' : ''),
              tabindex: 0,
              title: 'Sort by ' + c.name + '; drag to move the column (or Alt+←/→)',
              'aria-sort': sorted ? (this.state.sortDescending ? 'descending' : 'ascending') : undefined,
              // A click that ends a column resize does not sort.
              onclick: () => Date.now() > this.suppressClickUntil && this.sortBy(ci),
              onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  this.sortBy(ci);
                } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                  e.preventDefault();
                  // Not also a cell navigation of the table.
                  e.stopPropagation();
                  const left = e.key === 'ArrowLeft';
                  const next = p.columnIndex[pos + (left ? -1 : 1)];
                  if (next !== undefined) {
                    this.refocusColumn = ci;
                    this.moveColumn(ci, next, !left);
                  }
                }
              },
            },
            h('span', { class: 'th' }, c.name, keyPos ? h('sup', { class: 'pos', title: 'Index position ' + keyPos }, String(keyPos)) : null, sorted ? h('span', { class: 'arrow' }, this.state.sortDescending ? '▼' : '▲') : null, this.filterButton(ci, c.name)),
          );
          th.dataset.col = String(ci);
          return this.reorderable(this.sizable(th, 'c' + ci), ci);
        }),
      );
      const body = h('tbody');
      this.cellMap = new Map();
      this.highlighted = [];
      this.extent = { kind: 'list', rows: p.filteredCount, cols: p.columnIndex.length, r0: p.offset, r1: p.offset + p.rows.length - 1, c0: 0, c1: p.columnIndex.length - 1 };
      p.rows.forEach((row, r) => {
        const marks = new Set(row.marks || []);
        const abs = p.offset + r;
        const tr = h('tr', { class: row.cls }, h('td', { class: 'rownum', dataset: { row: String(abs) }, title: 'Select the row' }, String(abs + 1)));
        row.cells.forEach((v, i) => {
          const c = p.allColumns[p.columnIndex[i]] || { kind: 'value' };
          let cls = c.kind;
          if (c.kind === 'value' && SPECIAL.has(v.toLowerCase())) cls += ' special';
          if (marks.has(i)) cls += ' mark';
          if (c.side) cls += ' side' + c.side;
          const td = h('td', { class: cls, title: exactTitle(row, i), dataset: { r: String(abs), c: String(i) } }, v);
          this.cellMap.set(abs + ',' + i, td);
          tr.append(td);
        });
        body.append(tr);
      });
      const table = h('table', null, h('thead', null, header), body);
      fill(this.scroll, table, p.rows.length ? null : this.emptyNote(p));
      this.applyWidths(table);
      // Keep the keyboard focus on a column moved with Alt+arrow.
      if (this.refocusColumn !== undefined) {
        const th = /** @type {HTMLElement} */ (table.querySelector('th[data-col="' + this.refocusColumn + '"]'));
        this.refocusColumn = undefined;
        if (th) th.focus();
      }
      this.scroll.scrollTop = 0;
      this.countLabel.textContent =
        p.filteredCount === p.totalCount ? plural(p.totalCount, 'record') : `${fmt.format(p.filteredCount)} of ${plural(p.totalCount, 'record')}`;
      this.renderPager(p, null);
    }

    emptyNote(p) {
      return h('div', { class: 'empty' }, p.totalCount ? 'No records match the filters.' : 'This symbol has no records.');
    }

    // Table view -------------------------------------------------------------

    moveDim(dim, zone, pos) {
      const rows = this.state.rowDims.filter((d) => d !== dim);
      const cols = this.state.colDims.filter((d) => d !== dim);
      const target = zone === 'rows' ? rows : cols;
      target.splice(Math.max(0, Math.min(pos, target.length)), 0, dim);
      this.state.rowDims = rows;
      this.state.colDims = cols;
      this.state.page = 0;
      this.state.colPage = 0;
      this.query();
    }

    renderChips(p) {
      const chip = (dim, zone, pos) => {
        const c = p.allColumns[dim];
        const el = h(
          'span',
          {
            class: 'chip' + (this.filterFor(dim) ? ' filtered' : ''),
            draggable: 'true',
            tabindex: 0,
            role: 'button',
            dataset: { dim: String(dim) },
            title: `${c.name}: drag to rearrange; Enter moves it to the ${zone === 'rows' ? 'columns' : 'rows'}; Alt+←/→ reorders`,
            ondragstart: (e) => {
              e.dataTransfer.setData('text/plain', String(dim));
              e.dataTransfer.effectAllowed = 'move';
              this.dragDim = dim;
              el.classList.add('dragging');
            },
            ondragend: () => {
              this.dragDim = undefined;
              el.classList.remove('dragging');
              this.chipBar.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
            },
            ondblclick: () => this.moveDim(dim, zone === 'rows' ? 'cols' : 'rows', Infinity),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                this.moveDim(dim, zone === 'rows' ? 'cols' : 'rows', Infinity);
              } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault();
                this.moveDim(dim, zone, pos + (e.key === 'ArrowLeft' ? -1 : 1));
              }
            },
          },
          h('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
          c.name,
          this.filterButton(dim, c.name),
        );
        return el;
      };
      const zone = (name, dims, extra) => {
        const el = h('div', { class: 'zone', dataset: { zone: name } }, ...dims.map((d, i) => chip(d, name, i)), ...(extra || []));
        const positionFor = (x) => {
          const chips = [...el.querySelectorAll('.chip')];
          const i = chips.findIndex((c) => x < c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2);
          return i < 0 ? chips.length : i;
        };
        el.addEventListener('dragover', (e) => {
          if (this.dragDim === undefined) return;
          e.preventDefault();
          const chips = [...el.querySelectorAll('.chip')];
          const pos = positionFor(e.clientX);
          this.chipBar.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
          if (pos < chips.length) chips[pos].classList.add('drop-before');
          else el.classList.add('drop-end');
        });
        el.addEventListener('dragleave', (e) => {
          if (!el.contains(/** @type {Node} */ (e.relatedTarget))) {
            el.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
            el.classList.remove('drop-end');
          }
        });
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          if (this.dragDim === undefined) return;
          const dim = this.dragDim;
          let pos = positionFor(e.clientX);
          // Moving within the same zone: account for the chip's own old position.
          const own = dims.indexOf(dim);
          if (own >= 0 && own < pos) pos--;
          this.moveDim(dim, name, pos);
        });
        return el;
      };
      const valueChips = p.valueColumns.map((v) =>
        h('span', { class: 'chip fixed' + (this.filterFor(v) ? ' filtered' : ''), title: `${p.allColumns[v].name} (values)` }, p.allColumns[v].name, this.filterButton(v, p.allColumns[v].name)),
      );
      fill(
        this.chipBar,
        h('span', { class: 'zone-label' }, 'Rows'),
        zone('rows', p.rowDims),
        h(
          'button',
          {
            class: 'transpose',
            title: 'Swap rows and columns',
            'aria-label': 'Swap rows and columns',
            onclick: () => {
              [this.state.rowDims, this.state.colDims] = [this.state.colDims, this.state.rowDims];
              this.state.page = 0;
              this.state.colPage = 0;
              this.query();
            },
          },
          '⇄',
        ),
        h('span', { class: 'zone-label' }, 'Columns'),
        zone('cols', p.colDims, valueChips),
      );
      this.chipBar.hidden = false;
    }

    renderPivot(p) {
      this.renderChips(p);
      this.rowHeadMap = new Map();
      this.colHeadRanges = [];
      const cols = p.allColumns;
      const nRow = Math.max(1, p.rowDims.length);
      const levels = p.levels.length ? p.levels : [''];
      const thead = h('thead');
      levels.forEach((levelName, level) => {
        const last = level === levels.length - 1;
        const tr = h('tr');
        if (last) {
          if (p.rowDims.length) p.rowDims.forEach((d) => tr.append(this.sizable(h('th', { class: 'key corner' }, cols[d].name), 'r' + d)));
          else tr.append(this.sizable(h('th', { class: 'corner' }), 'r'));
        } else {
          tr.append(h('th', { class: 'corner level-name', colspan: nRow }, levelName));
        }
        // Merge neighbouring header cells with the same labels on this and all higher levels.
        let i = 0;
        while (i < p.headers.length) {
          let j = i + 1;
          const prefix = (k) => p.headers[k].slice(0, level + 1).join('\u0000');
          while (!last && j < p.headers.length && prefix(j) === prefix(i)) j++;
          const kind = p.cellKinds[i];
          const headEl = h(
              'th',
              {
                class: 'colhead ' + (last && p.levels[level] === 'Field' ? kind : 'key'),
                colspan: j - i > 1 ? j - i : undefined,
                title: `${p.headers[i][level] ?? ''}\nClick to select the column${j - i > 1 ? 's' : ''}`,
                dataset: { c0: String(p.colOffset + i), c1: String(p.colOffset + j - 1) },
              },
              p.headers[i][level] ?? '',
            );
          if (last) this.sizable(headEl, 'p:' + p.headers[i].join('\u0001'));
          tr.append(headEl);
          (this.colHeadRanges[level] = this.colHeadRanges[level] || []).push({ c0: p.colOffset + i, c1: p.colOffset + j - 1, el: headEl });
          i = j;
        }
        thead.append(tr);
      });
      const body = h('tbody');
      this.cellMap = new Map();
      this.highlighted = [];
      this.extent = { kind: 'pivot', rows: p.rowCount, cols: p.colCount, r0: p.offset, r1: p.offset + p.rows.length - 1, c0: p.colOffset, c1: p.colOffset + p.headers.length - 1 };
      let prev = null;
      p.rows.forEach((row, ri) => {
        const abs = p.offset + ri;
        const tr = h('tr');
        const selector = { row: String(abs) };
        if (p.rowDims.length) {
          let same = !!prev;
          row.labels.forEach((l, k) => {
            same = same && prev.labels[k] === l;
            const th = h('th', { class: 'key rowhead' + (same ? ' rep' : ''), scope: 'row', title: `${l}\nClick to select the row`, dataset: selector }, l);
            this.rowHeadMap.set(abs + ',' + k, th);
            tr.append(th);
          });
        } else {
          tr.append(h('th', { class: 'rowhead', dataset: selector }));
        }
        row.cells.forEach((v, i) => {
          let cls = p.cellKinds[i];
          if (v === '') cls += ' none';
          else if (cls === 'value' && SPECIAL.has(v.toLowerCase())) cls += ' special';
          const c = p.colOffset + i;
          const td = h('td', { class: cls, title: exactTitle(row, i), dataset: { r: String(abs), c: String(c) } }, v);
          this.cellMap.set(abs + ',' + c, td);
          tr.append(td);
        });
        body.append(tr);
        prev = row;
      });
      const table = h('table', { class: 'pivot' }, thead, body);
      fill(this.scroll, table, p.rows.length ? null : this.emptyNote(p));
      this.applyWidths(table);
      this.scroll.scrollTop = 0;
      this.scroll.scrollLeft = 0;
      const records = p.filteredCount === p.totalCount ? plural(p.totalCount, 'record') : `${fmt.format(p.filteredCount)} of ${plural(p.totalCount, 'record')}`;
      this.countLabel.textContent = `${records} · ${plural(p.rowCount, 'row')} × ${plural(p.colCount, 'column')}`;
      this.renderPager(p, p);
    }

    renderPager(p, pivot) {
      const parts = [];
      if (p.pageCount > 1) {
        const total = pivot ? pivot.rowCount : p.filteredCount;
        const shown = pivot ? pivot.rows.length : p.rows.length;
        parts.push(
          ...this.pagerButtons(
            p.page,
            p.pageCount,
            (page) => ((this.state.page = page), this.query()),
            `${pivot ? 'Rows' : 'Records'} ${fmt.format(p.offset + 1)}–${fmt.format(p.offset + shown)} of ${fmt.format(total)}`,
            pivot ? 'rows' : 'records',
          ),
        );
      }
      if (pivot && pivot.colPageCount > 1) {
        if (parts.length) parts.push(h('span', { class: 'sep' }));
        parts.push(
          ...this.pagerButtons(
            pivot.colPage,
            pivot.colPageCount,
            (page) => ((this.state.colPage = page), this.query()),
            `Columns ${fmt.format(pivot.colOffset + 1)}–${fmt.format(pivot.colOffset + pivot.headers.length)} of ${fmt.format(pivot.colCount)}`,
            'columns',
          ),
        );
      }
      this.pager.replaceChildren(...parts);
      this.pager.hidden = parts.length === 0;
    }

    pagerButtons(page, count, go, label, what) {
      return [
        h('button', { onclick: () => go(0), disabled: page === 0, title: `First page of ${what}`, 'aria-label': `First page of ${what}` }, '«'),
        h('button', { onclick: () => go(page - 1), disabled: page === 0, title: `Previous page of ${what}`, 'aria-label': `Previous page of ${what}` }, '‹'),
        h('span', { class: 'label' }, label),
        h('button', { onclick: () => go(page + 1), disabled: page >= count - 1, title: `Next page of ${what}`, 'aria-label': `Next page of ${what}` }, '›'),
        h('button', { onclick: () => go(count - 1), disabled: page >= count - 1, title: `Last page of ${what}`, 'aria-label': `Last page of ${what}` }, '»'),
      ];
    }
  }

  /**
   * True if the extension speaks the same message protocol as these scripts. After an
   * update installed without reloading the window, the old extension code keeps running.
   */
  function checkProtocol(m, app) {
    const expected = Number(app.dataset.protocol || 0);
    if (m.protocol === expected) return true;
    app.replaceChildren(
      h('div', { class: 'error' }, 'The GDX Viewer extension was updated, but this window still runs the previous version.'),
      h('div', { class: 'notice' }, 'Run "Developer: Reload Window" from the Command Palette (or restart VS Code) to finish the update.'),
    );
    return false;
  }

  const TYPE_NAMES = { Set: 'Set', Par: 'Parameter', Var: 'Variable', Equ: 'Equation', Alias: 'Alias' };

  /** Type including the subtype, e.g. "Positive Variable" or "Singleton Set". */
  function typeLabel(s) {
    const base = TYPE_NAMES[s.type] || s.type;
    if (!s.subtype) return base;
    const sub = { sos1: 'SOS1', sos2: 'SOS2', semicont: 'SemiCont', semiint: 'SemiInt' }[s.subtype] || s.subtype.charAt(0).toUpperCase() + s.subtype.slice(1);
    return sub + ' ' + base;
  }

  /** Signature like "x(i,j)" for a symbol. */
  function signature(s) {
    return s.dim ? `${s.name}(${s.domain.join(',')})` : s.name;
  }

  /** Arrow-key navigation within a list of focusable items. */
  function listKeyNav(container, selector) {
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...container.querySelectorAll(selector)].filter((el) => !el.hidden);
      const i = items.indexOf(/** @type {Element} */ (document.activeElement));
      const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
      if (next) {
        e.preventDefault();
        /** @type {HTMLElement} */ (next).focus();
        /** @type {HTMLElement} */ (next).click();
      }
    });
  }

  // @ts-ignore
  window.Gdx = { debounce, openPopup, typeLabel, h, fill, checkProtocol, compileSearch, searchBox, EXACT, REGEX, GdxTable, TYPE_NAMES, signature, listKeyNav, fmt };
})();
