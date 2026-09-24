/*
 * Runs gdxdump/gdxdiff through both backends against the fixtures in test/fixtures.
 * Backends that are not installed are skipped. Override the detection with
 * GDX_TEST_GAMS_DIR (a GAMS system directory) and GDX_TEST_GAMSPY (a gamspy executable).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { parseDiffOutput, parseSymbolCsv, parseSymbols, parseUelTable, pivotDiff } from '../../parse';
import { Backend, GdxTools, ResolvedTools, ToolNotFoundError, buildDiffArgs, buildDumpArgs, resolveTools, run, textDecoder } from '../../tools';

const fixtures = path.resolve(__dirname, '../../../test/fixtures');
const t1 = path.join(fixtures, 'transport1.gdx');
const t2 = path.join(fixtures, 'transport2.gdx');
const edge = path.join(fixtures, 'edge.gdx');
const latin1 = path.join(fixtures, 'latin1.gdx');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx ext test '));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('argument building', () => {
  it('uses GAMS syntax for gdxdump and gdxdiff', () => {
    assert.deepEqual(buildDumpArgs('gams', 'a.gdx', { symbol: 'x', format: 'csv', csvAllFields: true, csvSetText: true }), [
      'a.gdx',
      'Symb=x',
      'Format=csv',
      'CSVAllFields',
      'CSVSetText',
    ]);
    assert.deepEqual(buildDiffArgs('gams', 'a.gdx', 'b.gdx', 'd.gdx', { eps: 0.1, field: 'L', ids: ['x', 'y'] }), [
      'a.gdx',
      'b.gdx',
      'd.gdx',
      'Eps=0.1',
      'Field=L',
      'ID=x',
      'ID=y',
    ]);
  });

  it('uses GAMSPy CLI syntax', () => {
    assert.deepEqual(buildDumpArgs('gamspy', 'a.gdx', { symbols: true }), ['gdx', 'dump', 'a.gdx', '--symbols']);
    assert.deepEqual(buildDumpArgs('gamspy', 'a.gdx', { uelTable: 'uels', noData: true }), ['gdx', 'dump', 'a.gdx', '--ueltable', 'uels', '--nodata']);
    assert.deepEqual(buildDumpArgs('gams', 'a.gdx', { uelTable: 'uels', noData: true }), ['a.gdx', 'UelTable=uels', 'NoData']);
    assert.deepEqual(buildDiffArgs('gamspy', 'a.gdx', 'b.gdx', 'd.gdx', { relEps: 0.01, field: 'All', ignoreOrder: true }), [
      'gdx',
      'diff',
      'a.gdx',
      'b.gdx',
      'd.gdx',
      '--releps',
      '0.01',
      '--ignoreorder',
    ]);
  });
});

function tryResolve(backend: Backend): ResolvedTools | undefined {
  try {
    return resolveTools({
      backend,
      gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR,
      gamspyExecutable: process.env.GDX_TEST_GAMSPY,
    });
  } catch {
    return undefined;
  }
}

for (const backend of ['gams', 'gamspy'] as const) {
  const resolved = tryResolve(backend);
  describe(`${backend} backend`, { skip: resolved ? false : `${backend} tools not found` }, () => {
    const tools = new GdxTools(resolved!);

    it('lists symbols', async () => {
      const symbols = parseSymbols(await tools.dump(t1, { symbols: true }));
      assert.deepEqual(
        symbols.map((s) => s.name),
        ['a', 'b', 'c', 'cost', 'd', 'demand', 'f', 'i', 'ii', 'j', 'specials', 'supply', 'x', 'z'],
      );
    });

    it('dumps variables with all fields', async () => {
      const csv = await tools.dump(t1, { symbol: 'x', format: 'csv', csvAllFields: true, csvSetText: true });
      const data = parseSymbolCsv(csv, { dim: 2, type: 'Var', domain: ['i', 'j'] });
      assert.equal(data.rows.length, 6);
      assert.deepEqual(data.rows[0], ['seattle', 'new-york', '50', '0', '0', '+Inf', '1']);
    });

    it('reads exact values with dFormat=hexBytes', async () => {
      const csv = await tools.dump(t1, { symbol: 'x', format: 'csv', csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' });
      const data = parseSymbolCsv(csv, { dim: 2, type: 'Var', domain: ['i', 'j'] });
      assert.deepEqual(data.rows[0], ['seattle', 'new-york', '50', '0', '0', '+Inf', '1']);
      assert.equal(data.rows[4][3], '0.009000000000000008');
      const specials = parseSymbolCsv(await tools.dump(t1, { symbol: 'specials', format: 'csv', dFormat: 'hexBytes' }), { dim: 1, type: 'Par', domain: ['*'] });
      assert.deepEqual(specials.rows.map((r) => r[1]), ['Eps', 'NA', '+Inf', '-Inf']);
    });

    it('handles labels with quotes, commas and non-ASCII characters', async () => {
      const csv = await tools.dump(edge, { symbol: 'k', format: 'csv', csvSetText: true });
      const data = parseSymbolCsv(csv, { dim: 1, type: 'Set', domain: ['*'] });
      assert.deepEqual(data.rows, [
        ['a,b', 'has, comma'],
        ["it's", 'single quote'],
        ['x"y', 'dq label'],
        ['süß', 'ümlaut "text"'],
      ]);
    });

    it('decodes labels and texts with the configured encoding', async () => {
      const read = async (t: GdxTools) => parseSymbolCsv(await t.dump(latin1, { symbol: 'c', format: 'csv', csvSetText: true }), { dim: 1, type: 'Set', domain: ['*'] }).rows;
      assert.deepEqual(await read(new GdxTools(resolved!, undefined, 'windows-1252')), [
        ['stück', 'Größe'],
        ['b', ''],
      ]);
      // As UTF-8, the Latin-1 bytes are invalid and replaced.
      assert.equal((await read(tools))[0][0], 'st\uFFFDck');
      const uels = parseUelTable(await new GdxTools(resolved!, undefined, 'latin1').dump(latin1, { uelTable: 'uels', noData: true }));
      assert.deepEqual(uels, ['stück', 'b']);
      const chunks: string[] = [];
      await new GdxTools(resolved!, undefined, 'windows-1252').dumpStream(latin1, { symbol: 'p' }, (c) => chunks.push(c));
      assert.match(chunks.join(''), /précis/);
    });

    it('lists the unique elements in GDX order', async () => {
      const uels = parseUelTable(await tools.dump(t1, { uelTable: 'uels', noData: true }));
      assert.deepEqual(uels.slice(0, 5), ['seattle', 'san-diego', 'new-york', 'chicago', 'topeka']);
      assert.deepEqual(parseUelTable(await tools.dump(edge, { uelTable: 'uels', noData: true })), ['a,b', "it's", 'x"y', 'süß']);
    });

    it('works with paths containing spaces', async () => {
      const copy = path.join(tmp, `copy ${backend}.gdx`);
      fs.copyFileSync(t1, copy);
      assert.match(await tools.dump(copy, { symbol: 'a' }), /seattle/);
    });

    it('reports unknown symbols as errors', async () => {
      await assert.rejects(tools.dump(t1, { symbol: 'nope' }), /Symbol not found: nope/);
    });

    it('compares files', async () => {
      const diffFile = path.join(tmp, `diff ${backend}.gdx`);
      const result = await tools.diff(t1, t2, diffFile);
      assert.equal(result.exitCode, 1);
      const summary = parseDiffOutput(result.stdout);
      assert.deepEqual(
        summary.entries.map((e) => e.symbol),
        ['a', 'extra', 'specials', 'supply', 'x'],
      );
      const csv = await tools.dump(diffFile, { symbol: 'specials', format: 'csv', csvAllFields: true });
      const diff = pivotDiff(parseSymbolCsv(csv, { dim: 2, type: 'Par', domain: ['*', '*'] }));
      assert.deepEqual(
        diff.records.map((r) => [r.keys[0], r.status]),
        [
          ['minf', 'only1'],
          ['added', 'only2'],
        ],
      );
    });

    it('compares files given by relative paths', async () => {
      const cwd = process.cwd();
      process.chdir(fixtures);
      try {
        const result = await tools.diff('transport1.gdx', 'transport2.gdx', path.relative(fixtures, path.join(tmp, `relative ${backend}.gdx`)));
        assert.equal(result.exitCode, 1);
        assert.ok(fs.existsSync(path.join(tmp, `relative ${backend}.gdx`)));
      } finally {
        process.chdir(cwd);
      }
    });

    it('recognizes identical files', async () => {
      const result = await tools.diff(t1, t1, path.join(tmp, `same ${backend}.gdx`));
      assert.equal(result.exitCode, 0);
      assert.equal(parseDiffOutput(result.stdout).identical, true);
    });
  });
}

describe('output encoding', () => {
  it('rejects unknown encodings before running the tool', async () => {
    assert.throws(() => textDecoder('no-such-encoding'), /Unknown text encoding "no-such-encoding"/);
    assert.throws(() => run(process.execPath, ['-e', ''], { encoding: 'no-such-encoding' }), RangeError);
  });

  it('decodes collected and streamed output', async () => {
    const script = "process.stdout.write(Buffer.from([0x73, 0x74, 0xfc, 0x63, 0x6b]))";
    assert.equal((await run(process.execPath, ['-e', script], { encoding: 'windows-1252' })).stdout, 'stück');
    let streamed = '';
    await run(process.execPath, ['-e', script], { encoding: 'windows-1252', onStdout: (c) => (streamed += c) });
    assert.equal(streamed, 'stück');
  });
});

describe('gdxdiff options', () => {
  it('builds the arguments of all options', () => {
    const o = { field: 'L', fieldOnly: true, diffOnly: true, compareDefaults: true, ignoreSetText: true, ids: ['a'], skipIds: ['b', 'c'] };
    assert.deepEqual(buildDiffArgs('gams', '1.gdx', '2.gdx', 'd.gdx', o), ['1.gdx', '2.gdx', 'd.gdx', 'Field=L', 'FldOnly', 'CmpDefaults', 'SetDesc=N', 'ID=a', 'SkipID=b', 'SkipID=c']);
    assert.deepEqual(buildDiffArgs('gamspy', '1.gdx', '2.gdx', 'd.gdx', { diffOnly: true, skipIds: ['b'] }), ['gdx', 'diff', '1.gdx', '2.gdx', 'd.gdx', '--diffonly', '--skipid', 'b']);
    // Field only needs a field; without it, diff only applies.
    assert.deepEqual(buildDiffArgs('gams', '1', '2', 'd', { fieldOnly: true, diffOnly: true }), ['1', '2', 'd', 'DiffOnly']);
  });
});

const samples = path.resolve(__dirname, '../../../samples');
for (const backend of ['gams', 'gamspy'] as const) {
  const resolved = tryResolve(backend);
  describe(`gdxdiff options (${backend} backend)`, { skip: resolved ? false : `${backend} tools not found` }, () => {
    const tools = new GdxTools(resolved!);
    const base = path.join(samples, 'base.gdx');
    const scenario = path.join(samples, 'scenario.gdx');
    const out = (n: string) => path.join(tmp, `${backend} ${n}.gdx`);
    const entries = async (n: string, o: object) => parseDiffOutput((await tools.diff(base, scenario, out(n), o)).stdout).entries.map((e) => e.symbol);

    it('compares only or skips symbols', async () => {
      assert.deepEqual(await entries('ids', { ids: ['price', 'capacity'] }), ['capacity', 'price']);
      const skipped = await entries('skip', { skipIds: ['orders', 'demand'] });
      assert.ok(!skipped.includes('orders') && !skipped.includes('demand') && skipped.includes('price'));
    });

    it('ignores set texts', async () => {
      await tools.diff(base, scenario, out('settext'), { ids: ['r'], ignoreSetText: true });
      const csv = await tools.dump(out('settext'), { symbol: 'r', format: 'csv', csvSetText: true });
      assert.deepEqual(parseSymbolCsv(csv, { dim: 2, type: 'Set', domain: ['*', '*'] }).rows.map((r) => r[0]), ['south']);
    });

    it('writes field-only and diff-only layouts that the difference view can pivot', async () => {
      await tools.diff(base, scenario, out('fld'), { ids: ['make'], field: 'L', fieldOnly: true });
      const fld = parseSymbols(await tools.dump(out('fld'), { symbols: true })).find((s) => s.name === 'make')!;
      assert.deepEqual([fld.type, fld.dim], ['Par', 4]);

      await tools.diff(base, scenario, out('only'), { ids: ['cap'], diffOnly: true });
      const sym = parseSymbols(await tools.dump(out('only'), { symbols: true })).find((s) => s.name === 'cap')!;
      assert.equal(sym.dim, 4);
      const data = parseSymbolCsv(await tools.dump(out('only'), { symbol: 'cap', format: 'csv', dFormat: 'hexBytes' }), { ...sym, domain: ['r', 't', 'Field', '*'] });
      const diff = pivotDiff(data);
      assert.deepEqual(diff.keyColumns, ['r', 't', 'Field']);
      assert.deepEqual(diff.records[0].keys, ['north', 'jan', 'Marginal']);
      assert.equal(diff.records[0].status, 'changed');
    });
  });
}

for (const backend of ['gams', 'gamspy'] as const) {
  const resolved = tryResolve(backend);
  describe(`cancelling (${backend} backend)`, { skip: resolved ? false : `${backend} tools not found` }, () => {
    it('stops gdxdiff when the signal is aborted', async () => {
      const tools = new GdxTools(resolved!);
      const abort = new AbortController();
      const running = tools.diff(t1, t2, path.join(tmp, `cancel ${backend}.gdx`), {}, { signal: abort.signal });
      abort.abort();
      await assert.rejects(running, (err: Error) => err.name === 'AbortError');
    });
  });
}

describe('bundled tools', () => {
  const exe = (n: string) => (process.platform === 'win32' ? n + '.exe' : n);
  const fake = () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'bundled '));
    for (const t of ['gdxdump', 'gdxdiff']) fs.writeFileSync(path.join(dir, exe(t)), '', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'VERSION'), 'GAMS 54.4.0\n');
    return dir;
  };

  it('are preferred by auto, with their version, and made executable', () => {
    const dir = fake();
    const t = resolveTools({ backend: 'auto', bundledDirectory: dir });
    assert.deepEqual([t.backend, t.bundled, t.location, t.gdxdump], ['gams', { version: 'GAMS 54.4.0' }, dir, path.join(dir, exe('gdxdump'))]);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'gdxdump')).mode & 0o111, 0o111);
  });

  it('are skipped by auto and the gams backend when the package has none', () => {
    const t = tryResolve('gams');
    if (!t) return;
    assert.equal(resolveTools({ backend: 'auto', bundledDirectory: path.join(tmp, 'missing'), gamsSystemDirectory: t.location }).bundled, undefined);
    assert.equal(resolveTools({ backend: 'gams', bundledDirectory: fake(), gamsSystemDirectory: t.location }).bundled, undefined);
  });

  it('are required by the bundled backend', () => {
    assert.throws(() => resolveTools({ backend: 'bundled', bundledDirectory: path.join(tmp, 'missing') }), (e: Error) => e instanceof ToolNotFoundError && /no bundled gdxdump\/gdxdiff for/.test(e.message));
  });
});
