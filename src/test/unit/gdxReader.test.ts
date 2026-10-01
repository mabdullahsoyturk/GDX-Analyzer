/*
 * The native GDX reader (gdxReader.ts): what it reads from the fixtures, and that it reads them
 * like gdxdump does (compared record by record when a GAMS system is found).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { GdxSource, gdxdumpSource, loadFileInfo, loadSymbolColumns, loadSymbolList, loadUels } from '../../gdxFile';
import { GdxFormatError, GdxReader } from '../../gdxReader';
import { dumpText, symbolCsv } from '../../gdxText';
import type { GdxSymbol, SymbolColumns } from '../../parse';
import { GdxTools, resolveTools } from '../../tools';

const fixtures = path.resolve(__dirname, '../../../test/fixtures');
const samples = path.resolve(__dirname, '../../../samples');
const fixture = (name: string) => path.join(fixtures, name);
const native: GdxSource = { encoding: 'utf-8', tools: () => assert.fail('the native reader needs no tools') };

/** The cells of the records, as the viewer shows them before formatting. */
function rows(data: SymbolColumns): string[][] {
  return Array.from({ length: data.store.length }, (_, r) => data.columns.map((_, c) => data.store.get(r, c)));
}

async function records(file: string, name: string, source = native) {
  const symbol = (await loadFileInfo(source, file)).symbols.find((s) => s.name === name)!;
  return loadSymbolColumns(source, file, symbol);
}

describe('native GDX reader', () => {
  it('reads the symbols with their types, subtypes and domains, and the file information', async () => {
    const info = await loadFileInfo(native, fixture('native.gdx'));
    const by = (name: string) => info.symbols.find((s) => s.name === name)!;
    // As gdxdump lists them: by name.
    assert.deepEqual(info.symbols.slice(0, 4).map((s) => s.name), ['big', 'd20', 'digits', 'dup']);
    assert.deepEqual(by('s'), { name: 's', dim: 1, type: 'Set', records: 3, text: 'a subset with texts', domain: ['i'], domainType: 'Relaxed', entry: 3 });
    assert.equal(by('one').subtype, 'singleton');
    assert.equal(by('vint').subtype, 'integer');
    assert.equal(by('vsc').subtype, 'semicont');
    assert.equal(by('u').type, 'Alias');
    // Scalars have a record even if none is stored.
    assert.equal(by('zero').records, 1);
    assert.deepEqual(by('sparse').domain, ['big']);
    assert.equal(by('d20').dim, 20);
    const version = new Map(info.version);
    assert.equal(version.get('Compression'), '1');
    assert.equal(version.get('Unique Elements'), '70,332');
    assert.match(version.get('Producer')!, /^GAMS Base Module/);
    assert.equal((await loadUels(native, fixture('native.gdx'))).length, 70332);
  });

  it('reads special values, acronyms and the default records of scalars', async () => {
    assert.deepEqual(rows(await records(fixture('native.gdx'), 'specials')), [
      ['eps', 'Eps'],
      ['na', 'NA'],
      ['pinf', '+Inf'],
      ['minf', '-Inf'],
      ['undf', 'Undf'],
      // GAMS stores numbers this close to zero as EPS.
      ['tiny', 'Eps'],
      ['neg', '-2.5'],
      ['half', '0.5'],
      ['two', '2'],
      ['mone', '-1'],
      ['one', '1'],
    ]);
    assert.deepEqual(rows(await records(fixture('native.gdx'), 'level')), [
      ['i1', 'high'],
      ['i2', 'low'],
      ['i3', '7'],
    ]);
    const zero = await records(fixture('native.gdx'), 'zero');
    assert.deepEqual([zero.columns, rows(zero)], [['Value'], [['0']]]);
    const scalar = await records(fixture('native.gdx'), 'escalarL');
    assert.deepEqual([scalar.columns, rows(scalar)], [['Level', 'Marginal', 'Lower', 'Upper', 'Scale'], [['0', '0', '-Inf', '0', '1']]]);
  });

  it('reads keys of every size, many dimensions, repeated domains and set texts', async () => {
    const file = fixture('native.gdx');
    assert.deepEqual(rows(await records(file, 'sparse')), [
      ['b1', '1'],
      ['b33333', '-1'],
      ['b70000', '70000'],
    ]);
    const wide = await records(file, 'wide');
    assert.equal(wide.store.length, 300);
    assert.deepEqual(rows(wide)[299], ['k300', String(300 / 7)]);
    const d20 = await records(file, 'd20');
    assert.deepEqual(rows(d20), [
      ['i1', 'i2', 'i3', 'i1', 'i2', 'i3', 'i1', 'i2', 'i3', 'i1', 'i2', 'i3', 'i1', 'i2', 'i3', 'i1', 'i2', 'i3', 'i1', 'i2', '20'],
      [...Array(20).fill('i3'), '3'],
    ]);
    assert.deepEqual((await records(file, 'dup3')).columns, ['i', 'j', 'i', 'Value']);
    const s = await records(file, 's');
    assert.deepEqual([s.columns, rows(s)], [['i', 'Text'], [['i1', 'first'], ['i2', 'first'], ['i3', '']]]);
    // Labels as stored in the file: quotes, commas and UTF-8.
    assert.deepEqual(rows(await records(fixture('edge.gdx'), 'k')).map((r) => r[0]), ['a,b', "it's", 'x"y', 'süß']);
    // The universe alias reads the unique elements.
    assert.equal((await records(file, 'u')).store.length, 70332);
  });

  it('reads the file formats 5, 6 and 7, compressed or not, alike', async () => {
    const reference = await loadFileInfo(native, fixture('transport1.gdx'));
    for (const variant of ['v5', 'v6u', 'v6c', 'v7c']) {
      const file = fixture(`formats/transport1_${variant}.gdx`);
      const info = await loadFileInfo(native, file);
      assert.ok(info.symbols.length >= 13, variant);
      for (const s of info.symbols) {
        const original = reference.symbols.find((x) => x.name === s.name)!;
        assert.deepEqual(rows(await loadSymbolColumns(native, file, s)), rows(await loadSymbolColumns(native, fixture('transport1.gdx'), original)), `${variant}: ${s.name}`);
      }
    }
  });

  it('reads labels in another encoding', async () => {
    const latin1 = { ...native, encoding: 'windows-1252' };
    const symbol = (await loadFileInfo(latin1, fixture('latin1.gdx'))).symbols.find((s) => s.name === 'c')!;
    assert.match(rows(await loadSymbolColumns(latin1, fixture('latin1.gdx'), symbol)).flat().join(' '), /Größe|stück/);
  });

  describe('errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-reader-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('rejects files that are not GDX files or are damaged', async () => {
      await assert.rejects(GdxReader.open(fixture('make_fixtures.gms')), (e: Error) => e instanceof GdxFormatError && /Not a GDX file/.test(e.message));
      const truncated = path.join(dir, 'truncated.gdx');
      fs.writeFileSync(truncated, fs.readFileSync(fixture('transport1.gdx')).subarray(0, 600));
      await assert.rejects(GdxReader.open(truncated), GdxFormatError);
      await assert.rejects(GdxReader.open(path.join(dir, 'missing.gdx')), /ENOENT/);
    });

    it('stops reading records when aborted', async () => {
      const reader = await GdxReader.open(fixture('native.gdx'));
      const symbol = reader.contents().symbols.find((s) => s.name === 'wide')!;
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(reader.symbolColumns(symbol, abort.signal), /abort/i);
    });

    it('reads files it does not support with gdxdump, if available', async () => {
      // Format version 9 (newer than the reader knows): after the byte order (17 bytes), 123 and "GAMSGDX".
      const newer = path.join(dir, 'newer.gdx');
      const bytes = Buffer.from(fs.readFileSync(fixture('transport1.gdx')));
      assert.equal(bytes.readInt32LE(26), 7);
      bytes.writeInt32LE(9, 26);
      fs.writeFileSync(newer, bytes);
      const logged: string[] = [];
      const fake = { dump: async () => '   Symbol Dim Type Records  Explanatory text\n 1 a      1  Par       2  capacity\n' } as unknown as GdxTools;
      const symbols: GdxSymbol[] = await loadSymbolList({ encoding: 'utf-8', tools: () => fake, log: (l) => logged.push(l) }, newer);
      assert.deepEqual(symbols.map((s) => s.name), ['a']);
      assert.match(logged[0], /with gdxdump: GDX file format version 9 is not supported/);
      // Without gdxdump, the reason is reported.
      await assert.rejects(loadSymbolList({ encoding: 'utf-8', tools: () => assert.fail('no tools') }, newer), /version 9 is not supported/);
    });
  });
});

function tryTools(): GdxTools | undefined {
  try {
    return new GdxTools(resolveTools({ backend: 'gams', gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR }));
  } catch {
    return undefined;
  }
}

const tools = tryTools();

describe('native GDX reader and gdxdump', { skip: tools ? false : 'GAMS tools not found' }, () => {
  const files = [
    ...fs.readdirSync(fixtures).filter((f) => f.endsWith('.gdx')).map(fixture),
    ...fs.readdirSync(fixture('formats')).map((f) => fixture(`formats/${f}`)),
    ...fs.readdirSync(samples).filter((f) => f.endsWith('.gdx')).map((f) => path.join(samples, f)),
  ];

  for (const file of files) {
    it(`read ${path.relative(path.dirname(fixtures), file)} alike`, async () => {
      const encoding = path.basename(file) === 'latin1.gdx' ? 'windows-1252' : 'utf-8';
      const dump = gdxdumpSource(new GdxTools(tools!.tools, () => {}, encoding));
      const ours = { ...native, encoding };
      const expected = await loadFileInfo(dump, file);
      const actual = await loadFileInfo(ours, file);
      assert.deepEqual(actual.symbols, expected.symbols);
      assert.deepEqual(actual.version.map(([k, v]) => [k, v.trim()]), expected.version);
      assert.deepEqual(await loadUels(ours, file), await loadUels(dump, file));
      for (const s of expected.symbols) {
        const [a, b] = await Promise.all([loadSymbolColumns(ours, file, s), loadSymbolColumns(dump, file, s)]);
        assert.deepEqual(a.columns, b.columns, s.name);
        assert.deepEqual(
          a.store.columns.map((c) => c.type),
          b.store.columns.map((c) => c.type),
          s.name,
        );
        assert.deepEqual(rows(a), rows(b), s.name);
      }
      // The text output: gdxdump lists the acronyms off by one (an empty first one, without the last).
      const reader = await GdxReader.open(file, encoding);
      const withoutAcronyms = (t: string) => t.replace(/^\n(Acronym [^\n]*\n)+/, '');
      const gdxdump = new GdxTools(tools!.tools, () => {}, encoding);
      assert.equal(withoutAcronyms(await dumpText(reader)), withoutAcronyms(await gdxdump.dump(file)));
      for (const e of reader.entries) {
        assert.equal(withoutAcronyms(await dumpText(reader, e.name)), withoutAcronyms(await gdxdump.dump(file, { symbol: e.name })), e.name);
        assert.equal(await symbolCsv(reader, e.name), await gdxdump.dump(file, { symbol: e.name, format: 'csv', csvAllFields: true, csvSetText: true }), `${e.name} (CSV)`);
      }
    });
  }
});
