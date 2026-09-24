import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeStats, selectionStats } from '../../query';
import { TableView, symbolTable } from '../../table';

function variable() {
  return new TableView(
    symbolTable({
      columns: ['i', 'j', 'Level', 'Marginal'],
      keyCount: 2,
      rows: [
        ['seattle', 'new-york', '50', '0'],
        ['seattle', 'chicago', '300.5', 'NA'],
        ['san-diego', 'new-york', '275', '0.009000000000000008'],
        ['san-diego', 'topeka', '-Inf', 'Eps'],
      ],
    }),
  );
}

const format = { style: 'g' as const, precision: 6, squeeze: true };

describe('selectionStatsList', () => {
  it('sums the numbers of a rectangle and counts special values and labels separately', () => {
    const s = variable().selectionStatsList({ pageSize: 1 }, { rows: [0, 3], cols: [1, 3] });
    assert.equal(s.cells, 12);
    assert.equal(s.numbers, 5);
    assert.equal(s.sum, 50 + 300.5 + 275 + 0 + 0.009000000000000008);
    assert.equal(s.min, 0);
    assert.equal(s.max, 300.5);
    assert.deepEqual(s.specials, { minf: 1, na: 1, eps: 1 });
    assert.equal(s.texts, 4);
  });

  it('follows the filters, the sorting and the hidden columns of the view', () => {
    const q = { pageSize: 1, sortColumn: 2, sortDescending: true, hidden: [3], columnFilters: [{ type: 'labels' as const, column: 0, labels: ['seattle'] }] };
    const s = variable().selectionStatsList(q, { rows: [0, 0], cols: [2, 2] });
    assert.deepEqual([s.cells, s.numbers, s.sum], [1, 1, 300.5]);
    const all = variable().selectionStatsList(q, { all: true });
    assert.deepEqual([all.cells, all.numbers, all.sum, all.texts], [6, 2, 350.5, 4]);
  });

  it('has no min and max without numbers', () => {
    const s = variable().selectionStatsList({ pageSize: 1 }, { rows: [0, 1], cols: [0, 1] });
    assert.deepEqual([s.numbers, s.min, s.max, s.texts], [0, undefined, undefined, 4]);
  });
});

describe('selectionStatsPivot', () => {
  it('counts missing records as empty cells', () => {
    // Rows i, columns j and the fields: seattle has no topeka record, san-diego no chicago record.
    const s = variable().selectionStatsPivot({ rowDims: [0], colDims: [1], hidden: [3] }, { all: true });
    assert.equal(s.cells, 6);
    assert.equal(s.numbers, 3);
    assert.equal(s.sum, 625.5);
    assert.deepEqual(s.specials, { minf: 1 });
  });
});

describe('selectionStats', () => {
  it('uses the number format of the view and the table view if chosen', () => {
    const view = variable();
    const req = { type: 'selection' as const, name: 'x', selection: { all: true }, query: { view: 'table' as const, rowDims: [0], colDims: [1], hidden: [3], format: { precision: 2 } } };
    const s = selectionStats(view, req, format);
    assert.equal(s.sum, 625.5);
    assert.equal(s.format.precision, 2);
    assert.equal(describeStats(s)!.text, 'Sum: 6.3E+02  Average: 2.1E+02  Count: 3');
  });
});

describe('describeStats', () => {
  it('shows nothing for a single cell', () => {
    assert.equal(describeStats({ cells: 1, numbers: 1, sum: 3, min: 3, max: 3, specials: {}, texts: 0, format }), undefined);
  });

  it('shows sum, average and count, and the details in the tooltip', () => {
    const d = describeStats({ cells: 4, numbers: 2, sum: 3, min: 1, max: 2, specials: { eps: 1, pinf: 1 }, texts: 0, format })!;
    assert.equal(d.text, 'Sum: 3  Average: 1.5  Count: 2');
    assert.match(d.tooltip, /^4 cells selected\nNumbers: 2\nSum: 3\nAverage: 1\.5\nMin: 1\nMax: 2\nSpecial values \(not counted as numbers\): EPS: 1, \+INF: 1$/);
  });

  it('shows only the count without numbers', () => {
    assert.equal(describeStats({ cells: 3, numbers: 0, sum: 0, specials: {}, texts: 3, format })!.text, 'Count: 0');
  });
});
