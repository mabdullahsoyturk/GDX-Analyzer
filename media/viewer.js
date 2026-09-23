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
  /** @type {{ selected?: string, symbolSearch?: any, symbolSort?: { key: string, desc: boolean }, grouped?: boolean, states?: Record<string, any> }} */
  let saved = vscode.getState() || {};
  let states = saved.states || {};
  /** True once a view was restored (from the webview or the extension's saved state). */
  let restored = !!saved.selected;
  let file = null;
  let selected = saved.selected;
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
    vscode.setState((saved = { selected, symbolSearch: symbolSearch.value, symbolSort, grouped: groupBox.checked, states }));
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

  const table = new GdxTable({
    onQuery: (query) => {
      if (selected) {
        save();
        vscode.postMessage({ type: 'query', name: selected, query });
      }
    },
    onColumnValues: (column) => selected && vscode.postMessage({ type: 'columnValues', name: selected, column }),
    onCopy: (req) => selected && vscode.postMessage({ type: 'copy', name: selected, ...req }),
    onStateChange: () => save(),
    pivot: true,
  });
  // Actions on the whole symbol, shown in the symbol header.
  const symbolActions = h(
    'div',
    { class: 'actions' },
    h('button', { title: 'Copy the selected cells, or all filtered records, as tab separated text with exact values (right-click cells for more)', onclick: () => table.copy('tab', true, true) }, 'Copy'),
    h('button', { title: 'Save all records of this symbol as CSV (gdxdump, without filters)', onclick: () => selected && action('exportCsv', { name: selected }) }, 'Export CSV…'),
    h('button', { title: 'Open the gdxdump output of this symbol', onclick: () => selected && action('dumpSymbol', { name: selected }) }, 'gdxdump'),
  );

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
  const main = h('div', { class: 'main' }, symHead, table.el);

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

  /** Like GAMS Studio's export dialog: symbols, filters, hidden fields and special values. */
  function openExport() {
    if (!file || !exportButton) return;
    const last = saved.exportOptions || {};
    const chosen = new Set(last.names && last.names.length ? last.names.filter((n) => symbolFields.has(n)) : selected ? [selected] : []);
    const search = h('input', { type: 'search', placeholder: 'Filter symbols…', 'aria-label': 'Filter symbols' });
    const list = h('div', { class: 'labels export-symbols', role: 'group', 'aria-label': 'Symbols' });
    const counter = h('span', { class: 'muted' });
    const boxes = new Map();
    for (const s of file.symbols) {
      const box = h('input', { type: 'checkbox', onchange: () => (box.checked ? chosen.add(s.name) : chosen.delete(s.name), sync()) });
      box.checked = chosen.has(s.name);
      boxes.set(s.name, box);
      list.append(h('label', { class: 'label-item', dataset: { name: s.name.toLowerCase() }, title: s.text || '' }, box, h('span', null, s.name), h('span', { class: 'muted' }, ' ' + typeLabel(s))));
    }
    const sync = () => {
      counter.textContent = chosen.size + ' of ' + file.symbols.length + ' selected';
      exportBtn.disabled = connectBtn.disabled = chosen.size === 0;
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
      const names = file.symbols.map((s) => s.name).filter((n) => chosen.has(n));
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
    const content = h(
      'div',
      { class: 'filter-popup export-form' },
      h('div', { class: 'popup-title' }, 'Export to Excel'),
      search,
      h('div', { class: 'row' }, h('button', { onclick: () => setAll(true) }, 'All'), h('button', { onclick: () => setAll(false) }, 'None'), counter),
      list,
      h('label', { class: 'check', title: 'Apply the column filters of each symbol (and its search in "filter rows" mode)' }, applyFilters, 'Apply filters'),
      h('label', { class: 'check', title: 'Also export fields hidden with Fields or by squeezing defaults' }, includeHidden, 'Include hidden fields'),
      h('div', { class: 'muted small' }, 'Special values are written as (numbers are written as numbers):'),
      h('div', { class: 'grid2 specials' }, ...specialInputs.flatMap((x) => [h('span', null, x.label), x.input])),
      h('div', { class: 'muted small' }, 'Each symbol is written to its own sheet, laid out like its view (list or table), with exact values.'),
      h('div', { class: 'row end wrap' }, exportBtn, connectBtn, h('button', { onclick: () => popup.close(true) }, 'Cancel')),
    );
    const popup = openPopup(exportButton, content, { label: 'Export to Excel' });
    sync();
    search.focus();
  }

  function symbolTitle(s) {
    return `${typeLabel(s)} ${signature(s)}${s.text ? '\n' + s.text : ''}${s.type === 'Alias' ? '' : `\n${fmt.format(s.records)} records`}`;
  }

  function symbolRow(s) {
    symbolFields.set(s.name, [s.name, typeLabel(s), s.dim ? s.domain.join(',') : '', s.text || '']);
    return h(
      'tr',
      {
        class: 'sym' + (s.name === selected ? ' selected' : ''),
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
      h('td', { class: 'name' }, s.name, s.dim ? h('span', { class: 'dom' }, `(${s.domain.join(',')})`) : null),
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
      h('span', { class: 'sub', title: file.filePath }, `${fmt.format(file.symbols.length)} symbols · ${file.tools}`),
      h(
        'div',
        { class: 'actions' },
        h('button', { onclick: () => action('refresh'), title: 'Read the file again' }, 'Refresh'),
        h('button', { onclick: () => action('dumpAll'), title: 'Open the gdxdump output of the whole file' }, 'gdxdump File'),
        h('button', { onclick: () => action('compare'), title: 'Compare this file with another GDX file (gdxdiff)' }, 'Compare…'),
        (exportButton = h('button', { onclick: () => openExport(), title: 'Export symbols to Excel, laid out like the viewer shows them' }, 'Export…')),
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

    const current = file.symbols.find((s) => s.name === selected);
    if (current) {
      select(current.name, true);
    } else if (file.symbols.length) {
      select(file.symbols[0].name);
    } else {
      symHead.replaceChildren();
      table.showMessage('This GDX file contains no symbols.');
    }
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
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    fill(
      symHead,
      h('span', { class: 'sig' }, signature(s)),
      h('span', { class: 'badge' }, typeLabel(s)),
      h('span', { class: 'desc' }, s.text || ''),
      s.domainType && s.domainType !== 'None' ? h('span', { class: 'badge', title: 'Domain checking' }, `${s.domainType} domain`) : null,
      symbolActions,
    );
    if (changed) table.reset(stateOf(name));
    table.setDimension(s.dim);
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
        if (selected) table.query();
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
