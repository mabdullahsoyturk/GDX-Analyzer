import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SPECIALS, buildSheets, connectInstructions } from '../../export';
import { DEFAULT_FORMAT } from '../../format';
import { pivotDiff } from '../../parse';
import { TableView, diffTable, symbolTable } from '../../table';

function variable() {
  const data = {
    columns: ['i', 'j', 'Level', 'Marginal'],
    keyCount: 2,
    rows: [
      ['a', 'x', '1', '0'],
      ['b', 'y', '2', '5'],
    ],
  };
  const symbol = { name: 'v', dim: 2, type: 'Var' as const, records: 2, text: '', domain: ['i', 'j'], subtype: 'free' };
  return { symbol, view: new TableView(symbolTable(data, symbol)) };
}

describe('column order', () => {
  it('shows the columns in the given order and ignores invalid entries', () => {
    const { view } = variable();
    assert.deepEqual(view.query({ pageSize: 10, order: [3, 1, 0, 2] }).columnIndex, [3, 1, 0, 2]);
    assert.deepEqual(view.query({ pageSize: 10, order: [2, 9, 2, -1] }).columnIndex, [2, 0, 1, 3]);
    assert.deepEqual(view.query({ pageSize: 10, order: [3, 1, 0, 2] }).rows[0].cells, ['0', 'x', 'a', '1']);
    // Hidden columns keep the order of the others.
    assert.deepEqual(view.query({ pageSize: 10, order: [3, 1, 0, 2], hidden: [3] }).columnIndex, [1, 0, 2]);
  });

  it('is followed by copying, searching and the Excel export', () => {
    const { symbol, view } = variable();
    const order = [1, 0, 3, 2];
    assert.equal(view.toTsv({ pageSize: 1, order }), 'j\ti\tMarginal\tLevel\nx\ta\t0\t1\ny\tb\t5\t2\n');
    assert.deepEqual(view.findList({ pageSize: 10, order }, { text: '5', exact: true }).hits, [{ r: 1, c: 2 }]);
    const [sheet] = buildSheets([{ symbol, view, state: { order } }], { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS }, { format: DEFAULT_FORMAT, squeezeDefaults: false });
    assert.deepEqual(sheet.rows[0].map((c) => c.v), ['j', 'i', 'Marginal', 'Level']);
  });

  it('is reproduced by the Connect instructions of the list view', () => {
    const { symbol, view } = variable();
    const yaml = connectInstructions('x.gdx', 'x.xlsx', [{ symbol, view, state: { order: [1, 0, 3, 2] } }], { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS }, { format: DEFAULT_FORMAT, squeezeDefaults: false });
    assert.match(yaml, /name: v\.\[m,l\]\(d1,d2\)\n    newName: v_view\(d2,d1\)/);
  });
});

describe('set elements without text', () => {
  const set = () => new TableView(symbolTable({ columns: ['i', 'j', 'Text'], keyCount: 2, rows: [['a', 'x', ''], ['b', 'z', 'hello']] }));

  it('are shown, searched and copied as Y in the list view', () => {
    const v = set();
    const page = v.query({ pageSize: 10 });
    assert.deepEqual(page.rows.map((r) => r.cells[2]), ['Y', 'hello']);
    assert.equal(page.rows[0].exact, undefined);
    assert.deepEqual(v.findList({ pageSize: 10 }, { text: 'Y', exact: true }).hits, [{ r: 0, c: 2 }]);
    assert.equal(v.toTsv({ pageSize: 1 }), 'i\tj\tText\na\tx\tY\nb\tz\thello\n');
  });

  it('are not confused with missing records in the table view or the comparison', () => {
    assert.deepEqual(set().pivot({ pageSize: 10, colPageSize: 10 }).rows.map((r) => r.cells), [['Y', ''], ['', 'hello']]);
    const diff = diffTable(pivotDiff({ columns: ['i', 'Dim2', 'Text'], keyCount: 2, rows: [['a', 'ins1', '']] }));
    assert.deepEqual(new TableView(diff).query({ pageSize: 10 }).rows[0].cells, ['a', 'only in file 1', '', '']);
  });
});

describe('Excel export of set texts', () => {
  it('follows GAMS Connect: empty in the list layout, Y in the table layout', () => {
    const data = { columns: ['i', 'j', 'Text'], keyCount: 2, rows: [['a', 'x', ''], ['b', 'z', 'hello']] };
    const symbol = { name: 's', dim: 2, type: 'Set' as const, records: 2, text: '', domain: ['i', 'j'] };
    const view = new TableView(symbolTable(data, symbol));
    const opts = { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS };
    const defaults = { format: DEFAULT_FORMAT, squeezeDefaults: false };
    const [list] = buildSheets([{ symbol, view }], opts, defaults);
    assert.deepEqual(list.rows[1].map((c) => c.v), ['a', 'x', '']);
    const [table] = buildSheets([{ symbol, view, state: { view: 'table' } }], opts, defaults);
    assert.deepEqual(table.rows[1].map((c) => c.v), ['a', 'Y', '']);
  });
});
