import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileSearch, isSearchError } from '../../search';
import { TableView, symbolTable } from '../../table';

const rx = (text: string, opts: { exact?: boolean; regex?: boolean } = {}) => {
  const r = compileSearch({ text, ...opts });
  assert.ok(r instanceof RegExp, `expected a RegExp for ${text}`);
  return r;
};

describe('compileSearch', () => {
  it('matches parts of cells, case-insensitively', () => {
    assert.ok(rx('YORK').test('new-york'));
    assert.ok(!rx('york', { exact: true }).test('new-york'));
    assert.ok(rx('NEW-york', { exact: true }).test('new-york'));
  });

  it('supports * and ? wildcards and treats other characters literally', () => {
    assert.ok(rx('s*e', { exact: true }).test('seattle'));
    assert.ok(rx('c?ic', {}).test('chicago'));
    assert.ok(!rx('c?ic', { exact: true }).test('chicago'));
    assert.ok(rx('a.b').test('a.b'));
    assert.ok(!rx('a.b').test('axb'));
    assert.ok(rx('(1)').test('x(1)'));
  });

  it('supports regular expressions', () => {
    assert.ok(rx('^s.*e$', { regex: true }).test('seattle'));
    assert.ok(rx('jan|feb', { regex: true, exact: true }).test('feb'));
    assert.ok(!rx('jan|feb', { regex: true, exact: true }).test('february'));
  });

  it('reports invalid regular expressions and ignores empty searches', () => {
    const bad = compileSearch({ text: '(', regex: true });
    assert.ok(isSearchError(bad));
    assert.equal(compileSearch({ text: '  ' }), undefined);
    assert.equal(compileSearch(undefined), undefined);
    assert.ok(compileSearch({ text: '(' }) instanceof RegExp);
  });
});

function demand() {
  return new TableView(
    symbolTable({
      columns: ['r', 't', 'Value'],
      keyCount: 2,
      rows: [
        ['north', 'jan', '373.5333'],
        ['north', 'feb', '12'],
        ['south', 'jan', '120'],
        ['south', 'feb', '7'],
      ],
    }),
  );
}

const g3 = { style: 'g' as const, precision: 3, squeeze: true };

describe('filtering rows with a search', () => {
  it('matches the displayed values', () => {
    const v = demand();
    assert.equal(v.query({ pageSize: 10, filter: { text: '374' } }).filteredCount, 0);
    assert.equal(v.query({ pageSize: 10, filter: { text: '374' }, format: g3 }).filteredCount, 1);
  });

  it('uses wildcards, exact matches and regular expressions', () => {
    const v = demand();
    assert.equal(v.query({ pageSize: 10, filter: { text: '12*', exact: true } }).filteredCount, 2);
    assert.equal(v.query({ pageSize: 10, filter: { text: '12', exact: true } }).filteredCount, 1);
    assert.equal(v.query({ pageSize: 10, filter: { text: '^s', regex: true } }).filteredCount, 2);
    // An invalid regular expression does not filter.
    assert.equal(v.query({ pageSize: 10, filter: { text: '(', regex: true } }).filteredCount, 4);
  });
});

describe('findList', () => {
  it('lists matching cells row by row in the order of the view', () => {
    const v = demand();
    assert.deepEqual(v.findList({ pageSize: 10 }, { text: 'jan' }).hits, [
      { r: 0, c: 1 },
      { r: 2, c: 1 },
    ]);
    const sorted = v.findList({ pageSize: 10, sortColumn: 2 }, { text: '1' }).hits;
    // Sorted by value: 7, 12, 120, 373.5333 -> rows 1..3 contain a "1".
    assert.deepEqual(sorted, [
      { r: 1, c: 2 },
      { r: 2, c: 2 },
    ]);
    assert.equal(v.findList({ pageSize: 10 }, { text: '(', regex: true }).error !== undefined, true);
  });
});

describe('findPivot', () => {
  it('finds column headers once per merged label, then row labels and cells', () => {
    const v = demand();
    // Rows: nothing; columns: r, t.
    const p = v.findPivot({ rowDims: [], colDims: [0, 1] }, { text: 'north' });
    assert.deepEqual(p.hits, [{ r: 0, c: 0, kind: 'col' }]);
    const q = v.findPivot({ rowDims: [0], colDims: [1] }, { text: 'jan' });
    assert.deepEqual(q.hits, [{ r: 0, c: 0, kind: 'col' }]);
    const cells = v.findPivot({ rowDims: [0], colDims: [1], format: g3 }, { text: '12' });
    assert.deepEqual(cells.hits, [
      { r: 0, c: 1 },
      { r: 1, c: 0 },
    ]);
  });

  it('does not find the field names of variables', () => {
    const v = new TableView(symbolTable({ columns: ['i', 'j', 'Level', 'Marginal'], keyCount: 2, rows: [['a', 'x', '1', '0']] }));
    assert.deepEqual(v.findPivot({}, { text: 'level' }).hits, []);
    assert.deepEqual(v.findPivot({}, { text: 'a', exact: true }).hits, [{ r: 0, c: 0, kind: 'row' }]);
  });
});

describe('search rules of the webview (media/table.js)', () => {
  it('match those of the extension', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vm = await import('node:vm');
    const window: { Gdx?: { compileSearch: (s: object) => unknown } } = {};
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../../media/table.js'), 'utf8'), { window, Intl });
    const webview = window.Gdx!.compileSearch;
    const cases = [
      { text: 's*e', exact: true },
      { text: 'c?ic' },
      { text: 'a.b' },
      { text: '(1)' },
      { text: '^s.*e$', regex: true },
      { text: 'jan|feb', regex: true, exact: true },
      { text: '(', regex: true },
      { text: '' },
    ];
    const samples = ['seattle', 'chicago', 'a.b', 'axb', 'x(1)', 'feb', 'february', '('];
    for (const c of cases) {
      const a = compileSearch(c);
      const b = webview(c) as RegExp | { error: string } | undefined;
      assert.equal(a === undefined, b === undefined, JSON.stringify(c));
      // The webview's RegExp comes from another realm, so check for an error object instead of instanceof.
      assert.equal(isSearchError(a), !!b && 'error' in (b as object), JSON.stringify(c));
      if (a instanceof RegExp) {
        for (const sample of samples) {
          assert.equal((b as RegExp).test(sample), a.test(sample), `${JSON.stringify(c)} on ${sample}`);
        }
      }
    }
  });
});
