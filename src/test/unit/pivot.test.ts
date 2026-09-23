import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseUelTable } from '../../parse';
import { TableView, symbolTable } from '../../table';

/** x(i,j) with level/marginal, as a variable would be dumped. */
function variable() {
  return new TableView(
    symbolTable({
      columns: ['i', 'j', 'Level', 'Marginal'],
      keyCount: 2,
      rows: [
        ['seattle', 'new-york', '50', '0'],
        ['seattle', 'chicago', '300', '0'],
        ['san-diego', 'new-york', '275', '0'],
        ['san-diego', 'topeka', '275', 'Eps'],
      ],
    }),
  );
}

function parameter() {
  return new TableView(
    symbolTable({
      columns: ['i', 'Value'],
      keyCount: 1,
      rows: [
        ['a', '1'],
        ['b', '-5'],
        ['c', 'Eps'],
        ['d', '+Inf'],
        ['e', 'NA'],
        ['f', '1e3'],
      ],
    }),
  );
}

const names = (rows: { cells: string[] }[]) => rows.map((r) => r.cells[0]);

describe('column filters', () => {
  it('filters by included and excluded labels', () => {
    const v = variable();
    const inc = v.query({ pageSize: 10, columnFilters: [{ type: 'labels', column: 1, labels: ['new-york'] }] });
    assert.deepEqual(names(inc.rows), ['seattle', 'san-diego']);
    assert.equal(inc.filteredCount, 2);
    const exc = v.query({ pageSize: 10, columnFilters: [{ type: 'labels', column: 0, labels: ['seattle'], exclude: true }] });
    assert.deepEqual(names(exc.rows), ['san-diego', 'san-diego']);
  });

  it('filters numeric ranges; special values are controlled separately', () => {
    const v = parameter();
    const range = (f: object) => names(v.query({ pageSize: 10, columnFilters: [{ type: 'range', column: 1, ...f }] }).rows);
    assert.deepEqual(range({ min: 0, max: 10 }), ['a', 'c', 'd', 'e']);
    assert.deepEqual(range({ min: 0, max: 10, hideSpecials: ['eps', 'na', 'pinf'] }), ['a']);
    assert.deepEqual(range({ min: 0, max: 10, exclude: true, hideSpecials: ['eps', 'na', 'pinf', 'minf', 'undf'] }), ['b', 'f']);
    assert.deepEqual(range({ max: 0 }), ['b', 'c', 'd', 'e']);
    assert.deepEqual(range({ hideSpecials: ['pinf'] }), ['a', 'b', 'c', 'e', 'f']);
  });

  it('never matches empty cells within a range', () => {
    const v = new TableView({
      columns: [
        { name: 'k', kind: 'key' },
        { name: 'v', kind: 'value' },
      ],
      rows: [{ cells: ['a', ''] }, { cells: ['b', '3'] }],
    });
    assert.deepEqual(names(v.query({ pageSize: 10, columnFilters: [{ type: 'range', column: 1, min: 0 }] }).rows), ['b']);
    assert.deepEqual(names(v.query({ pageSize: 10, columnFilters: [{ type: 'range', column: 1, min: 0, exclude: true }] }).rows), ['a']);
  });

  it('combines column filters with the text search and ignores invalid columns', () => {
    const v = variable();
    const p = v.query({
      pageSize: 10,
      filter: 'york',
      columnFilters: [
        { type: 'range', column: 2, min: 100 },
        { type: 'labels', column: 42, labels: [] },
      ],
    });
    assert.deepEqual(p.rows.map((r) => r.cells.slice(0, 2)), [['san-diego', 'new-york']]);
  });
});

describe('hidden columns', () => {
  it('drops hidden value columns but keeps at least one', () => {
    const v = variable();
    const p = v.query({ pageSize: 10, hidden: [3] });
    assert.deepEqual(p.columnIndex, [0, 1, 2]);
    assert.deepEqual(p.rows[0].cells, ['seattle', 'new-york', '50']);
    assert.deepEqual(v.query({ pageSize: 10, hidden: [2, 3] }).columnIndex, [0, 1, 2, 3]);
    assert.equal(v.toTsv({ pageSize: 1, hidden: [3] }).split('\n')[0], 'i\tj\tLevel');
  });
});

describe('columnValues', () => {
  it('lists labels in GDX order when known, else in order of appearance', () => {
    const v = variable();
    assert.deepEqual(v.columnValues(1).values, ['new-york', 'chicago', 'topeka']);
    v.setUelOrder(['seattle', 'san-diego', 'chicago', 'topeka', 'new-york']);
    assert.deepEqual(v.columnValues(1).values, ['chicago', 'topeka', 'new-york']);
    assert.deepEqual(v.columnValues(3).values, ['0', 'Eps']);
  });
});

describe('pivot', () => {
  it('uses the last dimension as columns and fields as the last header level', () => {
    const v = variable();
    const p = v.pivot({ pageSize: 10, colPageSize: 100 });
    assert.deepEqual(p.rowDims, [0]);
    assert.deepEqual(p.colDims, [1]);
    assert.deepEqual(p.levels, ['j', 'Field']);
    assert.deepEqual(p.headers, [
      ['new-york', 'Level'],
      ['new-york', 'Marginal'],
      ['chicago', 'Level'],
      ['chicago', 'Marginal'],
      ['topeka', 'Level'],
      ['topeka', 'Marginal'],
    ]);
    assert.deepEqual(p.rows, [
      { labels: ['seattle'], cells: ['50', '0', '300', '0', '', ''] },
      { labels: ['san-diego'], cells: ['275', '0', '', '', '275', 'Eps'] },
    ]);
    assert.equal(p.rowCount, 2);
    assert.equal(p.colCount, 6);
  });

  it('respects hidden fields, rearranged dimensions and the GDX order', () => {
    const v = variable();
    v.setUelOrder(['san-diego', 'seattle', 'topeka', 'chicago', 'new-york']);
    const p = v.pivot({ pageSize: 10, colPageSize: 100, hidden: [3], rowDims: [1], colDims: [0] });
    assert.deepEqual(p.headers, [
      ['san-diego', 'Level'],
      ['seattle', 'Level'],
    ]);
    assert.deepEqual(
      p.rows.map((r) => [r.labels[0], ...r.cells]),
      [
        ['topeka', '275', ''],
        ['chicago', '', '300'],
        ['new-york', '275', '50'],
      ],
    );
  });

  it('shows all dimensions as rows or columns', () => {
    const v = variable();
    const rows = v.pivot({ pageSize: 10, colPageSize: 100, rowDims: [0, 1], colDims: [], hidden: [3] });
    assert.deepEqual(rows.levels, ['Field']);
    assert.deepEqual(rows.headers, [['Level']]);
    assert.equal(rows.rowCount, 4);
    const cols = v.pivot({ pageSize: 10, colPageSize: 100, rowDims: [], colDims: [0, 1], hidden: [3] });
    assert.equal(cols.rowCount, 1);
    assert.deepEqual(cols.rows[0].labels, []);
    assert.equal(cols.colCount, 4);
  });

  it('falls back to the default layout for invalid dimensions', () => {
    const p = variable().pivot({ pageSize: 10, colPageSize: 100, rowDims: [0], colDims: [0] });
    assert.deepEqual([p.rowDims, p.colDims], [[0], [1]]);
  });

  it('pages rows and columns and applies filters', () => {
    const v = variable();
    const p = v.pivot({ pageSize: 1, page: 1, colPageSize: 4, colPage: 1 });
    assert.equal(p.pageCount, 2);
    assert.equal(p.colPageCount, 2);
    assert.equal(p.colOffset, 4);
    assert.deepEqual(p.rows, [{ labels: ['san-diego'], cells: ['275', 'Eps'] }]);
    const f = v.pivot({ pageSize: 10, colPageSize: 100, columnFilters: [{ type: 'labels', column: 0, labels: ['seattle'] }] });
    assert.equal(f.filteredCount, 2);
    assert.deepEqual(f.headers.map((hd) => hd[0]), ['new-york', 'new-york', 'chicago', 'chicago']);
  });

  it('shows set elements without text as Y', () => {
    const v = new TableView(symbolTable({ columns: ['i', 'j', 'Text'], keyCount: 2, rows: [['a', 'x', ''], ['b', 'y', 'hello']] }));
    const p = v.pivot({ pageSize: 10, colPageSize: 100 });
    assert.deepEqual(p.levels, ['j']);
    assert.deepEqual(p.rows.map((r) => r.cells), [['Y', ''], ['', 'hello']]);
  });

  it('exports the whole pivot table as TSV', () => {
    const tsv = variable().pivotTsv({ hidden: [3] });
    assert.equal(tsv, 'j\tnew-york\tchicago\ttopeka\ni\tLevel\tLevel\tLevel\nseattle\t50\t300\t\nsan-diego\t275\t\t275\n');
  });
});

describe('parseUelTable', () => {
  it('parses quoted labels in order', () => {
    const text = `$gdxIn edge.gdx\n\nSet uels /\n  'a,b' ,\n  "it's" ,\n  'x"y' ,\n  'süß' /;\n$onEmpty\n`;
    assert.deepEqual(parseUelTable(text), ['a,b', "it's", 'x"y', 'süß']);
  });

  it('handles a single element and files without elements', () => {
    assert.deepEqual(parseUelTable("Set uels /\n  'only' /;\n"), ['only']);
    assert.deepEqual(parseUelTable('$gdxIn x.gdx\n$onEmpty\n'), []);
  });
});
