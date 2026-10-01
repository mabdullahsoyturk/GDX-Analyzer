import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ColumnStoreBuilder } from '../../columns';
import type { SymbolColumns } from '../../parse';
import { baseAfterRemoval, scenarioNames, scenarioTable } from '../../scenario';
import { TableView } from '../../table';

/** Records in compact columns, like loadSymbolColumns returns them. */
function data(columns: string[], keyCount: number, rows: string[][]): SymbolColumns {
  const b = new ColumnStoreBuilder(
    columns.map((c, i) => (i < keyCount || c === 'Text' ? 'label' : 'number')),
    rows.length,
  );
  for (const row of rows) {
    row.forEach((v, i) => b.set(i, v));
    b.endRow();
  }
  return { columns, keyCount, store: b.build() };
}

const par = (rows: string[][]) => data(['i', 'Value'], 1, rows);

/** All rows of a view as text. */
function rows(view: TableView): string[][] {
  return view.query({ pageSize: 1000 }).rows.map((r) => r.cells);
}

describe('scenario comparison', () => {
  it('names scenarios by file, with the folder where names repeat', () => {
    assert.deepEqual(scenarioNames(['/runs/base.gdx', '/runs/high.gdx']), ['base', 'high']);
    assert.deepEqual(scenarioNames(['/a/out.gdx', '/b/out.gdx', 'C:\\runs\\x.GDX']), ['a/out', 'b/out', 'x']);
    assert.deepEqual(scenarioNames(['/a/out.gdx', '/a/out.gdx']), ['a/out', 'a/out (2)']);
  });

  it('keeps the base when a file is removed', () => {
    // Files a, b, c with c as the base: removing a keeps c (now index 1).
    assert.equal(baseAfterRemoval(2, 0), 1);
    assert.equal(baseAfterRemoval(0, 2), 0);
    assert.equal(baseAfterRemoval(1, 1), 0);
  });

  it('puts the scenarios in a key column, with Δ and Δ% from the base', () => {
    const scenarios = [
      { name: 'base', data: par([['seattle', '350'], ['san-diego', '600']]) },
      { name: 'high', data: par([['seattle', '400'], ['san-diego', '600'], ['topeka', '10']]) },
      { name: 'low', data: par([['seattle', '0']]) },
    ];
    const view = new TableView(scenarioTable(scenarios, 0));
    assert.deepEqual(view.table.columns.map((c) => c.name), ['i', 'Scenario', 'Value', 'Δ Value', 'Δ% Value']);
    // A record of the base that a scenario lacks is a row of that scenario (Δ = −base); the base has no Δ.
    assert.deepEqual(rows(view), [
      ['seattle', 'base', '350', '', ''],
      ['seattle', 'high', '400', '50', '14.285714285714286'],
      ['seattle', 'low', '0', '-350', '-100'],
      ['san-diego', 'base', '600', '', ''],
      ['san-diego', 'high', '600', '0', '0'],
      ['san-diego', 'low', '', '-600', '-100'],
      ['topeka', 'high', '10', '10', '+Inf'],
    ]);
    // Values that differ from the base are marked (Value is column 2).
    const page = view.query({ pageSize: 10 });
    assert.deepEqual(page.rows.map((r) => r.marks), [[], [2], [2], [], [], [2], [2]]);
  });

  it('shows the scenarios side by side in the table view, in their order', () => {
    const scenarios = [
      { name: 'zeta', data: par([['a', '1']]) },
      { name: 'alpha', data: par([['a', '2'], ['b', '3']]) },
    ];
    const view = new TableView(scenarioTable(scenarios, 0));
    view.setUelOrder(['b', 'a']);
    const pivot = view.pivot({ hidden: [3, 4], pageSize: 10, colPageSize: 10 });
    // The fields form the last header level (Value; Δ and Δ% are hidden here).
    assert.deepEqual(pivot.headers, [
      ['zeta', 'Value'],
      ['alpha', 'Value'],
    ]);
    assert.deepEqual(pivot.rows.map((r) => [...r.labels, ...r.cells]), [
      ['b', '', '3'],
      ['a', '1', '2'],
    ]);
  });

  it('charts the values by the last dimension with a series per scenario', () => {
    const scenarios = [
      { name: 'base', data: par([['a', '1'], ['b', '2']]) },
      { name: 'high', data: par([['a', '3'], ['b', '4']]) },
    ];
    const chart = new TableView(scenarioTable(scenarios, 0)).chart({});
    assert.deepEqual([chart.chart.x, chart.chart.series, chart.chart.value], [0, 1, 2]);
    assert.deepEqual(chart.categories, ['a', 'b']);
    assert.deepEqual(chart.series.map((s) => [s.name, s.values]), [
      ['base', [1, 2]],
      ['high', [3, 4]],
    ]);
  });

  it('compares any scenario as the base and handles files without the symbol', () => {
    const scenarios = [{ name: 'a', data: par([['x', '1']]) }, { name: 'b' }, { name: 'c', data: par([['x', '4']]) }];
    const view = new TableView(scenarioTable(scenarios, 2));
    assert.deepEqual(rows(view), [
      ['x', 'a', '1', '-3', '-75'],
      ['x', 'b', '', '-4', '-100'],
      ['x', 'c', '4', '', ''],
    ]);
  });

  it('compares levels and marginals of variables, with the solution filters per scenario', () => {
    const columns = ['i', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'];
    const scenarios = [
      { name: 'base', data: data(columns, 1, [['p', '0', '2', '0', '+Inf', '1']]) },
      { name: 'new', data: data(columns, 1, [['p', '5', '0', '0', '+Inf', '1']]) },
    ];
    const view = new TableView(scenarioTable(scenarios, 0, { type: 'Var', subtype: 'positive' }));
    assert.deepEqual(view.table.columns.map((c) => c.name), ['i', 'Scenario', 'Level', 'Δ Level', 'Δ% Level', 'Marginal', 'Δ Marginal', 'Δ% Marginal', 'Lower', 'Upper', 'Scale']);
    assert.deepEqual(rows(view)[1], ['p', 'new', '5', '5', '+Inf', '0', '-2', '-100', '0', '+Inf', '1']);
    // At its lower bound in the base only; bounds and scale are default everywhere.
    assert.deepEqual(view.query({ solution: 'atLower', pageSize: 10 }).rows.map((r) => r.cells[1]), ['base']);
    assert.deepEqual(view.squeezableColumns().map((c) => view.table.columns[c].name), ['Lower', 'Upper', 'Scale']);
    // A record missing in a scenario (an empty row) has the default values.
    const missing = new TableView(scenarioTable([{ name: 'base', data: data(columns, 1, [['p', '0', '2', '0', '+Inf', '1']]) }, { name: 'none', data: data(columns, 1, []) }], 0, { type: 'Var', subtype: 'positive' }));
    assert.deepEqual(missing.query({ solution: 'nonDefault', pageSize: 10 }).rows.map((r) => r.cells[1]), ['base']);
    // (Its level is 0, the default, too.)
    assert.deepEqual(missing.squeezableColumns().map((c) => missing.table.columns[c].name), ['Level', 'Lower', 'Upper', 'Scale']);
    // Sums of Δ% (percentages) are left empty; other aggregates are kept (Δ% Marginal only: column 7).
    const two = new TableView(
      scenarioTable([{ name: 'base', data: data(columns, 1, [['p', '0', '2', '0', '+Inf', '1'], ['q', '0', '4', '0', '+Inf', '1']]) }, { name: 'none', data: data(columns, 1, []) }], 0, { type: 'Var', subtype: 'positive' }),
    );
    const marginalPercent = { rowDims: [], colDims: [1], aggDims: [0], hidden: [2, 3, 4, 5, 6, 8, 9, 10], pageSize: 10, colPageSize: 10 };
    assert.deepEqual(two.pivot({ ...marginalPercent, aggregate: 'sum' }).rows[0].cells, ['', '']);
    assert.deepEqual(two.pivot({ ...marginalPercent, aggregate: 'min' }).rows[0].cells, ['', '-100']);
  });

  it('keeps set element texts and rejects symbols that differ between the files', () => {
    const set = (rows: string[][]) => data(['i', 'Text'], 1, rows);
    const view = new TableView(scenarioTable([{ name: 'a', data: set([['x', 'old']]) }, { name: 'b', data: set([['x', 'new'], ['y', '']]) }], 0));
    assert.deepEqual(rows(view), [
      ['x', 'a', 'old'],
      ['x', 'b', 'new'],
      ['y', 'b', 'Y'],
    ]);
    assert.throws(() => scenarioTable([{ name: 'a', data: par([['x', '1']]) }, { name: 'b', data: data(['i', 'j', 'Value'], 2, [['x', 'y', '1']]) }], 0), /1 dimension\(s\).*but 2 .* in b/);
    assert.throws(() => scenarioTable([{ name: 'a' }], 0), /None of the files has this symbol/);
  });
});
