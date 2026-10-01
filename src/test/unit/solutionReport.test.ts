import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT } from '../../format';
import { loadFileInfo } from '../../gdxFile';
import type { GdxSymbol } from '../../parse';
import { SolutionReportBuilder, recordName, showReport, solutionReport } from '../../solutionReport';
import { TableView, TopRows, symbolTable } from '../../table';
import { GdxTools, ResolvedTools, resolveTools } from '../../tools';

const FIELDS = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'];

function view(type: 'Var' | 'Equ', rows: string[][], subtype?: string) {
  return new TableView(symbolTable({ columns: ['i', ...FIELDS], keyCount: 1, rows }, { type, subtype }));
}

function symbol(name: string, type: 'Var' | 'Equ', records: number, entry: number): GdxSymbol & { type: 'Var' | 'Equ' } {
  return { name, type, dim: 1, domain: ['i'], records, text: '', entry, subtype: type === 'Var' ? 'positive' : undefined };
}

/** A positive variable with records outside, at and within their bounds. */
const x = () =>
  view(
    'Var',
    [
      ['inside', '5', '0', '0', '10', '1'],
      ['below', '-0.5', '0', '0', '10', '1'],
      ['above', '13', '0', '0', '10', '1'],
      ['tiny', '10.000001', '0', '0', '10', '1'],
      ['lower', '0', '2', '0', '10', '1'],
      ['minusInf', '-Inf', '0', '0', '10', '1'],
      ['eps', 'Eps', 'Eps', '0', '10', '1'],
    ],
    'positive',
  );

/** An =L= equation: two binding rows, one violated. */
const e = () =>
  view('Equ', [
    ['a', '10', '-3', '-Inf', '10', '1'],
    ['b', '4', '0', '-Inf', '10', '1'],
    ['c', '11.5', '0', '-Inf', '10', '1'],
    ['d', '10', '7', '-Inf', '10', '1'],
  ]);

describe('TopRows', () => {
  it('keeps the rows with the largest amounts, the first ones of equal amounts', () => {
    const top = new TopRows(3);
    [5, 1, 9, 5, 7, 5, 2].forEach((amount, row) => top.add(row, amount));
    assert.deepEqual(top.sorted(), [
      { row: 2, amount: 9 },
      { row: 4, amount: 7 },
      { row: 0, amount: 5 },
    ]);
    const none = new TopRows(0);
    none.add(0, 1);
    assert.deepEqual(none.sorted(), []);
  });
});

describe('solution summary', () => {
  it('ranks the records outside their bounds by how far outside they are', () => {
    const s = x().solutionSummary(10)!;
    // Within the tolerance of 1e-6 relative to the bound, "tiny" is at its bound, not outside it.
    assert.deepEqual(
      s.infeasible.map((r) => [r.keys[0], r.amount]),
      [
        ['minusInf', Infinity],
        ['above', 3],
        ['below', 0.5],
      ],
    );
    assert.deepEqual(s.infeasible[1], { keys: ['above'], level: '13', marginal: '0', lower: '0', upper: '10', amount: 3 });
    assert.equal(s.counts.find((c) => c.filter === 'infeasible')?.count, 3);
  });

  it('ranks the records with a non-zero or EPS marginal by |marginal|', () => {
    assert.deepEqual(
      e().solutionSummary(10)!.marginals.map((r) => [r.keys[0], r.amount]),
      [
        ['d', 7],
        ['a', 3],
      ],
    );
    // EPS marginals count, with |marginal| 0.
    assert.deepEqual(
      x().solutionSummary(10)!.marginals.map((r) => [r.keys[0], r.marginal, r.amount]),
      [
        ['lower', '2', 2],
        ['eps', 'Eps', 0],
      ],
    );
    assert.equal(e().solutionSummary(1)!.marginals.length, 1);
    assert.equal(e().solutionSummary(10)!.marginalColumn, 2);
  });

  it('does not apply to parameters', () => {
    const par = new TableView(symbolTable({ columns: ['i', 'Value'], keyCount: 1, rows: [['a', '1']] }, { type: 'Par' }));
    assert.equal(par.solutionSummary(10), undefined);
  });
});

describe('solution report', () => {
  const symbols = [symbol('x', 'Var', 7, 1), symbol('e', 'Equ', 4, 2), symbol('empty', 'Equ', 0, 3), symbol('broken', 'Var', 1, 4)];

  function build(top: number) {
    const builder = new SolutionReportBuilder(symbols, top);
    // In any order (the symbols are read concurrently).
    builder.add(symbols[1], e());
    builder.add(symbols[2]);
    builder.fail(symbols[3], 'gdxdump failed');
    builder.add(symbols[0], x());
    return builder.result();
  }

  it('combines the symbols: counts, the farthest outside and the binding constraints', () => {
    const r = build(100);
    assert.deepEqual(r.symbols.map((s) => s.name), ['x', 'e', 'empty', 'broken']);
    assert.equal(r.infeasibleCount, 4);
    assert.deepEqual(r.infeasible.map((x) => recordName(x.symbol, x.keys)), ['x(minusInf)', 'x(above)', 'e(c)', 'x(below)']);
    // Only equations are binding constraints; variables have reduced costs.
    assert.equal(r.bindingCount, 2);
    assert.deepEqual(r.binding.map((x) => recordName(x.symbol, x.keys)), ['e(d)', 'e(a)']);
    assert.deepEqual(r.symbols[0].counts, { marginal: 2, atLower: 2, atUpper: 1, infeasible: 3, nonDefault: 7 });
    assert.equal(r.symbols[0].maxInfeasibility, Infinity);
    assert.equal(r.symbols[0].maxMarginal, 2);
    assert.equal(r.symbols[1].maxInfeasibility, 1.5);
    assert.deepEqual(r.symbols[2].counts, {});
    assert.equal(r.symbols[3].error, 'gdxdump failed');
  });

  it('keeps the first records, in the order of the file for equal amounts', () => {
    const r = build(2);
    assert.deepEqual(r.infeasible.map((x) => x.keys[0]), ['minusInf', 'above']);
    assert.equal(r.infeasibleCount, 4);
    const tie = [symbol('first', 'Equ', 1, 1), symbol('second', 'Equ', 1, 2)];
    const builder = new SolutionReportBuilder(tie, 1);
    const row = [['a', '1', '5', '-Inf', '1', '1']];
    builder.add(tie[1], view('Equ', row));
    builder.add(tie[0], view('Equ', row));
    assert.deepEqual(builder.result().binding.map((x) => x.symbol), ['first']);
  });

  it('formats the numbers for the viewer and keeps them exactly', () => {
    const shown = showReport(build(100), { style: 'f', precision: 1, squeeze: false });
    assert.deepEqual(shown.infeasible[0], { symbol: 'x', type: 'Var', record: 'x(minusInf)', cells: ['-Inf', '0.0', '0.0', '10.0', '+Inf'], exact: ['-Inf', '0', '0', '10', '+Inf'] });
    assert.deepEqual(shown.symbols[1].shown, { maxInfeasibility: ['1.5', '1.5'], maxMarginal: ['7.0', '7'] });
    assert.deepEqual(shown.symbols[2].shown.maxMarginal, ['', '']);
    assert.equal(shown.format.style, 'f');
  });

  it('names records like GAMS, quoting labels where needed', () => {
    assert.equal(recordName('z', []), 'z');
    assert.equal(recordName('x', ['seattle', 'new-york', 'i+1']), 'x(seattle,new-york,i+1)');
    assert.equal(recordName('x', ['new york', 'a,b', "it's", 'süß']), `x('new york','a,b',"it's",'süß')`);
  });
});

function tryResolve(): ResolvedTools | undefined {
  try {
    return resolveTools({ backend: 'gams', gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR });
  } catch {
    return undefined;
  }
}

const resolved = tryResolve();

describe('solution report of a GDX file', { skip: resolved ? false : 'GAMS tools not found' }, () => {
  const file = path.resolve(__dirname, '../../../test/fixtures/solution.gdx');

  it('reads all variables and equations, a few at once, with progress', async () => {
    const tools = new GdxTools(resolved!);
    const { symbols } = await loadFileInfo(tools, file);
    const progress: number[] = [];
    const report = await solutionReport(tools, file, symbols, { top: 2, concurrency: 2, onProgress: (done, total) => progress.push(done / total) });
    assert.deepEqual(report.symbols.map((s) => s.name), ['x', 'z', 'y', 'cap', 'bal']);
    assert.deepEqual(progress, [0.2, 0.4, 0.6, 0.8, 1]);
    assert.equal(report.infeasibleCount, 4);
    assert.deepEqual(report.infeasible.map((r) => [recordName(r.symbol, r.keys), r.amount]), [
      ['x(i4)', 3],
      ['cap(i3)', 1.5],
    ]);
    assert.deepEqual(report.binding.map((r) => recordName(r.symbol, r.keys)), ['bal', 'cap(i1)']);
    assert.equal(report.bindingCount, 3);
  });

  it('stops when aborted', async () => {
    const tools = new GdxTools(resolved!);
    const { symbols } = await loadFileInfo(tools, file);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(solutionReport(tools, file, symbols, { signal: abort.signal }));
  });
});
