import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TableView, symbolTable } from '../../table';

function variable() {
  return new TableView(
    symbolTable({
      columns: ['i', 'j', 'Level', 'Marginal'],
      keyCount: 2,
      rows: [
        ['seattle', 'new-york', '50', '0'],
        ['seattle', 'chicago', '300.5', '0'],
        ['san-diego', 'new-york', '275', '0.009000000000000008'],
        ['a,b', 'x"y', '1e-12', 'Eps'],
      ],
    }),
  );
}

const tab = { separator: '\t' as const, labels: true };
const csv = { separator: ',' as const, labels: true };

describe('copyList', () => {
  it('copies a rectangle of the shown cells without headers', () => {
    const r = variable().copyList({ pageSize: 1 }, { rows: [2, 1], cols: [1, 2] }, tab);
    assert.equal(r.text, 'chicago\t300.5\nnew-york\t275\n');
    assert.equal(r.cells, 4);
  });

  it('copies everything with the column names', () => {
    const r = variable().copyList({ pageSize: 1, hidden: [3] }, { all: true }, tab);
    assert.equal(r.text.split('\n')[0], 'i\tj\tLevel');
    assert.equal(r.cells, 12);
  });

  it('follows the filters and the sort order of the view', () => {
    const q = { pageSize: 1, sortColumn: 2, sortDescending: true, columnFilters: [{ type: 'labels' as const, column: 0, labels: ['seattle'] }] };
    assert.equal(variable().copyList(q, { rows: [0, 1], cols: [2, 2] }, tab).text, '300.5\n50\n');
  });

  it('quotes CSV fields and applies the decimal separator to numbers only', () => {
    const r = variable().copyList({ pageSize: 1 }, { rows: [1, 3], cols: [0, 3] }, { ...csv, decimalSeparator: ',' });
    assert.equal(r.text, 'seattle,chicago,"300,5",0\nsan-diego,new-york,275,"0,009000000000000008"\n"a,b","x""y",1e-12,Eps\n');
  });

  it('copies exact values regardless of the display format', () => {
    const q = { pageSize: 1, format: { style: 'g' as const, precision: 2, squeeze: true } };
    assert.equal(variable().copyList(q, { rows: [2, 2], cols: [3, 3] }, tab).text, '0.009000000000000008\n');
  });

  it('clamps out-of-range selections', () => {
    assert.equal(variable().copyList({ pageSize: 1 }, { rows: [3, 99], cols: [0, 0] }, tab).text, 'a,b\n');
    assert.deepEqual(variable().copyList({ pageSize: 1, filter: 'nothing' }, { all: true }, tab).cells, 0);
  });
});

describe('copyPivot', () => {
  it('copies selected cells with their row and column labels', () => {
    const v = variable();
    // Columns: new-york Level, new-york Marginal, chicago Level, chicago Marginal, x"y Level, x"y Marginal
    const r = v.copyPivot({ hidden: [] }, { rows: [0, 1], cols: [0, 2] }, tab);
    assert.equal(r.text, 'j\tnew-york\tnew-york\tchicago\ni\tLevel\tMarginal\tLevel\nseattle\t50\t0\t300.5\nsan-diego\t275\t0.009000000000000008\t\n');
    assert.equal(r.cells, 6);
  });

  it('copies without labels', () => {
    const r = variable().copyPivot({ hidden: [3] }, { rows: [0, 1], cols: [0, 1] }, { separator: ',', labels: false });
    assert.equal(r.text, '50,300.5\n275,\n');
  });

  it('copies everything with labels', () => {
    const lines = variable().copyPivot({ hidden: [3] }, { all: true }, csv).text.trim().split('\n');
    assert.deepEqual(lines, ['j,new-york,chicago,"x""y"', 'i,Level,Level,Level', 'seattle,50,300.5,', 'san-diego,275,,', '"a,b",,,1e-12']);
  });
});

describe('limits', () => {
  it('refuses grids beyond their limits before building them', async () => {
    const { GridTooLargeError } = await import('../../table');
    const v = variable();
    assert.throws(() => v.copyList({ pageSize: 1 }, { all: true }, { ...tab, limits: { maxCells: 10, what: 'Copying' } }), (e: Error) => e instanceof GridTooLargeError && /Copying has 20 cells; at most 10/.test(e.message));
    assert.throws(() => v.gridPivot({}, { all: true }, true, { maxCols: 3 }), /columns; at most 3/);
    assert.equal(v.copyList({ pageSize: 1 }, { rows: [0, 0], cols: [0, 0] }, { ...tab, limits: { maxCells: 1 } }).cells, 1);
  });
});
