import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSheets, connectInstructions, DEFAULT_SPECIALS } from '../../export';
import { DEFAULT_FORMAT } from '../../format';
import type { GdxSymbol } from '../../parse';
import { answerQuery } from '../../query';
import { SolutionFilter, TableView, symbolTable } from '../../table';

const FIELDS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'];

/** A positive variable x(i) whose records cover the cases of the solution filters. */
function variable() {
  const rows = [
    ['basic', '5', '0', '0', '10', '1'],
    ['lower', '0', '2.5', '0', '10', '1'],
    ['upper', '10', '-1', '0', '10', '1'],
    ['nearUpper', '10.000001', '0', '0', '10', '1'],
    ['epsLevel', 'Eps', 'Eps', '0', '+Inf', '1'],
    ['below', '-0.5', '0', '0', '+Inf', '1'],
    ['bigAbove', '1000002', '0', '0', '1000000', '1'],
    ['bigInside', '1000000.5', '0', '0', '1000000', '1'],
    ['na', 'NA', 'NA', '0', '+Inf', '1'],
    ['scaled', '0', '0', '0', '+Inf', '2'],
  ];
  const symbol = { type: 'Var', subtype: 'positive' };
  return new TableView(symbolTable({ columns: ['i', ...FIELDS], keyCount: 1, rows }, symbol));
}

function labels(view: TableView, solution: SolutionFilter): string[] {
  return view.query({ solution, pageSize: 100 }).rows.map((r) => r.cells[0]);
}

describe('solution filters', () => {
  it('finds non-zero and EPS marginals', () => {
    assert.deepEqual(labels(variable(), 'marginal'), ['lower', 'upper', 'epsLevel']);
  });

  it('finds levels at their finite bounds, with a tolerance relative to the bound', () => {
    const view = variable();
    // EPS counts as 0; levels at -Inf/+Inf bounds and NA levels are never at a bound.
    assert.deepEqual(labels(view, 'atLower'), ['lower', 'epsLevel', 'scaled']);
    assert.deepEqual(labels(view, 'atUpper'), ['upper', 'nearUpper', 'bigInside']);
  });

  it('finds levels outside their bounds', () => {
    assert.deepEqual(labels(variable(), 'infeasible'), ['below', 'bigAbove']);
  });

  it('finds records with a field that is not its default', () => {
    // Defaults of a positive variable: level 0, marginal 0, bounds 0 and +Inf, scale 1.
    assert.deepEqual(labels(variable(), 'nonDefault'), ['basic', 'lower', 'upper', 'nearUpper', 'epsLevel', 'below', 'bigAbove', 'bigInside', 'na', 'scaled']);
    const rows = [
      ['a', '0', '0', '0', '+Inf', '1'],
      ['b', '0', '0', '1', '+Inf', '1'],
    ];
    const view = new TableView(symbolTable({ columns: ['i', ...FIELDS], keyCount: 1, rows }, { type: 'Var', subtype: 'positive' }));
    assert.deepEqual(labels(view, 'nonDefault'), ['b']);
  });

  it('combines with column filters, sorting and the table view', () => {
    const view = variable();
    const page = view.query({ solution: 'atUpper', columnFilters: [{ type: 'range', column: 1, max: 100 }], sortColumn: 1, sortDescending: true, pageSize: 100 });
    assert.deepEqual(page.rows.map((r) => r.cells[0]), ['nearUpper', 'upper']);
    assert.equal(page.filteredCount, 2);
    assert.equal(page.totalCount, 10);
    const rows = [
      ['a', 'x', '1', '0', '0', '+Inf', '1'],
      ['a', 'y', '0', '3', '0', '+Inf', '1'],
      ['b', 'x', '0', '0', '0', '+Inf', '1'],
    ];
    const two = new TableView(symbolTable({ columns: ['i', 'j', ...FIELDS], keyCount: 2, rows }, { type: 'Var', subtype: 'positive' }));
    const pivot = two.pivot({ solution: 'marginal', hidden: [3, 4, 5, 6], pageSize: 10, colPageSize: 10 });
    assert.equal(pivot.rows.length, 1);
  });

  it('counts the records of each filter that applies', () => {
    assert.deepEqual(variable().solutionFilters(), [
      { filter: 'marginal', count: 3 },
      { filter: 'atLower', count: 3 },
      { filter: 'atUpper', count: 3 },
      { filter: 'infeasible', count: 2 },
      { filter: 'nonDefault', count: 10 },
    ]);
  });

  it('does not apply to parameters and is ignored for them', () => {
    const view = new TableView(symbolTable({ columns: ['i', 'Value'], keyCount: 1, rows: [['a', '1'], ['b', '0']] }, { type: 'Par' }));
    assert.deepEqual(view.solutionFilters(), []);
    assert.equal(view.query({ solution: 'marginal', pageSize: 10 }).filteredCount, 2);
  });

  it('reports the filters and the active one with each page', () => {
    const settings = { pageSize: 100, colPageSize: 100, defaultFormat: DEFAULT_FORMAT };
    const view = variable();
    const answer = answerQuery(view, { solution: 'infeasible' }, settings);
    assert.equal(answer.solution.active, 'infeasible');
    assert.equal(answer.solution.filters.length, 5);
    assert.equal(answer.kind === 'list' && answer.filteredCount, 2);
    const par = new TableView(symbolTable({ columns: ['i', 'Value'], keyCount: 1, rows: [['a', '1']] }, { type: 'Par' }));
    assert.deepEqual(answerQuery(par, { solution: 'infeasible' }, settings).solution, { filters: [], active: undefined });
  });

  it('is applied by the Excel export and noted in the Connect instructions', () => {
    const symbol: GdxSymbol = { name: 'x', type: 'Var', subtype: 'positive', dim: 1, domain: ['i'], records: 10, text: '' };
    const item = { symbol, view: variable(), state: { solution: 'infeasible' as const } };
    const defaults = { format: DEFAULT_FORMAT, squeezeDefaults: false };
    const options = { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS };
    const [sheet] = buildSheets([item], options, defaults);
    assert.deepEqual(sheet.rows.slice(1).map((r) => r[0].v), ['below', 'bigAbove']);
    assert.equal(buildSheets([item], { ...options, applyFilters: false }, defaults)[0].rows.length, 11);
    assert.match(connectInstructions('x.gdx', 'x.xlsx', [item], options, defaults), /the solution filter "infeasible" is not applied/);
  });
});
