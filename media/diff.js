// @ts-check
/* Webview script of the gdxdiff result panel. */
(function () {
  'use strict';
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  // @ts-ignore
  const { openPopup, h, fill, checkProtocol, GdxTable, TYPE_NAMES, listKeyNav, fmt } = window.Gdx;
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  let result = null;
  /** Options of the last run (from the extension). */
  let options = {};
  let customOptions = false;
  let running = false;

  const FIELDS = ['All', 'L', 'M', 'Lo', 'Up', 'Prior', 'Scale'];

  /** Short description of the options that differ from gdxdiff's defaults. */
  function optionSummary(o) {
    const parts = [];
    if (o.eps) parts.push('Eps ' + o.eps);
    if (o.relEps) parts.push('RelEps ' + o.relEps);
    if (o.field && o.field !== 'All') parts.push('Field ' + o.field + (o.fieldOnly ? ' only' : ''));
    if (o.diffOnly && !(o.field && o.field !== 'All' && o.fieldOnly)) parts.push('Diff only');
    if (o.ignoreSetText) parts.push('Ignoring set texts');
    if (o.compareDefaults) parts.push('Comparing defaults');
    if (o.compareDomains) parts.push('Comparing domains');
    if (o.ignoreOrder) parts.push('Ignoring UEL order');
    if (o.ids && o.ids.length) parts.push('Only ' + o.ids.join(', '));
    if (o.skipIds && o.skipIds.length) parts.push('Skipping ' + o.skipIds.join(', '));
    return parts.join(' · ');
  }

  /** The gdxdiff options of this comparison; Run applies them. */
  function openOptions(anchor) {
    const o = Object.assign({}, options);
    const num = (label, key, title) => {
      const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', value: o[key] ? String(o[key]) : '', 'aria-label': label });
      return { label: h('span', { title }, label), input, read: () => (input.value.trim() === '' ? 0 : Number(input.value)) };
    };
    const eps = num('Eps', 'eps', 'Absolute tolerance: differences up to this value are ignored');
    const relEps = num('RelEps', 'relEps', 'Relative tolerance');
    const field = h('select', { 'aria-label': 'Field' }, ...FIELDS.map((f) => h('option', { value: f }, f === 'All' ? 'All fields' : f)));
    field.value = o.field || 'All';
    const check = (label, key, title) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = !!o[key];
      return { box, el: h('label', { class: 'check', title }, box, label) };
    };
    const fieldOnly = check('Field only', 'fieldOnly', 'Write variables and equations as parameters of the selected field (FldOnly)');
    const diffOnly = check('Diff only', 'diffOnly', 'Write only the differing fields, with the field as an extra dimension (DiffOnly)');
    const setText = check('Ignore set text', 'ignoreSetText', 'Do not compare explanatory texts of set elements (SetDesc=N)');
    const defaults = check('Compare defaults', 'compareDefaults', 'Report default values found in one file only as differences (CmpDefaults)');
    const domains = check('Compare domains', 'compareDomains', 'Report differing domains (CmpDomains)');
    const order = check('Ignore order', 'ignoreOrder', 'Ignore the UEL order of the input files (IgnoreOrder)');
    const list = (label, key, title) => {
      const input = h('input', { type: 'text', placeholder: 'all symbols', value: (o[key] || []).join(', '), 'aria-label': label });
      return { label: h('span', { title }, label), input, read: () => input.value.split(/[\s,]+/).filter(Boolean) };
    };
    const ids = list('Only', 'ids', 'Compare only these symbols (ID)');
    const skip = list('Skip', 'skipIds', 'Do not compare these symbols (SkipID)');
    skip.input.placeholder = 'none';
    const error = h('div', { class: 'error-text' });
    const sync = () => {
      const specific = field.value !== 'All';
      fieldOnly.box.disabled = !specific;
      fieldOnly.el.classList.toggle('disabled', !specific);
      const fo = specific && fieldOnly.box.checked;
      diffOnly.box.disabled = fo;
      diffOnly.el.classList.toggle('disabled', fo);
    };
    field.addEventListener('change', sync);
    fieldOnly.box.addEventListener('change', sync);
    sync();
    const runIt = () => {
      const e = eps.read();
      const r = relEps.read();
      if (!Number.isFinite(e) || e < 0 || !Number.isFinite(r) || r < 0) {
        error.textContent = 'Tolerances must be non-negative numbers, e.g. 1e-6.';
        return;
      }
      const next = {
        eps: e,
        relEps: r,
        field: field.value,
        fieldOnly: field.value !== 'All' && fieldOnly.box.checked,
        diffOnly: diffOnly.box.checked && !(field.value !== 'All' && fieldOnly.box.checked),
        ignoreSetText: setText.box.checked,
        compareDefaults: defaults.box.checked,
        compareDomains: domains.box.checked,
        ignoreOrder: order.box.checked,
        ids: ids.read(),
        skipIds: skip.read(),
      };
      popup.close();
      vscode.postMessage({ type: 'options', options: next });
    };
    const content = h(
      'div',
      { class: 'filter-popup options-form' },
      h('div', { class: 'popup-title' }, 'gdxdiff options'),
      h('div', { class: 'grid2' }, eps.label, eps.input, relEps.label, relEps.input, h('span', null, 'Field'), field, ids.label, ids.input, skip.label, skip.input),
      h('div', { class: 'col' }, fieldOnly.el, diffOnly.el, setText.el, defaults.el, domains.el, order.el),
      error,
      h('div', { class: 'muted small' }, 'The defaults come from the settings gdx.diff.*.'),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'primary', onclick: runIt }, 'Run'),
        h('button', { onclick: () => (popup.close(), action('resetOptions')), title: 'Use the options from the settings' }, 'Use Settings'),
        h('button', { onclick: () => popup.close(true) }, 'Cancel'),
      ),
    );
    content.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') runIt();
    });
    const popup = openPopup(anchor, content, { label: 'gdxdiff options' });
    eps.input.focus();
  }
  let selected = (vscode.getState() || {}).selected;
  const action = (name, extra) => vscode.postMessage(Object.assign({ type: 'action', action: name }, extra || {}));

  const table = new GdxTable({
    onQuery: (query) => selected && vscode.postMessage({ type: 'query', name: selected, query }),
    onColumnValues: (column) => selected && vscode.postMessage({ type: 'columnValues', name: selected, column }),
    onCopy: (req) => selected && vscode.postMessage({ type: 'copy', name: selected, ...req }),
    filterPlaceholder: 'Search differences…',
    tools: [
      h('button', { title: 'Copy the selected cells, or all filtered differences, as tab separated text (right-click cells for more)', onclick: () => table.copy('tab', true, true) }, 'Copy'),
    ],
  });
  const symList = h('div', { class: 'symlist', role: 'listbox', 'aria-label': 'Symbols with differences' });
  listKeyNav(symList, '.sym');
  const symHead = h('div', { class: 'symhead' });

  function statusClass(status) {
    const s = status.toLowerCase();
    if (s.includes('not found in file 1')) return 'status-missing1';
    if (s.includes('not found in file 2')) return 'status-missing2';
    if (s.includes('data') || s.includes('keys')) return 'status-data';
    return 'status-other';
  }

  function fileRow(label, path, open) {
    return [
      h('span', { class: 'lbl' }, label),
      h('span', { class: 'path', title: path }, path),
      h(
        'a',
        {
          onclick: open,
          onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && open(),
          title: 'Open in the GDX viewer',
          role: 'button',
          tabindex: 0,
        },
        'Open',
      ),
    ];
  }

  function header(extraActions) {
    return [
      h(
        'div',
        { class: 'header' },
        h('span', { class: 'title' }, 'GDX Comparison'),
        h('span', { class: 'sub' }, [result ? result.tools : '', optionSummary(options)].filter(Boolean).join(' · ') + (customOptions ? ' (options changed for this comparison)' : '')),
        h(
          'div',
          { class: 'actions' },
          running
            ? h('button', { class: 'primary', onclick: () => action('cancel'), title: 'Stop gdxdiff' }, 'Cancel')
            : h('button', { onclick: () => action('rerun'), title: 'Run gdxdiff again' }, 'Rerun'),
          (() => {
            const b = h('button', { onclick: () => openOptions(b), title: 'gdxdiff options for this comparison', disabled: running }, 'Options…');
            return b;
          })(),
          h('button', { onclick: () => action('swap'), title: 'Swap file 1 and file 2' }, 'Swap'),
          h('button', { onclick: () => action('textDiff'), title: 'Compare the complete gdxdump outputs in the text diff editor' }, 'Text Diff'),
          ...(extraActions || []),
        ),
      ),
    ];
  }

  function renderRunning(m) {
    app.replaceChildren(
      ...header(),
      h('div', { class: 'files' }, ...fileRow('File 1', m.file1, () => action('open1')), ...fileRow('File 2', m.file2, () => action('open2'))),
      h('div', { class: 'placeholder' }, 'Running gdxdiff…'),
    );
  }

  function renderResult() {
    const r = result;
    const files = h('div', { class: 'files' }, ...fileRow('File 1', r.file1, () => action('open1')), ...fileRow('File 2', r.file2, () => action('open2')));
    const hasDiffFile = r.entries.some((e) => e.diffRecords !== undefined);
    const extra = hasDiffFile
      ? [
          h('button', { onclick: () => action('openDiffFile'), title: 'Open the difference GDX file written by gdxdiff' }, 'Open Diff GDX'),
          h('button', { onclick: () => action('saveDiffFile'), title: 'Save the difference GDX file' }, 'Save Diff GDX…'),
        ]
      : [];
    const messages = r.messages.length ? [h('div', { class: 'notice' }, r.messages.join('\n'))] : [];

    if (r.identical || !r.entries.length) {
      app.replaceChildren(
        ...header(),
        files,
        ...messages,
        h('div', { class: 'notice' }, r.identical ? 'No differences found.' : 'gdxdiff reported no differing symbols.'),
      );
      return;
    }

    symList.replaceChildren(
      h('div', { class: 'group' }, `Differences (${r.entries.length})`),
      ...r.entries.map((e) =>
        h(
          'div',
          {
            class: 'sym' + (e.name === selected ? ' selected' : ''),
            role: 'option',
            tabindex: 0,
            title: `${e.type ? TYPE_NAMES[e.type] + ' ' : ''}${e.name}${e.text ? '\n' + e.text : ''}\n${e.status}`,
            dataset: { name: e.name },
            onclick: () => select(e.name),
            onkeydown: (ev) => {
              if (ev.key === 'Enter') select(e.name);
            },
          },
          h('span', { class: 'name' }, e.name),
          h('span', { class: 'status ' + statusClass(e.status) }, e.status),
        ),
      ),
    );
    const main = h('div', { class: 'main' }, symHead, table.el);
    app.replaceChildren(...header(extra), files, ...messages, h('div', { class: 'body' }, h('div', { class: 'sidebar' }, symList), main));
    const current = r.entries.find((e) => e.name === selected) || r.entries[0];
    select(current.name, true);
  }

  function select(name, force) {
    const e = result.entries.find((x) => x.name === name);
    if (!e) return;
    const changed = force || name !== selected;
    selected = name;
    vscode.setState({ selected });
    for (const el of symList.querySelectorAll('.sym')) {
      el.classList.toggle('selected', /** @type {HTMLElement} */ (el).dataset.name === name);
    }
    fill(
      symHead,
      h('span', { class: 'sig' }, e.name),
      e.type ? h('span', { class: 'badge' }, TYPE_NAMES[e.type]) : null,
      h('span', { class: 'desc' }, e.status + (e.text ? ` — ${e.text}` : '')),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            onclick: () => action('textDiff', { name: e.name }),
            disabled: !e.inBoth,
            title: e.inBoth ? 'Compare the gdxdump outputs of this symbol in the text diff editor' : 'The symbol exists in only one of the files',
          },
          'Text Diff',
        ),
      ),
    );
    if (changed) table.reset();
    if (e.diffRecords === undefined) {
      table.showMessage(
        e.inBoth
          ? 'gdxdiff did not write records for this symbol (e.g. the dimension or type differs). Use Text Diff to inspect it.'
          : e.status + '.',
        'notice',
      );
      return;
    }
    table.query();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      table.focusSearch();
    }
  });

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'running':
        running = true;
        options = m.options || {};
        renderRunning(m);
        break;
      case 'result':
        if (!checkProtocol(m, app)) return;
        running = false;
        options = m.options || {};
        customOptions = !!m.customOptions;
        result = m;
        renderResult();
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
      case 'error':
        running = false;
        app.replaceChildren(...header(), h('div', { class: m.cancelled ? 'notice' : 'error' }, m.message));
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
