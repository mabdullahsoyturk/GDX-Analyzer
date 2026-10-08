import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT } from '../../format';
import { answerQuery } from '../../query';
import { TableView, symbolTable } from '../../table';

const settings = { pageSize: 2, colPageSize: 10, defaultFormat: DEFAULT_FORMAT };

/** A parameter p(i,j,k) with special values. */
function parameter() {
  return new TableView(
    symbolTable(
      {
        columns: ['i', 'j', 'k', 'Value'],
        keyCount: 3,
        rows: [
          ['a', 'x', 'k1', '1'],
          ['a', 'x', 'k2', '2'],
          ['a', 'y', 'k1', 'Eps'],
          ['b', 'x', 'k1', '4'],
          ['b', 'y', 'k1', '+Inf'],
          ['b', 'y', 'k2', '-1'],
          ['c', 'x', 'k1', 'NA'],
        ],
      },
      { type: 'Par' },
    ),
  );
}

describe('heatmap scales', () => {
  it('span the numbers of all records, with EPS as 0 and without other special values', () => {
    assert.deepEqual(parameter().heatScales([0, 3]), [{ column: 3, min: -1, max: 4 }]);
  });

  it('span the filtered records with a selection', () => {
    const view = parameter();
    const selection = { columnFilters: [{ type: 'labels' as const, column: 0, labels: ['a'] }] };
    assert.deepEqual(view.heatScales([3], selection), [{ column: 3, min: 0, max: 2 }]);
    // All records again (the scales are cached separately).
    assert.deepEqual(view.heatScales([3]), [{ column: 3, min: -1, max: 4 }]);
  });

  it('leave out columns with a single number', () => {
    const view = parameter();
    const selection = { columnFilters: [{ type: 'labels' as const, column: 0, labels: ['c'] }] };
    assert.deepEqual(view.heatScales([3], selection), []);
  });

  it('span the aggregated cells in a table view with aggregated dimensions', () => {
    // Sums over k: a.x = 3, a.y = Eps, b.x = 4, b.y = +Inf (not on the scale), c.x = NA.
    assert.deepEqual(parameter().pivotHeatScales({ rowDims: [0], colDims: [1], aggDims: [2] }, false), [{ column: 3, min: 0, max: 4 }]);
    assert.deepEqual(parameter().pivotHeatScales({ rowDims: [0], colDims: [1], aggDims: [2], aggregate: 'count' }, false), [{ column: 3, min: 1, max: 2 }]);
  });

  it('span the records in a table view without aggregated dimensions', () => {
    const view = parameter();
    const columnFilters = [{ type: 'labels' as const, column: 2, labels: ['k2'] }];
    assert.deepEqual(view.pivotHeatScales({ rowDims: [0, 1], colDims: [2], columnFilters }, true), [{ column: 3, min: -1, max: 2 }]);
    assert.deepEqual(view.pivotHeatScales({ rowDims: [0, 1], colDims: [2], columnFilters }, false), [{ column: 3, min: -1, max: 4 }]);
  });
});

describe('answerQuery heatmap', () => {
  it('sends the scales of the shown value columns only with heatmap', () => {
    assert.equal(answerQuery(parameter(), {}, settings).heat, undefined);
    const list = answerQuery(parameter(), { heatmap: true }, settings);
    assert.deepEqual(list.heat, [{ column: 3, min: -1, max: 4 }]);
    // Of all records, whatever the page; of the filtered ones with heatmapFiltered.
    const filters = [{ type: 'labels' as const, column: 0, labels: ['b'] }];
    assert.deepEqual(answerQuery(parameter(), { heatmap: true, columnFilters: filters, page: 1 }, settings).heat, [{ column: 3, min: -1, max: 4 }]);
    assert.deepEqual(answerQuery(parameter(), { heatmap: true, heatmapFiltered: true, columnFilters: filters }, settings).heat, [{ column: 3, min: -1, max: 4 }]);
    assert.deepEqual(answerQuery(parameter(), { heatmap: true, heatmapFiltered: true, columnFilters: [{ type: 'labels', column: 0, labels: ['a'] }] }, settings).heat, [
      { column: 3, min: 0, max: 2 },
    ]);
  });

  it('tells the value column of each cell of the table view', () => {
    const a = answerQuery(parameter(), { view: 'table', rowDims: [0, 1], colDims: [2], heatmap: true }, settings);
    assert.equal(a.kind, 'pivot');
    if (a.kind === 'pivot') {
      assert.deepEqual(a.cellColumns, [3, 3]);
      assert.deepEqual(a.heat, [{ column: 3, min: -1, max: 4 }]);
    }
  });

  it('gives each field of a variable its own scale', () => {
    const view = new TableView(
      symbolTable(
        {
          columns: ['i', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'],
          keyCount: 1,
          rows: [
            ['a', '1', '0', '0', '+Inf', '1'],
            ['b', '5', '-2', '0', '+Inf', '1'],
          ],
        },
        { type: 'Var', subtype: 'positive' },
      ),
    );
    // Lower, Upper and Scale have a single value each.
    assert.deepEqual(answerQuery(view, { heatmap: true, hidden: [2] }, settings).heat, [{ column: 1, min: 1, max: 5 }]);
  });
});
