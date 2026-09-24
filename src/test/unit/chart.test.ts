import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pivotDiff } from '../../parse';
import { answerQuery } from '../../query';
import { FIELD_SERIES, MAX_CHART_SERIES, TableView, diffTable, symbolTable } from '../../table';

function shipments() {
  const view = new TableView(
    symbolTable({
      columns: ['i', 'j', 'Level', 'Marginal'],
      keyCount: 2,
      rows: [
        ['seattle', 'new-york', '50', '0'],
        ['seattle', 'chicago', '300', 'NA'],
        ['san-diego', 'new-york', '275', 'Eps'],
        ['san-diego', 'topeka', '275', '0.009'],
        ['seattle', 'topeka', '+Inf', '0'],
      ],
    }),
  );
  view.setUelOrder(['seattle', 'san-diego', 'new-york', 'chicago', 'topeka']);
  return view;
}

describe('chart', () => {
  it('shows the last dimension as categories and the first as series by default, in GDX order', () => {
    const c = shipments().chart({});
    assert.deepEqual(c.chart, { type: 'bar', x: 1, series: 0, value: 2, fields: [] });
    assert.deepEqual(c.categories, ['new-york', 'chicago', 'topeka']);
    assert.deepEqual(
      c.series.map((s) => [s.name, s.slot, s.values]),
      [
        ['seattle', 0, [50, 300, null]],
        ['san-diego', 1, [275, null, 275]],
      ],
    );
    assert.deepEqual(c.skipped, { pinf: 1 });
    assert.deepEqual(c.summed, []);
  });

  it('sums the dimensions that are not on an axis, counts Eps as 0 and skips other special values', () => {
    const c = shipments().chart({ chart: { x: 0, series: -1, value: 3 } });
    assert.deepEqual(c.categories, ['seattle', 'san-diego']);
    assert.deepEqual(c.summed, [1]);
    assert.deepEqual(c.series.map((s) => [s.name, s.values]), [['Marginal', [0, 0.009]]]);
    assert.deepEqual(c.skipped, { na: 1 });
    assert.equal(c.eps, 1);
  });

  it('follows the filters of the view', () => {
    const c = shipments().chart({ chart: { x: 1, series: -1 }, columnFilters: [{ type: 'labels', column: 0, labels: ['seattle'] }] });
    assert.deepEqual(c.categories, ['new-york', 'chicago', 'topeka']);
    assert.deepEqual(c.series[0].values, [50, 300, null]);
    assert.equal(c.filteredCount, 3);
  });

  it('keeps the palette slot of a series when others are filtered out', () => {
    const c = shipments().chart({ columnFilters: [{ type: 'labels', column: 0, labels: ['san-diego'] }] });
    assert.deepEqual(c.series.map((s) => [s.name, s.slot]), [['san-diego', 1]]);
  });

  it('sums the series beyond the palette as "Other"', () => {
    const rows = Array.from({ length: 12 }, (_, k) => [`s${k + 1}`, 'a', String(k + 1)]);
    const c = new TableView(symbolTable({ columns: ['s', 'c', 'Value'], keyCount: 2, rows })).chart({ chart: { x: 1, series: 0 } });
    assert.equal(c.series.length, MAX_CHART_SERIES);
    assert.deepEqual(c.series.slice(-2).map((s) => [s.name, s.slot, s.values]), [
      ['s7', 6, [7]],
      ['Other (5)', -1, [8 + 9 + 10 + 11 + 12]],
    ]);
  });

  it('gives a heatmap one row per series label and always a row dimension', () => {
    const c = shipments().chart({ chart: { type: 'heatmap', x: 1, series: -1 } });
    assert.equal(c.chart.series, 0);
    assert.deepEqual(c.series.map((s) => s.name), ['seattle', 'san-diego']);
  });

  it('is answered with the values formatted like the view', () => {
    const a = answerQuery(shipments(), { view: 'chart', chart: { x: 0, series: -1, value: 3 }, format: { style: 'f', precision: 2 } }, {
      pageSize: 10,
      colPageSize: 10,
      defaultFormat: { style: 'g', precision: 6, squeeze: true },
    });
    assert.equal(a.kind, 'chart');
    assert.deepEqual(a.kind === 'chart' && a.series[0].texts, ['0', '0.01']);
  });
});

describe('charts of comparisons', () => {
  // i, Status, Level (file 1), Level (file 2), Δ Level
  const view = () =>
    new TableView(
      diffTable(
        pivotDiff({
          columns: ['i', 'Dim2', 'Level'],
          keyCount: 2,
          rows: [
            ['seattle', 'dif1', '50'],
            ['seattle', 'dif2', '60'],
            ['chicago', 'dif1', '300'],
            ['chicago', 'dif2', '280'],
            ['topeka', 'ins2', '5'],
          ],
        }),
      ),
    );

  it('shows the differences by default, colored by their sign', () => {
    const c = view().chart({});
    assert.equal(view().table.columns[c.chart.value].name, 'Δ Level');
    assert.deepEqual(c.categories, ['seattle', 'chicago', 'topeka']);
    assert.deepEqual(c.series.map((s) => s.values), [[10, -20, null]]);
    assert.equal(c.signColors, true);
  });

  it('shows the values of both files as two series', () => {
    const c = view().chart({ chart: { series: FIELD_SERIES, fields: [2, 3] } });
    assert.deepEqual(
      c.series.map((s) => [s.name, s.slot, s.values]),
      [
        ['Level (file 1)', 0, [50, 300, null]],
        ['Level (file 2)', 1, [60, 280, 5]],
      ],
    );
    assert.equal(c.signColors, false);
    assert.deepEqual(c.chart.fields, [2, 3]);
  });

  it('falls back to a single value for a heatmap', () => {
    const c = view().chart({ chart: { type: 'heatmap', series: FIELD_SERIES, fields: [2, 3] } });
    assert.deepEqual(c.chart.fields, []);
    assert.notEqual(c.chart.series, FIELD_SERIES);
  });
});
