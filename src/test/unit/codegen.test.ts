import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CodeLanguage, domainLabels, symbolCode } from '../../codegen';
import type { SymbolViewState } from '../../export';
import { loadFileInfo, loadSymbolColumns } from '../../gdxFile';
import { GdxSymbol, parseUelTable } from '../../parse';
import { TableView, columnTable, symbolTable } from '../../table';
import { GdxTools, resolveTools } from '../../tools';

const root = path.resolve(__dirname, '../../..');
const fixtures = path.join(root, 'test/fixtures');

describe('copy as code', () => {
  const symbol: GdxSymbol = { name: 'x', type: 'Var', subtype: 'positive', dim: 2, domain: ['i', 'j'], records: 2, text: '' };
  const columns = ['i', 'j', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'];
  const view = new TableView(symbolTable({ columns, keyCount: 2, rows: [['a', 'b', '1', '0', '0', '+Inf', '1']] }, symbol));

  it('names the dimension columns like GAMS Transfer', () => {
    assert.deepEqual(domainLabels(['i', 'j']), ['i', 'j']);
    assert.deepEqual(domainLabels(['*', '*']), ['uni_0', 'uni_1']);
    assert.deepEqual(domainLabels(['i', 'j', 'i']), ['i_0', 'j', 'i_2']);
  });

  it('reads the symbol with GAMS Transfer or GAMSPy', () => {
    assert.equal(
      symbolCode({ language: 'transfer', file: '/data/out.gdx', symbol, view }),
      'import gams.transfer as gt\n\nm = gt.Container()\nm.read("/data/out.gdx", symbols=["x"])\nx = m["x"]\ndf = x.records\n\nprint(df)\n',
    );
    const gamspy = symbolCode({ language: 'gamspy', file: 'C:\\runs\\out.gdx', symbol: { ...symbol, name: 'in' }, view });
    assert.match(gamspy, /^import gamspy as gp\n\nm = gp\.Container\(\)\nm\.read\(r"C:\\runs\\out\.gdx", symbol_names=\["in"\]\)\nin_ = m\["in"\]\ndf = in_\.records\n/);
  });

  it('translates filters, the solution status, sorting and fields, and notes what it cannot', () => {
    const state: SymbolViewState = {
      columnFilters: [
        { type: 'labels', column: 0, labels: ['a'], exclude: true },
        { type: 'range', column: 2, min: 1, hideSpecials: ['na'] },
      ],
      solution: 'atUpper',
      search: { text: 'foo', filterRows: true },
      sortColumn: 3,
      sortDescending: true,
      sortAbsolute: true,
      hidden: [4, 5, 6],
    };
    const code = symbolCode({ language: 'transfer', file: 'out.gdx', symbol, view, state });
    assert.match(code, /^import numpy as np\nimport gams\.transfer as gt\n/);
    assert.match(code, /df = df\[~df\["i"\]\.isin\(\["a"\]\)\]/);
    assert.match(code, /v = df\["level"\]\ndf = df\[\(\(v >= 1\) \| sv\.isEps\(v\) \| sv\.isUndef\(v\) \| sv\.isPosInf\(v\) \| sv\.isNegInf\(v\)\) & ~sv\.isNA\(v\)\]/);
    assert.match(code, /np\.isfinite\(b\) & \(\(l - b\)\.abs\(\) <= 0\.000001 \* np\.maximum\(1, b\.abs\(\)\)\)/);
    assert.match(code, /df = df\.sort_values\("marginal", key=lambda s: s\.abs\(\), ascending=False, kind="stable"\)/);
    assert.match(code, /df = df\[\["i", "j", "level", "marginal"\]\]/);
    assert.match(code, /# Note: The text search "foo" is not translated\./);
  });

  it('writes the table view as a pivot table, with aggregation and totals', () => {
    const state: SymbolViewState = { view: 'table', rowDims: [0], colDims: [], aggDims: [1], aggregate: 'max', totals: true, hidden: [3, 4, 5, 6] };
    const code = symbolCode({ language: 'gamspy', file: 'out.gdx', symbol, view, state });
    assert.match(code, /table = df\.pivot_table\(index=\["i"\], values="level", aggfunc="max", observed=True, margins=True, margins_name="Max"\)\n\n# Note: pandas skips NA/);
    assert.match(code, /print\(table\)\n$/);
  });
});

/** A Python with GAMS Transfer (and maybe GAMSPy): GDX_TEST_PYTHON or the .venv of the repository. */
function findPython(): string | undefined {
  const candidates = [process.env.GDX_TEST_PYTHON, path.join(root, '.venv/bin/python'), path.join(root, '.venv/Scripts/python.exe')];
  return candidates.find((p) => p && fs.existsSync(p) && spawnSync(p, ['-c', 'import gams.transfer'], { stdio: 'ignore' }).status === 0);
}

function tryTools(): GdxTools | undefined {
  try {
    return new GdxTools(resolveTools({ backend: 'gams', gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR }));
  } catch {
    return undefined;
  }
}

const python = findPython();
const tools = tryTools();
const hasGamspy = !!python && spawnSync(python, ['-c', 'import gamspy'], { stdio: 'ignore' }).status === 0;

describe('copy as code: the code gives the records of the view', { skip: python && tools ? false : 'Python with GAMS Transfer or the GAMS tools not found' }, () => {
  const file = path.join(fixtures, 'transport1.gdx');

  async function viewOf(name: string) {
    const info = await loadFileInfo(tools!, file);
    const symbol = info.symbols.find((s) => s.name === name)!;
    const data = await loadSymbolColumns(tools!, file, symbol);
    const view = new TableView(columnTable(data.columns, data.keyCount, data.store, symbol));
    view.setUelOrder(parseUelTable(await tools!.dump(file, { uelTable: 'uels', noData: true })));
    return { symbol, view };
  }

  /** Runs the code and returns what it prints of the result as rows of text (numbers rounded). */
  function run(code: string): string[][] {
    // A pivot table's row labels are its index.
    const csv = code.replace(/print\((df|table)\)\n$/, (_, v) => `import sys\n${v === 'table' ? 'table.reset_index()' : 'df'}.to_csv(sys.stdout, index=False, header=False)\n`);
    const r = spawnSync(python!, ['-c', csv], { encoding: 'utf8', cwd: fixtures });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(',').map(norm));
  }

  /** A cell as compared: numbers rounded, special values by name, empty cells as NaN. */
  const norm = (v: string) => {
    if (v === '' || /^nan$/i.test(v) || v === 'NA' || v === 'Undf') return 'NaN';
    if (/^-?inf$/i.test(v)) return v.startsWith('-') ? '-Inf' : '+Inf';
    if (v === 'Eps' || v === '-0.0') return '0';
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : v;
  };

  /** The records of the view (list) or the cells of the table view, like run() prints them. */
  function expected(view: TableView, state: SymbolViewState): string[][] {
    if (state.view === 'table') {
      const p = view.pivot({ ...state, format: undefined, pageSize: 1000, colPageSize: 1000 });
      return p.rows.map((r) => [...r.labels, ...r.cells].map(norm));
    }
    const page = view.query({ ...state, format: undefined, pageSize: 1000 });
    return page.rows.map((r) => r.cells.map(norm));
  }

  const cases: [string, string, SymbolViewState][] = [
    ['x', 'a range and sorting', { columnFilters: [{ type: 'range', column: 2, min: 1, max: 1000 }], sortColumn: 2, sortDescending: true }],
    ['x', 'the solution status and hidden fields', { solution: 'atLower', hidden: [4, 5, 6] }],
    ['supply', 'a non-zero marginal', { solution: 'marginal' }],
    ['specials', 'special values in a range', { columnFilters: [{ type: 'range', column: 1, min: 0, max: 0, hideSpecials: ['na'] }] }],
    ['d', 'labels and sorting by magnitude', { columnFilters: [{ type: 'labels', column: 1, labels: ['chicago'], exclude: true }], sortColumn: 2, sortDescending: true, sortAbsolute: true }],
    ['d', 'the table view', { view: 'table', rowDims: [0], colDims: [1] }],
  ];
  for (const [name, what, state] of cases) {
    for (const language of ['transfer', 'gamspy'] as CodeLanguage[]) {
      it(`${name}: ${what} (${language})`, { skip: language === 'gamspy' && !hasGamspy ? 'GAMSPy not found' : false }, async () => {
        const { symbol, view } = await viewOf(name);
        const code = symbolCode({ language, file, symbol, view, state });
        assert.deepEqual(run(code), expected(view, state));
      });
    }
  }

  it('aggregates with totals like the table view', async () => {
    const { symbol, view } = await viewOf('d');
    const state: SymbolViewState = { view: 'table', rowDims: [0], colDims: [], aggDims: [1], totals: true };
    const rows = run(symbolCode({ language: 'transfer', file, symbol, view, state }));
    assert.deepEqual(rows, [
      ['seattle', '6'],
      ['san-diego', '5.7'],
      ['Sum', '11.7'],
    ]);
  });
});
