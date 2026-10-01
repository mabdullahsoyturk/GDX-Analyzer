import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SPECIALS, buildSheets, connectInstructions } from '../../export';
import { DEFAULT_FORMAT } from '../../format';
import type { GdxSymbol, SymbolDiff } from '../../parse';
import { Aggregate, PivotPage, TableView, diffTable, symbolTable } from '../../table';

/** A parameter p(i,j,k) to aggregate over k. */
function parameter(rows: string[][] = []) {
  const data = rows.length
    ? rows
    : [
        ['a', 'x', 'k1', '1'],
        ['a', 'x', 'k2', '2'],
        ['a', 'y', 'k1', 'Eps'],
        ['b', 'x', 'k1', '4'],
        ['b', 'y', 'k1', '5'],
        ['b', 'y', 'k2', '-1'],
      ];
  return new TableView(symbolTable({ columns: ['i', 'j', 'k', 'Value'], keyCount: 3, rows: data }, { type: 'Par' }));
}

const cells = (p: PivotPage) => p.rows.map((r) => [...r.labels, ...r.cells]);

function aggregated(aggregate: Aggregate, totals = false) {
  return parameter().pivot({ rowDims: [0], colDims: [1], aggDims: [2], aggregate, totals, pageSize: 100, colPageSize: 100 });
}

describe('aggregation in the table view', () => {
  it('combines the records of aggregated dimensions', () => {
    // A single record is shown as is (EPS stays EPS).
    assert.deepEqual(cells(aggregated('sum')), [
      ['a', '3', 'Eps'],
      ['b', '4', '4'],
    ]);
    assert.deepEqual(cells(aggregated('mean')), [
      ['a', '1.5', 'Eps'],
      ['b', '4', '2'],
    ]);
    assert.deepEqual(cells(aggregated('min')), [
      ['a', '1', 'Eps'],
      ['b', '4', '-1'],
    ]);
    assert.deepEqual(cells(aggregated('max')), [
      ['a', '2', 'Eps'],
      ['b', '4', '5'],
    ]);
    assert.deepEqual(cells(aggregated('count')), [
      ['a', '2', '1'],
      ['b', '1', '2'],
    ]);
    const page = aggregated('sum');
    assert.deepEqual(page.aggDims, [2]);
    assert.deepEqual(page.headers, [['x'], ['y']]);
  });

  it('adds a total row and total columns labeled with the aggregate', () => {
    const page = aggregated('sum', true);
    // EPS counts as 0.
    assert.deepEqual(cells(page), [
      ['a', '3', 'Eps', '3'],
      ['b', '4', '4', '8'],
      ['Sum', '7', '4', '11'],
    ]);
    assert.deepEqual(page.headers, [['x'], ['y'], ['Sum']]);
    assert.equal(page.totalRow, 2);
    assert.equal(page.totalColumns, 2);
    assert.equal(page.rowCount, 3);
    assert.equal(page.colCount, 3);
    assert.deepEqual(cells(aggregated('count', true)).at(-1), ['Count', '3', '3', '6']);
  });

  it('sums exactly where plain floating-point addition rounds', () => {
    // 0.1 added ten times is 0.9999999999999999 in plain floating point.
    const rows = Array.from({ length: 10 }, (_, i) => ['b', 'x', `k${i}`, '0.1']);
    const page = parameter(rows).pivot({ rowDims: [0], colDims: [1], aggDims: [2], pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(page), [['b', '1']]);
  });

  it('shows totals without aggregated dimensions, leaving the cells as they are', () => {
    const view = new TableView(
      symbolTable({ columns: ['i', 'j', 'Value'], keyCount: 2, rows: [['a', 'x', '1'], ['a', 'y', '2'], ['b', 'x', '3']] }, { type: 'Par' }),
    );
    const page = view.pivot({ rowDims: [0], colDims: [1], aggregate: 'max', totals: true, pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(page), [
      ['a', '1', '2', '2'],
      ['b', '3', '', '3'],
      ['Max', '3', '2', '3'],
    ]);
    // Counting does not change the cells either, only the totals.
    const count = view.pivot({ rowDims: [0], colDims: [1], aggregate: 'count', totals: true, pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(count)[0], ['a', '1', '2', '2']);
  });

  it('propagates NA and UNDF and handles infinities', () => {
    const view = parameter([
      ['a', 'x', 'k1', '1'],
      ['a', 'x', 'k2', 'NA'],
      ['a', 'y', 'k1', '+Inf'],
      ['a', 'y', 'k2', '-Inf'],
      ['b', 'x', 'k1', '+Inf'],
      ['b', 'x', 'k2', '2'],
      ['b', 'y', 'k1', 'Undf'],
      ['b', 'y', 'k2', 'NA'],
    ]);
    const page = view.pivot({ rowDims: [0], colDims: [1], aggDims: [2], pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(page), [
      ['a', 'NA', 'Undf'],
      ['b', '+Inf', 'Undf'],
    ]);
    const max = view.pivot({ rowDims: [0], colDims: [1], aggDims: [2], aggregate: 'max', pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(max)[0], ['a', 'NA', '+Inf']);
  });

  it('totals each field of variables and counts set elements', () => {
    const rows = [
      ['a', 'x', '1', '0.5'],
      ['a', 'y', '2', '0'],
      ['b', 'x', '3', '1'],
    ];
    const variable = new TableView(symbolTable({ columns: ['i', 'j', 'Level', 'Marginal'], keyCount: 2, rows }, { type: 'Var', subtype: 'free' }));
    const page = variable.pivot({ rowDims: [0], colDims: [1], totals: true, pageSize: 100, colPageSize: 100 });
    assert.deepEqual(page.headers.slice(-2), [
      ['Sum', 'Level'],
      ['Sum', 'Marginal'],
    ]);
    assert.deepEqual(cells(page).at(-1), ['Sum', '4', '1.5', '2', '0', '6', '1.5']);

    const set = new TableView(symbolTable({ columns: ['i', 'j', 'Text'], keyCount: 2, rows: [['a', 'x', ''], ['a', 'y', 'hi'], ['b', 'x', '']] }));
    const counted = set.pivot({ rowDims: [0], colDims: [], aggDims: [1], totals: true, pageSize: 100, colPageSize: 100 });
    assert.deepEqual(cells(counted), [
      ['a', '2'],
      ['b', 'Y'],
      ['Sum', '3'],
    ]);
  });

  it('does not sum the bounds and scale of variables, but takes their min, max and mean', () => {
    const columns = ['i', 'j', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'];
    const rows = [
      ['a', 'x', '1', '0', '0', '10', '1'],
      ['a', 'y', '2', '0', '0', '20', '1'],
      ['b', 'x', '3', '1', '0', '+Inf', '1'],
    ];
    const view = new TableView(symbolTable({ columns, keyCount: 2, rows }, { type: 'Var', subtype: 'positive' }));
    const sum = view.pivot({ rowDims: [0], colDims: [1], totals: true, pageSize: 100, colPageSize: 100 });
    // The total columns: only Level and Marginal; the total row leaves the bounds and scale empty.
    assert.deepEqual(sum.headers.slice(-2), [
      ['Sum', 'Level'],
      ['Sum', 'Marginal'],
    ]);
    assert.deepEqual(cells(sum).at(-1), ['Sum', '4', '1', '', '', '', '2', '0', '', '', '', '6', '1']);
    const max = view.pivot({ rowDims: [0], colDims: [1], totals: true, aggregate: 'max', pageSize: 100, colPageSize: 100 });
    assert.deepEqual(max.headers.slice(-5).map((h) => h[1]), ['Level', 'Marginal', 'Lower', 'Upper', 'Scale']);
    assert.deepEqual(cells(max).at(-1)!.slice(-3), ['0', '+Inf', '1']);
  });

  it('copies, searches and summarizes totals like other cells', () => {
    const view = parameter();
    const q = { rowDims: [0], colDims: [1], aggDims: [2], totals: true };
    const copied = view.copyPivot(q, { all: true }, { separator: '\t', labels: true }).text;
    assert.deepEqual(copied.trimEnd().split(/\r?\n/), ['i\tx\ty\tSum', 'a\t3\tEps\t3', 'b\t4\t4\t8', 'Sum\t7\t4\t11']);
    const stats = view.selectionStatsPivot(q, { rows: [2, 2], cols: [0, 2] });
    assert.equal(stats.sum, 22);
    assert.equal(stats.numbers, 3);
    const found = view.findPivot(q, { text: 'Sum', exact: true });
    assert.deepEqual(found.hits.filter((h) => h.kind !== 'col'), [{ r: 2, c: 0, kind: 'row' }]);
    assert.deepEqual(view.findPivot(q, { text: '11', exact: true }).hits, [{ r: 2, c: 2 }]);
  });

  it('is exported to Excel and written as a Connect aggregation', () => {
    const symbol: GdxSymbol = { name: 'p', type: 'Par', dim: 3, domain: ['i', 'j', 'k'], records: 6, text: '' };
    const state = { view: 'table' as const, rowDims: [0], colDims: [1], aggDims: [2], totals: true };
    const item = { symbol, view: parameter(), state };
    const defaults = { format: DEFAULT_FORMAT, squeezeDefaults: false };
    const options = { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS };
    const [sheet] = buildSheets([item], options, defaults);
    assert.deepEqual(
      sheet.rows.map((r) => r.map((c) => c.v)),
      [
        ['i', 'x', 'y', 'Sum'],
        ['a', 3, 'EPS', 3],
        ['b', 4, 4, 8],
        ['Sum', 7, 4, 11],
      ],
    );
    const connect = connectInstructions('p.gdx', 'p.xlsx', [item], options, defaults);
    assert.match(connect, /name: p\(d1,d2,d3\)\n    newName: p_view\(d1,d2\)\n    aggregationMethod: sum/);
    assert.match(connect, /# p: the totals are not written\./);
    const count = connectInstructions('p.gdx', 'p.xlsx', [{ ...item, state: { ...state, aggregate: 'count' as const, totals: false } }], options, defaults);
    assert.match(count, /the aggregation \(count\) is not applied/);
    assert.doesNotMatch(count, /aggregationMethod/);
  });
});

describe('relative differences and sorting by magnitude', () => {
  function diff(rows: [string, string, string][]): SymbolDiff {
    // [label, value in file 1 ('' if only in file 2), value in file 2 ('' if only in file 1)]
    return {
      keyColumns: ['i'],
      valueColumns: ['Value'],
      records: rows.map(([k, a, b]) =>
        a !== '' && b !== '' ? { keys: [k], status: 'changed', values1: [a], values2: [b] } : a !== '' ? { keys: [k], status: 'only1', values1: [a] } : { keys: [k], status: 'only2', values2: [b] },
      ),
    } as SymbolDiff;
  }

  it('shows the difference in percent of |file 1|, ±INF from 0', () => {
    const t = diffTable(
      diff([
        ['up', '50', '60'],
        ['down', '-4', '-5'],
        ['fromZero', '0', '3'],
        ['toZero', '2', '0'],
        ['only', '', '7'],
      ]),
    );
    assert.deepEqual(t.columns.map((c) => c.name), ['i', 'Status', 'Value (file 1)', 'Value (file 2)', 'Δ Value', 'Δ% Value']);
    assert.ok(t.columns[5].relative && t.columns[5].delta);
    assert.deepEqual(
      t.rows!.map((r) => [r.cells[0], r.cells[5]]),
      [
        ['up', '20'],
        ['down', '-25'],
        ['fromZero', '+Inf'],
        ['toZero', '-100'],
        ['only', ''],
      ],
    );
  });

  it('sorts numbers by magnitude, with NA, UNDF and empty cells last', () => {
    const values = ['3', '-10', 'Eps', 'NA', '', '+Inf', '-Inf', '1'];
    const view = new TableView(symbolTable({ columns: ['i', 'Value'], keyCount: 1, rows: values.map((v, i) => [`r${i}`, v]) }, { type: 'Par' }));
    const sorted = (sortDescending: boolean) =>
      view.query({ sortColumn: 1, sortDescending, sortAbsolute: true, pageSize: 100 }).rows.map((r) => r.cells[1]);
    assert.deepEqual(sorted(true), ['+Inf', '-Inf', '-10', '3', '1', 'Eps', 'NA', '']);
    assert.deepEqual(sorted(false), ['Eps', '1', '3', '-10', '+Inf', '-Inf', 'NA', '']);
    // Without sortAbsolute: by value.
    assert.deepEqual(view.query({ sortColumn: 1, sortDescending: true, pageSize: 100 }).rows[0].cells[1], '');
  });
});
