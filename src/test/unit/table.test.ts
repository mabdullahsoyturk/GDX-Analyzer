import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pivotDiff } from '../../parse';
import { TableView, compareValues, diffTable, symbolTable, universeSymbol, universeTable } from '../../table';

describe('compareValues', () => {
  it('orders special values around numbers', () => {
    const values = ['NA', '3', '+Inf', '-Inf', '1e-3', 'Eps', 'Undf', '-2'];
    assert.deepEqual([...values].sort(compareValues), ['-Inf', '-2', 'Eps', '1e-3', '3', '+Inf', 'NA', 'Undf']);
  });
});

describe('TableView', () => {
  const view = new TableView(
    symbolTable({
      columns: ['i', 'Value'],
      keyCount: 1,
      rows: [
        ['seattle', '350'],
        ['san-diego', '600'],
        ['topeka', '-Inf'],
        ['chicago', '20'],
        ['new-york', 'Eps'],
      ],
    }),
  );

  it('pages the rows', () => {
    const p = view.query({ page: 1, pageSize: 2 });
    assert.equal(p.pageCount, 3);
    assert.equal(p.offset, 2);
    assert.deepEqual(
      p.rows.map((r) => r.cells[0]),
      ['topeka', 'chicago'],
    );
    assert.equal(view.query({ page: 99, pageSize: 2 }).page, 2);
  });

  it('sorts numerically, including special values, and descending', () => {
    const asc = view.query({ sortColumn: 1, pageSize: 10 }).rows.map((r) => r.cells[1]);
    assert.deepEqual(asc, ['-Inf', 'Eps', '20', '350', '600']);
    const desc = view.query({ sortColumn: 1, sortDescending: true, pageSize: 10 }).rows.map((r) => r.cells[1]);
    assert.deepEqual(desc, ['600', '350', '20', 'Eps', '-Inf']);
  });

  it('filters case-insensitively over all cells', () => {
    const p = view.query({ filter: 'SAN', pageSize: 10 });
    assert.equal(p.filteredCount, 1);
    assert.equal(p.totalCount, 5);
    assert.equal(view.query({ filter: '35', pageSize: 10 }).rows[0].cells[0], 'seattle');
  });

  it('exports the filtered rows as TSV', () => {
    assert.equal(view.toTsv({ filter: 'o', sortColumn: 0, pageSize: 1 }), 'i\tValue\nchicago\t20\nnew-york\tEps\nsan-diego\t600\ntopeka\t-Inf\n');
  });
});

describe('universe', () => {
  it('is an entry with the number of unique elements', () => {
    const s = universeSymbol([['Symbols', '6'], ['Unique Elements', '4']]);
    assert.deepEqual([s.name, s.type, s.dim, s.records, s.entry], ['*', 'Set', 1, 4, 0]);
    assert.equal(universeSymbol([]).records, 0);
  });

  it('lists the unique elements with their numbers, sortable by label', () => {
    const view = new TableView(universeTable(['seattle', 'san-diego', 'new-york']));
    assert.deepEqual(view.query({ pageSize: 10 }).rows.map((r) => r.cells), [
      ['seattle', '1'],
      ['san-diego', '2'],
      ['new-york', '3'],
    ]);
    assert.deepEqual(view.query({ sortColumn: 0, pageSize: 10 }).rows.map((r) => r.cells[1]), ['3', '2', '1']);
  });
});

describe('diffTable', () => {
  it('shows both values, the delta and highlights changed cells', () => {
    const diff = pivotDiff({
      columns: ['i', 'Dim2', 'Level', 'Marginal'],
      keyCount: 2,
      rows: [
        ['seattle', 'dif1', '50', '0'],
        ['seattle', 'dif2', '60', '0'],
        ['topeka', 'ins2', '5', '1'],
      ],
    });
    const t = diffTable(diff);
    // Marginal never differs between dif1/dif2, so only Level is shown.
    assert.deepEqual(
      t.columns.map((c) => c.name),
      ['i', 'Status', 'Level (file 1)', 'Level (file 2)', 'Δ Level'],
    );
    assert.deepEqual(t.rows![0].cells, ['seattle', 'changed', '50', '60', '10']);
    assert.deepEqual(t.rows![0].marks, [2, 3]);
    assert.deepEqual(t.rows![1].cells, ['topeka', 'only in file 2', '', '5', '']);
    assert.equal(t.rows![1].cls, 'st-only2');
  });
});
