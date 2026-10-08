// @ts-check
/* Webview script of the GDX viewer (custom editor for *.gdx). */
(function () {
  'use strict';
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { openPopup, debounce, typeLabel, h, fill, checkProtocol, compileSearch, searchBox, EXACT, REGEX, GdxTable, TYPE_NAMES, signature, listKeyNav, fmt } = window.Gdx;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const GROUPS = [
    ['Set', 'Sets'],
    ['Alias', 'Aliases'],
    ['Par', 'Parameters'],
    ['Var', 'Variables'],
    ['Equ', 'Equations'],
  ];

  /** Per symbol: filters, sorting, view and layout (like GAMS Studio, as long as the viewer is open). */
  /** @type {{ selected?: string, symbolSearch?: any, symbolSort?: { key: string, desc: boolean }, grouped?: boolean, states?: Record<string, any>, exportOptions?: any, code?: { language: string, applyView: boolean }, report?: boolean }} */
  let saved = vscode.getState() || {};
  let states = saved.states || {};
  /** True once a view was restored (from the webview or the extension's saved state). */
  let restored = !!saved.selected;
  let file = null;
  let selected = saved.selected;
  /** The solution report is shown instead of the selected symbol (kept while the webview is reloaded, not when the file is opened again). */
  let reportOpen = !!saved.report;
  const MAX_STATES = 200;
  /** Type and dimension of a symbol: its saved view only applies while they stay the same. */
  const signatureOf = (name) => {
    const s = file && file.symbols.find((x) => x.name === name);
    return s ? s.type + '/' + s.dim : undefined;
  };
  // The extension keeps the view for the next time the file is opened.
  const persist = debounce(() => vscode.postMessage({ type: 'saveState', state: saved }), 800);
  const save = () => {
    if (selected) {
      delete states[selected];
      states[selected] = Object.assign({}, table.state, { sig: signatureOf(selected) });
      const names = Object.keys(states);
      names.slice(0, Math.max(0, names.length - MAX_STATES)).forEach((n) => delete states[n]);
    }
    // The last choices of the Export and Copy as Code dialogs are kept, and whether the solution report is shown.
    vscode.setState((saved = { selected, symbolSearch: symbolSearch.value, symbolSort, grouped: groupBox.checked, states, exportOptions: saved.exportOptions, code: saved.code, report: reportOpen }));
    persist();
  };

  /** Applies a view saved by the extension (when the webview has none of its own). */
  function restore(v) {
    if (!v || typeof v !== 'object') return;
    states = v.states || {};
    selected = v.selected;
    if (v.symbolSearch) symbolSearch.set(v.symbolSearch);
    if (v.symbolSort) symbolSort = v.symbolSort;
    groupBox.checked = !!v.grouped;
  }

  /** The saved view of a symbol, if its type and dimension did not change. */
  function stateOf(name) {
    const st = states[name];
    if (!st) return undefined;
    if (st.sig && st.sig !== signatureOf(name)) {
      delete states[name];
      return undefined;
    }
    return st;
  }
  const action = (name, extra) => vscode.postMessage(Object.assign({ type: 'action', action: name }, extra || {}));

  /** The fields of variables and equations, in the order of their columns (after the dimensions). */
  const FIELDS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'];

  /**
   * How a symbol is shown without a saved view (and after Reset), like GAMS Studio's defaults: the
   * settings gdxAnalyzer.defaultView and gdxAnalyzer.defaultFields (sent by the extension).
   */
  function defaultStateOf(name) {
    const s = file && file.symbols.find((x) => x.name === name);
    const d = (file && file.viewDefaults) || {};
    if (!s) return {};
    const st = {};
    if (d.view === 'table' && s.dim >= 2) st.view = 'table';
    if ((s.type === 'Var' || s.type === 'Equ') && d.fields) {
      // If every field is hidden, all are shown.
      st.hidden = FIELDS.flatMap((f, k) => (d.fields[f] === false ? [s.dim + k] : []));
    }
    return st;
  }

  const table = new GdxTable({
    onQuery: (query) => {
      if (selected) {
        save();
        vscode.postMessage({ type: 'query', name: selected, query });
      }
    },
    onColumnValues: (column) => selected && vscode.postMessage({ type: 'columnValues', name: selected, column }),
    onCopy: (req) => selected && vscode.postMessage({ type: 'copy', name: selected, ...req }),
    onSelection: (req) => selected && vscode.postMessage({ type: 'selection', name: selected, ...req }),
    onStateChange: () => save(),
    onPreference: (key, value) => vscode.postMessage({ type: 'preference', key, value }),
    defaultState: () => (selected ? defaultStateOf(selected) : {}),
    pivot: true,
    chart: true,
    onImage: (m) => selected && vscode.postMessage({ type: 'image', name: selected, ...m }),
    imageInfo: () => {
      const s = file && file.symbols.find((x) => x.name === selected);
      return { title: s ? displaySignature(s) + (s.text ? ': ' + s.text : '') : selected || '', file: file ? file.fileName : '' };
    },
  });
  // Actions on the whole symbol, shown in the symbol header.
  const exportCsvButton = h('button', { title: 'Save all records of this symbol as CSV (gdxdump, without filters)', onclick: () => selected && action('exportCsv', { name: selected }) }, 'Export CSV…');
  const dumpButton = h('button', { title: 'Open the gdxdump output of this symbol', onclick: () => selected && action('dumpSymbol', { name: selected }) }, 'gdxdump');
  const codeButton = h('button', { title: 'Python code that reads this symbol into a pandas DataFrame (GAMS Transfer or GAMSPy), with the filters and layout of the view', onclick: () => openCode() }, 'Copy as Code ▾');
  const symbolActions = h(
    'div',
    { class: 'actions' },
    h('button', { title: 'Copy the selected cells, or all filtered records, as tab separated text with exact values (right-click cells for more)', onclick: () => table.copy('tab', true, true) }, 'Copy'),
    codeButton,
    exportCsvButton,
    dumpButton,
  );

  /** Python code for the selected symbol: the library, whether to apply the view, and where to put it. */
  function openCode() {
    if (!selected) return;
    const last = saved.code || { language: 'transfer', applyView: true };
    const radio = (value, label, title) => {
      const r = h('input', { type: 'radio', name: 'gdx-code-language', value });
      r.checked = last.language === value;
      return h('label', { class: 'check', title }, r, label);
    };
    const languages = [radio('transfer', 'GAMS Transfer', 'import gams.transfer as gt'), radio('gamspy', 'GAMSPy', 'import gamspy as gp')];
    const applyView = h('input', { type: 'checkbox' });
    applyView.checked = last.applyView !== false;
    const run = (target) => {
      const language = languages.map((l) => l.querySelector('input')).find((r) => r.checked).value;
      saved.code = { language, applyView: applyView.checked };
      vscode.setState(saved);
      popup.close(true);
      // The view as the table has it now (the saved one may be older).
      vscode.postMessage({ type: 'code', name: selected, language, target, state: applyView.checked ? JSON.parse(JSON.stringify(table.state)) : undefined });
    };
    const content = h(
      'div',
      { class: 'filter-popup' },
      h('div', { class: 'popup-title' }, 'Copy as Python Code'),
      h('div', { class: 'col' }, ...languages),
      h('label', { class: 'check', title: 'Filters, solution status, sorting, shown fields and the table view (pivot_table)' }, applyView, 'Apply the view'),
      h('div', { class: 'muted small' }, 'Reads the symbol into a pandas DataFrame. What pandas cannot do like the viewer is noted in the code.'),
      h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: () => run('clipboard') }, 'Copy'), h('button', { onclick: () => run('editor'), title: 'Open the code in a new Python editor' }, 'Open in Editor')),
    );
    const popup = openPopup(codeButton, content, { label: 'Copy as Python code' });
    languages.find((l) => l.querySelector('input').checked)?.querySelector('input').focus();
  }
  // Solution report -----------------------------------------------------------

  /** Records of each list shown at first, and added by "Show more". */
  const REPORT_ROWS = 100;
  /** The last report from the extension (ShownReport of src/solutionReport.ts), and the rows shown of each list. */
  let report = null;
  let reportRows = { infeasible: REPORT_ROWS, binding: REPORT_ROWS };
  let reportButton = null;
  const hasSolution = () => !!file && file.symbols.some((s) => s.type === 'Var' || s.type === 'Equ');

  /** Shows the solution report instead of the selected symbol; the extension computes it when first asked for. */
  function openReport(refresh) {
    if (!file || !hasSolution()) return;
    if (refresh || !report) {
      report = null;
      reportRows = { infeasible: REPORT_ROWS, binding: REPORT_ROWS };
      reportEl.replaceChildren(reportHead(), h('div', { class: 'placeholder' }, 'Reading the variables and equations…'));
    }
    // Also when the report is shown: the extension keeps it and formats it again (e.g. after the number format changed).
    vscode.postMessage({ type: 'report', refresh: !!refresh });
    reportOpen = true;
    showMain();
    save();
  }

  /** Shows the selected symbol again (`requery`: ask for its records, e.g. after the report was closed). */
  function closeReport(requery) {
    if (!reportOpen) return;
    reportOpen = false;
    showMain();
    save();
    if (requery && selected) table.query();
  }

  function showMain() {
    symHead.hidden = table.el.hidden = reportOpen;
    reportEl.hidden = !reportOpen;
    if (reportButton) reportButton.setAttribute('aria-pressed', reportOpen ? 'true' : 'false');
    for (const el of symList.querySelectorAll('.sym.selected')) el.classList.toggle('dimmed', reportOpen);
  }

  function reportHead(sub) {
    return h(
      'div',
      { class: 'symhead' },
      h('span', { class: 'sig report-title' }, 'Solution Report'),
      h('span', { class: 'desc' }, sub || ''),
      h(
        'div',
        { class: 'actions' },
        h('button', { title: 'Read the variables and equations again', onclick: () => openReport(true) }, 'Refresh'),
        h('button', { title: 'Show the selected symbol again', onclick: () => closeReport(true) }, 'Close'),
      ),
    );
  }

  /**
   * Shows a symbol with a solution filter (and sorted by |marginal|, largest first), as the
   * report counts its records: other filters and a row-filtering search of the symbol are removed.
   */
  function openWithSolution(name, filter, sortByMarginal) {
    const info = report && report.symbols.find((x) => x.name === name);
    if (selected && selected !== name) save();
    const st = Object.assign({}, stateOf(name) || defaultStateOf(name), { solution: filter, columnFilters: [], page: 0, colPage: 0, view: 'list', sig: signatureOf(name) });
    if (st.search && st.search.filterRows) st.search = { text: '' };
    if (sortByMarginal && info && info.marginalColumn !== undefined) Object.assign(st, { sortColumn: info.marginalColumn, sortDescending: true, sortAbsolute: true });
    states[name] = st;
    showSymbol(name, true);
  }

  /** A clickable cell value (a count or a record) that opens a symbol. */
  const link = (text, title, onclick) => h('button', { class: 'link', title, onclick }, text);

  /** A list of report records: the first ones, with "Show more" for the others the extension sent. */
  function recordList(key, records, total, columns, open) {
    const shown = records.slice(0, reportRows[key]);
    const body = shown.map((r) =>
      h(
        'tr',
        null,
        h('td', { class: 'name' }, link(r.record, `Show ${r.symbol} with ${key === 'infeasible' ? 'its records outside their bounds' : 'its binding records, largest |marginal| first'}`, () => open(r))),
        ...columns.map(([, i, cls]) => h('td', { class: cls || 'num', title: r.exact[i] !== r.cells[i] ? r.exact[i] : undefined }, i === 'type' ? (r.type === 'Var' ? 'Variable' : 'Equation') : r.cells[i])),
      ),
    );
    const more = records.length - shown.length;
    const notShown = total - records.length;
    return [
      h('table', { class: 'symtable report-table' }, h('thead', null, h('tr', null, h('th', null, 'Record'), ...columns.map(([label, , cls]) => h('th', { class: cls || 'num' }, label)))), h('tbody', null, ...body)),
      more > 0 ? h('div', { class: 'row' }, h('button', { onclick: () => ((reportRows[key] += REPORT_ROWS), renderReport()) }, `Show ${fmt.format(Math.min(more, REPORT_ROWS))} more`)) : null,
      more <= 0 && notShown > 0 ? h('div', { class: 'muted small' }, `The report lists the first ${fmt.format(records.length)} of ${fmt.format(total)}: open a symbol for all of its records.`) : null,
    ];
  }

  const plural = (n, what) => `${fmt.format(n)} ${what}${n === 1 ? '' : 's'}`;

  function renderReport() {
    if (!report) return;
    const r = report;
    const nVar = r.symbols.filter((s) => s.type === 'Var').length;
    const nEqu = r.symbols.filter((s) => s.type === 'Equ').length;
    const symbolsWith = (filter, type) => r.symbols.filter((s) => (s.counts[filter] || 0) > 0 && (!type || s.type === type)).length;
    const worst = r.infeasible[0];
    const strongest = r.binding[0];
    const failed = r.symbols.filter((s) => s.error);
    const cards = h(
      'div',
      { class: 'report-cards' },
      h(
        'div',
        { class: 'card ' + (r.infeasibleCount ? 'bad' : 'good') },
        h('div', { class: 'big' }, fmt.format(r.infeasibleCount)),
        h('div', null, `record${r.infeasibleCount === 1 ? '' : 's'} outside their bounds`),
        h('div', { class: 'muted small' }, worst ? `in ${plural(symbolsWith('infeasible'), 'symbol')}; largest ${worst.cells[4]} in ${worst.record}` : 'The solution is feasible.'),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'big' }, fmt.format(r.bindingCount)),
        h('div', null, `binding constraint${r.bindingCount === 1 ? '' : 's'}`),
        h('div', { class: 'muted small' }, strongest ? `in ${plural(symbolsWith('marginal', 'Equ'), 'equation')}; largest |marginal| ${strongest.cells[4]} in ${strongest.record}` : 'No equation has a non-zero marginal.'),
      ),
    );
    const sections = [cards];
    if (failed.length) {
      sections.push(h('div', { class: 'error' }, failed.map((s) => `${s.name}: ${s.error}`).join('\n')));
    }
    if (r.infeasibleCount) {
      sections.push(
        h('h3', null, `Records outside their bounds (${fmt.format(r.infeasibleCount)})`, h('span', { class: 'muted small' }, ' farthest outside first')),
        ...recordList('infeasible', r.infeasible, r.infeasibleCount, [['Type', 'type', 'type'], ['Level', 0], ['Lower', 2], ['Upper', 3], ['Infeasibility', 4]], (x) => openWithSolution(x.symbol, 'infeasible')),
      );
    }
    if (r.bindingCount) {
      sections.push(
        h('h3', null, `Binding constraints (${fmt.format(r.bindingCount)})`, h('span', { class: 'muted small' }, ' equations with a non-zero or EPS marginal, largest |marginal| first')),
        ...recordList('binding', r.binding, r.bindingCount, [['Level', 0], ['Marginal', 1], ['Lower', 2], ['Upper', 3]], (x) => openWithSolution(x.symbol, 'marginal', true)),
      );
    }
    // Per symbol: each count opens the symbol with that solution filter.
    const count = (s, filter, sortByMarginal) => {
      const n = s.counts[filter];
      if (n === undefined) return h('td', { class: 'num' }, '');
      return h('td', { class: 'num' + (filter === 'infeasible' && n ? ' bad' : '') }, n ? link(fmt.format(n), `Show these records of ${s.name}`, () => openWithSolution(s.name, filter, sortByMarginal)) : '0');
    };
    const amount = ([shown, exact]) => h('td', { class: 'num', title: exact !== shown ? exact : undefined }, shown);
    const symbolRows = r.symbols.map((s) =>
      h(
        'tr',
        null,
        h('td', { class: 'name' }, link(s.name, `Show ${s.name}`, () => showSymbol(s.name)), s.dim ? h('span', { class: 'dom' }, `(${s.domain.join(',')})`) : null),
        h('td', { class: 'type' }, typeLabel(s)),
        h('td', { class: 'num' }, fmt.format(s.records)),
        s.error ? h('td', { class: 'text', colspan: 6, title: s.error }, 'Not read: ' + s.error) : count(s, 'infeasible'),
        ...(s.error ? [] : [amount(s.shown.maxInfeasibility), count(s, 'marginal', true), amount(s.shown.maxMarginal), count(s, 'atLower'), count(s, 'atUpper')]),
      ),
    );
    const headers = [
      ['Symbol', ''],
      ['Type', ''],
      ['Records', 'num'],
      ['Outside bounds', 'num', 'Records whose level is below its lower or above its upper bound'],
      ['Max infeasibility', 'num', 'How far the level of the record farthest outside its bounds is outside them'],
      ['Non-zero marginal', 'num', 'Records with a non-zero or EPS marginal: binding constraints and nonbasic variables'],
      ['Max |marginal|', 'num', 'The largest absolute marginal (EPS counts as 0)'],
      ['At lower', 'num', 'Records whose level is at its finite lower bound'],
      ['At upper', 'num', 'Records whose level is at its finite upper bound'],
    ];
    sections.push(
      h('h3', null, 'Variables and equations'),
      h('table', { class: 'symtable report-table' }, h('thead', null, h('tr', null, ...headers.map(([label, cls, title]) => h('th', { class: cls, title }, label)))), h('tbody', null, ...symbolRows)),
      h('div', { class: 'muted small' }, 'Levels and bounds are compared with a tolerance of 1e-6 (relative to bounds above 1); EPS counts as 0. Numbers are shown in the default format (gdxAnalyzer.numberFormat); hover a value to see it exactly.'),
    );
    reportEl.replaceChildren(reportHead(`${plural(nVar, 'variable')}, ${plural(nEqu, 'equation')}`), h('div', { class: 'report-body' }, ...sections));
  }

  /** Selects a symbol from the report and shows it in the symbol list. */
  function showSymbol(name, force) {
    select(name, force);
    const row = symList.querySelector('.sym.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  /** The symbols of the file without the universe (the list of unique elements). */
  const realSymbols = () => file.symbols.filter((s) => !s.universe);
  /** Like signature(), but the universe is just "*". */
  const displaySignature = (s) => (s.universe ? s.name : signature(s));

  // Like GAMS Studio: only the name is searched unless "all columns" is on.
  const symbolSearch = searchBox({
    placeholder: 'Filter symbols…',
    label: 'Filter symbols',
    toggles: [EXACT, REGEX, { key: 'allColumns', text: '≡', title: 'All columns: also search type, domain and explanatory text (otherwise only names)' }],
    value: saved.symbolSearch || (saved.symbolFilter ? { text: saved.symbolFilter } : undefined),
    onChange: () => {
      applySymbolFilter();
      save();
    },
  });
  const symbolFilter = symbolSearch.input;
  /** Searchable fields of each symbol: name first. */
  const symbolFields = new Map();
  // Like GAMS Studio's symbol table: sortable by entry (the default), name, type, dimension, records and text.
  let symbolSort = saved.symbolSort || { key: 'entry', desc: false };
  const groupBox = h('input', { type: 'checkbox', onchange: () => (renderSymbols(), save()) });
  groupBox.checked = !!saved.grouped;
  const SORT_KEYS = [
    ['entry', '#', 'Entry: the number of the symbol in the file'],
    ['name', 'Name', ''],
    ['type', 'Type', ''],
    ['dim', 'Dim', 'Dimension'],
    ['records', 'Records', ''],
    ['text', 'Text', 'Explanatory text'],
  ];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortSymbols(list) {
    const { key, desc } = symbolSort;
    const value = (s) => (key === 'type' ? typeLabel(s) : key === 'entry' ? s.entry ?? 0 : s[key] ?? '');
    const sorted = [...list].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return c || collator.compare(a.name, b.name);
    });
    return desc ? sorted.reverse() : sorted;
  }
  const symList = h('div', { class: 'symlist', role: 'listbox', 'aria-label': 'Symbols' });
  listKeyNav(symList, '.sym');
  const symHead = h('div', { class: 'symhead' });
  const reportEl = h('div', { class: 'report', role: 'region', 'aria-label': 'Solution report' });
  reportEl.hidden = true;
  const main = h('div', { class: 'main' }, symHead, table.el, reportEl);

  function applySymbolFilter() {
    const rx = compileSearch(symbolSearch.value);
    const error = rx && !(rx instanceof RegExp) ? rx.error : '';
    symbolSearch.setError(error);
    for (const group of symList.querySelectorAll('.groupbox')) {
      let any = false;
      for (const el of group.querySelectorAll('.sym')) {
        const fields = symbolFields.get(/** @type {HTMLElement} */ (el).dataset.name) || [/** @type {HTMLElement} */ (el).dataset.name];
        const match = !(rx instanceof RegExp) || (symbolSearch.value.allColumns ? fields : fields.slice(0, 1)).some((f) => rx.test(f));
        el.hidden = !match;
        any = any || match;
      }
      /** @type {HTMLElement} */ (group).hidden = !any;
      const head = /** @type {HTMLElement} */ (group.querySelector('.group'));
      if (head) {
        const shown = group.querySelectorAll('.sym:not([hidden])').length;
        const total = Number(head.dataset.total);
        head.textContent = head.dataset.label + ' (' + (shown === total ? total : shown + ' of ' + total) + ')';
      }
    }
  }

  let exportButton = null;
  const SPECIAL_NAMES = [
    ['eps', 'EPS'],
    ['na', 'NA'],
    ['pinf', '+INF'],
    ['minf', '-INF'],
    ['undf', 'UNDF'],
  ];
  const DEFAULT_SPECIALS = { eps: 'EPS', na: 'NA', pinf: 'INF', minf: '-INF', undf: 'UNDEF' };

  /** Like GAMS Studio's export dialog: symbols, filters, hidden fields and special values; to Excel, GAMS Connect or GDX. */
  function openExport() {
    if (!file || !exportButton) return;
    const last = saved.exportOptions || {};
    const exportable = (n) => symbolFields.has(n) && n !== '*';
    const chosen = new Set(last.names && last.names.length ? last.names.filter(exportable) : selected && exportable(selected) ? [selected] : []);
    const search = h('input', { type: 'search', placeholder: 'Filter symbols…', 'aria-label': 'Filter symbols' });
    const list = h('div', { class: 'labels export-symbols', role: 'group', 'aria-label': 'Symbols' });
    const counter = h('span', { class: 'muted' });
    const boxes = new Map();
    const symbols = realSymbols();
    for (const s of symbols) {
      const box = h('input', { type: 'checkbox', onchange: () => (box.checked ? chosen.add(s.name) : chosen.delete(s.name), sync()) });
      box.checked = chosen.has(s.name);
      boxes.set(s.name, box);
      list.append(h('label', { class: 'label-item', dataset: { name: s.name.toLowerCase() }, title: s.text || '' }, box, h('span', null, s.name), h('span', { class: 'muted' }, ' ' + typeLabel(s))));
    }
    const sync = () => {
      counter.textContent = chosen.size + ' of ' + symbols.length + ' selected';
      exportBtn.disabled = connectBtn.disabled = gdxBtn.disabled = chosen.size === 0;
    };
    search.addEventListener('input', () => {
      const needle = search.value.trim().toLowerCase();
      for (const el of list.children) /** @type {HTMLElement} */ (el).hidden = !!needle && !el.dataset.name.includes(needle);
    });
    const setAll = (on) => {
      for (const [name, box] of boxes) {
        const el = box.closest('label');
        if (el.hidden) continue;
        box.checked = on;
        on ? chosen.add(name) : chosen.delete(name);
      }
      sync();
    };
    const applyFilters = h('input', { type: 'checkbox' });
    applyFilters.checked = last.applyFilters !== false;
    const includeHidden = h('input', { type: 'checkbox' });
    includeHidden.checked = !!last.includeHidden;
    const specials = Object.assign({}, DEFAULT_SPECIALS, last.specials || {});
    const specialInputs = SPECIAL_NAMES.map(([key, label]) => {
      const input = h('input', { type: 'text', class: 'narrow', value: specials[key], 'aria-label': label });
      return { key, label, input };
    });
    const run = (mode) => {
      const options = {
        applyFilters: applyFilters.checked,
        includeHidden: includeHidden.checked,
        specials: Object.fromEntries(specialInputs.map((x) => [x.key, x.input.value])),
      };
      const names = symbols.map((s) => s.name).filter((n) => chosen.has(n));
      // The views of the symbols: the current one from the table, the others as saved.
      save();
      const viewStates = {};
      for (const n of names) if (stateOf(n)) viewStates[n] = stateOf(n);
      saved.exportOptions = Object.assign({ names }, options);
      vscode.setState(saved);
      popup.close();
      vscode.postMessage({ type: 'export', mode, names, options, states: JSON.parse(JSON.stringify(viewStates)) });
    };
    const exportBtn = h('button', { class: 'primary', onclick: () => run('excel') }, 'Export to Excel…');
    const connectBtn = h('button', { onclick: () => run('connect'), title: 'Write the equivalent GAMS Connect instructions (run them with gamsconnect)' }, 'Save Connect Instructions…');
    const gdxBtn = h(
      'button',
      { onclick: () => run('gdx'), title: 'Copy the symbols into a new GDX file with all their fields, texts, domains and exact values (with Apply filters: only the records passing the filters)' },
      'Save as GDX…',
    );
    const content = h(
      'div',
      { class: 'filter-popup export-form' },
      h('div', { class: 'popup-title' }, 'Export'),
      search,
      h('div', { class: 'row' }, h('button', { onclick: () => setAll(true) }, 'All'), h('button', { onclick: () => setAll(false) }, 'None'), counter),
      list,
      h('label', { class: 'check', title: 'Apply the column filters of each symbol (and its search in "filter rows" mode)' }, applyFilters, 'Apply filters'),
      h('label', { class: 'check', title: 'Also export fields hidden with Fields or by squeezing defaults' }, includeHidden, 'Include hidden fields (Excel)'),
      h('div', { class: 'muted small' }, 'In Excel, special values are written as (numbers are written as numbers):'),
      h('div', { class: 'grid2 specials' }, ...specialInputs.flatMap((x) => [h('span', null, x.label), x.input])),
      h('div', { class: 'muted small' }, 'Excel: each symbol on its own sheet, laid out like its view (list or table), with exact values. GDX: the symbols as they are in this file, with all their fields.'),
      h('div', { class: 'row end wrap' }, exportBtn, gdxBtn, connectBtn, h('button', { onclick: () => popup.close(true) }, 'Cancel')),
    );
    const popup = openPopup(exportButton, content, { label: 'Export' });
    sync();
    search.focus();
  }

  function symbolTitle(s) {
    return `${typeLabel(s)} ${displaySignature(s)}${s.text ? '\n' + s.text : ''}${s.type === 'Alias' ? '' : `\n${fmt.format(s.records)} records`}`;
  }

  function symbolRow(s) {
    symbolFields.set(s.name, [s.name, typeLabel(s), s.dim ? s.domain.join(',') : '', s.text || '']);
    return h(
      'tr',
      {
        class: 'sym' + (s.name === selected ? ' selected' + (reportOpen ? ' dimmed' : '') : ''),
        role: 'option',
        tabindex: 0,
        'aria-selected': s.name === selected ? 'true' : 'false',
        title: symbolTitle(s),
        dataset: { name: s.name },
        onclick: () => select(s.name),
        onkeydown: (e) => {
          if (e.key === 'Enter') select(s.name);
        },
      },
      h('td', { class: 'num' }, s.entry !== undefined ? String(s.entry) : ''),
      h('td', { class: 'name' }, s.name, s.dim && !s.universe ? h('span', { class: 'dom' }, `(${s.domain.join(',')})`) : null),
      h('td', { class: 'type' }, typeLabel(s)),
      h('td', { class: 'num' }, String(s.dim)),
      // gdxdump reports 0 records for aliases.
      h('td', { class: 'num' }, s.type === 'Alias' ? '' : fmt.format(s.records)),
      h('td', { class: 'text' }, s.text || ''),
    );
  }

  function symbolTable(syms) {
    const head = h(
      'tr',
      null,
      ...SORT_KEYS.map(([key, label, title]) => {
        const on = symbolSort.key === key;
        return h(
          'th',
          {
            class: ['entry', 'dim', 'records'].includes(key) ? 'num' : '',
            tabindex: 0,
            title: 'Sort by ' + (title || label).toLowerCase(),
            'aria-sort': on ? (symbolSort.desc ? 'descending' : 'ascending') : undefined,
            onclick: () => sortBy(key),
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                sortBy(key);
              }
            },
          },
          label,
          on ? h('span', { class: 'arrow' }, symbolSort.desc ? '▼' : '▲') : null,
        );
      }),
    );
    return h('table', { class: 'symtable' }, h('thead', null, head), h('tbody', null, ...sortSymbols(syms).map(symbolRow)));
  }

  function sortBy(key) {
    symbolSort = symbolSort.key === key ? { key, desc: !symbolSort.desc } : { key, desc: false };
    renderSymbols();
    save();
  }

  /** The symbol table: one sortable table, or one per symbol type. */
  function renderSymbols() {
    symList.replaceChildren();
    if (!groupBox.checked) {
      symList.append(h('div', { class: 'groupbox' }, symbolTable(file.symbols)));
    } else {
      for (const [type, label] of GROUPS) {
        const syms = file.symbols.filter((s) => s.type === type);
        if (!syms.length) continue;
        symList.append(
          h('div', { class: 'groupbox' }, h('div', { class: 'group', dataset: { label, total: String(syms.length) } }, `${label} (${syms.length})`), symbolTable(syms)),
        );
      }
    }
    applySymbolFilter();
    const sel = symList.querySelector('.sym.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function renderFile() {
    const header = h(
      'div',
      { class: 'header' },
      h('span', { class: 'title' }, file.fileName),
      h('span', { class: 'sub', title: file.filePath }, `${fmt.format(realSymbols().length)} symbols · ${file.tools}`),
      h(
        'div',
        { class: 'actions' },
        h('button', { onclick: () => action('refresh'), title: 'Read the file again' }, 'Refresh'),
        h('button', { onclick: () => action('dumpAll'), title: 'Open the gdxdump output of the whole file' }, 'gdxdump File'),
        h('button', { onclick: () => action('compare'), title: 'Compare this file with another GDX file (gdxdiff)' }, 'Compare…'),
        (reportButton = hasSolution()
          ? h('button', { onclick: () => (reportOpen ? closeReport(true) : openReport()), title: 'Records outside their bounds, binding constraints and levels at bounds of all variables and equations' }, 'Solution Report')
          : null),
        (exportButton = h('button', { onclick: () => openExport(), title: 'Export symbols to Excel, laid out like the viewer shows them, or save them as a new GDX file' }, 'Export…')),
      ),
    );
    const info = h(
      'details',
      { class: 'info' },
      h('summary', null, 'File information'),
      h('table', null, ...file.version.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))),
    );

    renderSymbols();

    const sidebar = h(
      'div',
      { class: 'sidebar' },
      h('div', { class: 'search' }, symbolSearch.el, h('label', { class: 'check group-toggle' }, groupBox, 'Group by type')),
      symList,
    );
    app.replaceChildren(header, info, h('div', { class: 'body' }, sidebar, main));

    // The report of the file read before is outdated.
    const showReport = reportOpen && hasSolution();
    reportOpen = false;
    report = null;
    showMain();
    const current = file.symbols.find((s) => s.name === selected);
    if (current) {
      select(current.name, true);
    } else if (realSymbols().length) {
      select(realSymbols()[0].name);
    } else {
      symHead.replaceChildren();
      table.showMessage('This GDX file contains no symbols.');
    }
    if (showReport) openReport();
  }

  function select(name, force) {
    const s = file.symbols.find((x) => x.name === name);
    if (!s) return;
    const changed = name !== selected || force;
    if (changed && selected && name !== selected) save();
    selected = name;
    for (const el of symList.querySelectorAll('.sym')) {
      const on = /** @type {HTMLElement} */ (el).dataset.name === name;
      el.classList.toggle('selected', on);
      el.classList.toggle('dimmed', on && reportOpen);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    fill(
      symHead,
      h('span', { class: 'sig' }, displaySignature(s)),
      h('span', { class: 'badge' }, typeLabel(s)),
      h('span', { class: 'desc' }, s.text || ''),
      s.domainType && s.domainType !== 'None' ? h('span', { class: 'badge', title: 'Domain checking' }, `${s.domainType} domain`) : null,
      symbolActions,
    );
    exportCsvButton.hidden = dumpButton.hidden = codeButton.hidden = !!s.universe;
    if (changed) table.reset(stateOf(name) || defaultStateOf(name));
    table.setDimension(s.dim);
    closeReport(false);
    table.query();
  }

  // Ctrl+F: the symbol search when working in the symbol list, the record search otherwise.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const inSidebar = document.activeElement && document.activeElement.closest && document.activeElement.closest('.sidebar');
      if (inSidebar) {
        symbolFilter.focus();
        symbolFilter.select();
      } else {
        table.focusSearch();
      }
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'file':
        if (!checkProtocol(m, app)) return;
        file = m;
        if (!restored) {
          restored = true;
          restore(m.savedState);
        }
        renderFile();
        break;
      case 'openExport':
        openExport();
        break;
      case 'viewDefaults':
        // The settings changed: they apply to symbols shown from now on without a saved view.
        if (file) file.viewDefaults = m.viewDefaults;
        break;
      case 'autoFit':
        // GDX: Auto-Fit Columns (Ctrl+R).
        if (!reportOpen) table.autoFit();
        break;
      case 'selectSymbol':
        // From a link in GAMS or Python source.
        if (file) showSymbol(m.name);
        break;
      case 'showReport':
        // From the command GDX: Show Solution Report.
        openReport();
        break;
      case 'reportProgress':
        if (reportOpen && !report) reportEl.replaceChildren(reportHead(), h('div', { class: 'placeholder' }, `Reading the variables and equations… ${fmt.format(m.done)} of ${fmt.format(m.total)}`));
        break;
      case 'report':
        if (!reportOpen) break;
        report = m.report;
        renderReport();
        break;
      case 'reportError':
        if (reportOpen) reportEl.replaceChildren(reportHead(), h('div', { class: 'error' }, m.message));
        break;
      case 'resetState':
        states = {};
        symbolSearch.set({ text: '' });
        symbolSort = { key: 'entry', desc: false };
        groupBox.checked = false;
        if (file) {
          renderFile();
          if (selected) select(selected, true);
        }
        save();
        break;
      case 'page':
        if (m.name === selected) table.show(m.page);
        break;
      case 'requery':
        // E.g. the number format changed.
        if (reportOpen) openReport();
        else if (selected) table.query();
        break;
      case 'columnValues':
        if (m.name === selected) table.showColumnValues(m);
        break;
      case 'symbolError':
        if (m.name === selected) table.showMessage(m.message, 'error');
        break;
      case 'fileError':
        app.replaceChildren(
          h('div', { class: 'error' }, m.message),
          h(
            'div',
            { class: 'buttons' },
            h('button', { class: 'primary', onclick: () => action('refresh') }, 'Retry'),
            h('button', { onclick: () => action('settings') }, 'Open Settings'),
            h('button', { onclick: () => action('showLog') }, 'Show Log'),
          ),
        );
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
