// @ts-check
/* Webview script of the scenario comparison: one symbol of several GDX files side by side. */
(function () {
  'use strict';
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { h, fill, checkProtocol, compileSearch, searchBox, EXACT, REGEX, GdxTable, typeLabel, signature, listKeyNav, fmt } = window.Gdx;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @type {{ selected?: string, states?: Record<string, any> }} */
  const saved = vscode.getState() || {};
  /** Per symbol: its view (filters, layout, ...), while the panel is open. */
  const states = saved.states || {};
  let selected = saved.selected;
  /** The last 'scenarios' message: files, base and symbols. */
  let data = null;

  const action = (name, extra) => vscode.postMessage(Object.assign({ type: 'action', action: name }, extra || {}));
  const save = () => {
    if (selected) states[selected] = Object.assign({}, table.state, { sig: signatureOf(selected) });
    vscode.setState({ selected, states });
  };
  const symbolOf = (name) => data && data.symbols.find((s) => s.name === name);
  /** A saved view applies while the symbol keeps its type and dimension. */
  const signatureOf = (name) => {
    const s = symbolOf(name);
    return s ? s.type + '/' + s.dim : undefined;
  };
  function stateOf(name) {
    const st = states[name];
    if (st && st.sig === signatureOf(name)) return st;
    // Scenarios side by side: the table view (the scenario is the column dimension).
    const s = symbolOf(name);
    return s && s.dim >= 1 ? { view: 'table' } : undefined;
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
    onImage: (m) => selected && vscode.postMessage({ type: 'image', name: selected, ...m }),
    onPreference: (key, value) => vscode.postMessage({ type: 'preference', key, value }),
    imageInfo: () => {
      const s = symbolOf(selected);
      return { title: s ? signature(s) + (s.text ? ': ' + s.text : '') : selected || '', file: data ? data.files.map((f) => f.name).join(' · ') : '' };
    },
    pivot: true,
    chart: true,
    filterPlaceholder: 'Search records…',
    tools: [h('button', { title: 'Copy the selected cells, or all filtered records, as tab separated text with exact values', onclick: () => table.copy('tab', true, true) }, 'Copy')],
  });

  const symbolSearch = searchBox({
    placeholder: 'Filter symbols…',
    label: 'Filter symbols',
    toggles: [EXACT, REGEX],
    onChange: () => applySymbolFilter(),
  });
  const symList = h('div', { class: 'symlist', role: 'listbox', 'aria-label': 'Symbols' });
  listKeyNav(symList, '.sym');
  const symHead = h('div', { class: 'symhead' });
  const main = h('div', { class: 'main' }, symHead, table.el);

  function applySymbolFilter() {
    const rx = compileSearch(symbolSearch.value);
    symbolSearch.setError(rx && !(rx instanceof RegExp) ? rx.error : '');
    for (const el of symList.querySelectorAll('.sym')) {
      /** @type {HTMLElement} */ (el).hidden = rx instanceof RegExp && !rx.test(/** @type {HTMLElement} */ (el).dataset.name || '');
    }
  }

  /** "2 of 3": in how many files a symbol is. */
  const presence = (s) => {
    const n = s.inFiles.filter((x) => x !== null).length;
    return n === s.inFiles.length ? 'all' : `${n} of ${s.inFiles.length}`;
  };

  function symbolRow(s) {
    const missing = data.files.filter((_, i) => s.inFiles[i] === null).map((f) => f.name);
    return h(
      'tr',
      {
        class: 'sym' + (s.name === selected ? ' selected' : '') + (missing.length ? ' partial' : ''),
        role: 'option',
        tabindex: 0,
        'aria-selected': s.name === selected ? 'true' : 'false',
        title: `${typeLabel(s)} ${signature(s)}${s.text ? '\n' + s.text : ''}\n` + data.files.map((f, i) => `${f.name}: ${s.inFiles[i] === null ? 'not in the file' : fmt.format(s.inFiles[i]) + ' records'}`).join('\n'),
        dataset: { name: s.name },
        onclick: () => select(s.name),
        onkeydown: (e) => e.key === 'Enter' && select(s.name),
      },
      h('td', { class: 'name' }, s.name, s.dim ? h('span', { class: 'dom' }, `(${s.domain.join(',')})`) : null),
      h('td', { class: 'type' }, typeLabel(s)),
      h('td', { class: 'num', title: missing.length ? 'Not in ' + missing.join(', ') : 'In all files' }, presence(s)),
    );
  }

  function filesBar() {
    const files = data.files;
    return h(
      'div',
      { class: 'scenario-files', role: 'group', 'aria-label': 'Scenarios' },
      ...files.map((f, i) =>
        h(
          'div',
          { class: 'scenario-file' + (i === data.base ? ' base' : '') + (f.error ? ' failed' : '') },
          h(
            'label',
            { class: 'check', title: 'Compare the other scenarios with this one' },
            (() => {
              const r = h('input', { type: 'radio', name: 'gdx-base', onchange: () => action('setBase', { index: i }) });
              r.checked = i === data.base;
              return r;
            })(),
            i === data.base ? 'Base' : '',
          ),
          h('span', { class: 'scenario-name' }, f.name),
          h('span', { class: 'path', title: f.path }, f.path),
          f.error ? h('span', { class: 'error-text', title: f.error }, f.error) : null,
          h('a', { role: 'button', tabindex: 0, title: 'Open in the GDX viewer', onclick: () => action('open', { index: i }), onkeydown: (e) => e.key === 'Enter' && action('open', { index: i }) }, 'Open'),
          h('button', { class: 'remove', title: files.length > 2 ? 'Remove from the comparison' : 'A comparison needs two files', 'aria-label': `Remove ${f.name}`, disabled: files.length <= 2, onclick: () => action('remove', { index: i }) }, '×'),
        ),
      ),
    );
  }

  function render() {
    const header = h(
      'div',
      { class: 'header' },
      h('span', { class: 'title' }, 'Scenario Comparison'),
      h('span', { class: 'sub' }, `${data.files.length} files · ${data.tools} · Δ and Δ% compare with the base (missing records count as 0)`),
      h(
        'div',
        { class: 'actions' },
        h('button', { onclick: () => action('add'), title: 'Add GDX files to the comparison' }, 'Add Files…'),
        h('button', { onclick: () => action('refresh'), title: 'Read the files again' }, 'Refresh'),
      ),
    );
    symList.replaceChildren(h('table', { class: 'symtable' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Type'), h('th', { class: 'num', title: 'In how many files the symbol is' }, 'Files'))), h('tbody', null, ...data.symbols.map(symbolRow))));
    applySymbolFilter();
    const sidebar = h('div', { class: 'sidebar' }, h('div', { class: 'search' }, symbolSearch.el), symList);
    app.replaceChildren(header, filesBar(), h('div', { class: 'body' }, sidebar, main));
    const current = symbolOf(selected) || data.symbols.find((s) => s.type !== 'Alias');
    if (current) select(current.name, true);
    else {
      symHead.replaceChildren();
      table.showMessage('The files contain no symbols.');
    }
  }

  function select(name, force) {
    const s = symbolOf(name);
    if (!s) return;
    const changed = name !== selected || force;
    if (changed && selected && name !== selected) save();
    selected = name;
    for (const el of symList.querySelectorAll('.sym')) {
      const on = /** @type {HTMLElement} */ (el).dataset.name === name;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    const missing = data.files.filter((_, i) => s.inFiles[i] === null).map((f) => f.name);
    fill(
      symHead,
      h('span', { class: 'sig' }, signature(s)),
      h('span', { class: 'badge' }, typeLabel(s)),
      h('span', { class: 'desc' }, s.text || ''),
      missing.length ? h('span', { class: 'badge warn', title: 'Its records count as missing there' }, `Not in ${missing.join(', ')}`) : null,
    );
    if (changed) table.reset(stateOf(name));
    // The scenario is an extra dimension.
    table.setDimension(s.dim + 1);
    table.query();
    const row = symList.querySelector('.sym.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const inSidebar = document.activeElement && document.activeElement.closest && document.activeElement.closest('.sidebar');
      if (inSidebar) symbolSearch.input.focus();
      else table.focusSearch();
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'scenarios':
        if (!checkProtocol(m, app)) return;
        data = m;
        render();
        break;
      case 'page':
        if (m.name === selected) table.show(m.page);
        break;
      case 'requery':
        if (selected) table.query();
        break;
      case 'autoFit':
        // GDX: Auto-Fit Columns (Ctrl+R).
        table.autoFit();
        break;
      case 'columnValues':
        if (m.name === selected) table.showColumnValues(m);
        break;
      case 'symbolError':
        if (m.name === selected) table.showMessage(m.message, 'error');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
