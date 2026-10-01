/*
 * Comparing GDX files natively as gdxdiff does (gdxDiff.ts) and writing GDX files (gdxWriter.ts):
 * what they give for the fixtures, and that they give what gdxdiff gives (when a GAMS system is found).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { gdxDiff } from '../../gdxDiff';
import { GdxReader, RAW_BYTES } from '../../gdxReader';
import { dumpText } from '../../gdxText';
import { GdxWriter, RAW } from '../../gdxWriter';
import { parseDiffOutput } from '../../parse';
import { DiffOptions, GdxTools, resolveTools } from '../../tools';

const fixture = (name: string) => path.resolve(__dirname, '../../../test/fixtures', name);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-diff-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const out = () => path.join(dir, `diff${++n}.gdx`);

async function compare(a: string, b: string, options: DiffOptions = {}) {
  const file = out();
  const result = await gdxDiff(fixture(a), fixture(b), file, options);
  const reader = await GdxReader.open(file);
  /** A symbol of the difference file, as gdxdump writes it (without the acronyms). */
  const text = async (name: string) => (await dumpText(reader, name)).replace(/^\n(Acronym [^\n]*\n)+/, '');
  return { result, summary: parseDiffOutput(result.stdout), reader, text };
}

describe('GDX writer', () => {
  it('writes symbols that read back with their records, special values, texts and acronyms', async () => {
    const w = new GdxWriter('test', 'GDX Analyzer');
    const [a, b, c] = ['a', 'b', 'c'].map((l) => w.uel(l));
    assert.equal(w.uel('A'), a, 'labels are case-insensitive');
    w.startSymbol('s', 'a "quoted" text', 1, 0, 0);
    w.record([b], [w.setText('second')]);
    w.record([a], [w.setText('first\ttab')]);
    w.endSymbol();
    w.startSymbol('p', '', 2, 1, 0, { min: [1, 1], max: [3, 3] });
    w.record([a, a], [0]);
    w.record([a, b], [RAW.eps]);
    w.record([a, c], [-0.5]);
    w.record([b, a], [RAW.na]);
    w.record([c, c], [3 * RAW.acronym]);
    w.endSymbol();
    w.startSymbol('x', 'flows', 1, 2, 3);
    w.record([a], [1.5, 0, 0, RAW.pinf, 1]);
    w.endSymbol();
    const file = out();
    await w.write(file);
    const r = await GdxReader.open(file);
    assert.deepEqual(
      r.contents().symbols.map((s) => [s.name, s.type, s.dim, s.records, s.text, s.subtype]),
      [
        ['p', 'Par', 2, 5, '', undefined],
        // Quotes become the first one (MakeGoodExplText).
        ['s', 'Set', 1, 2, 'a "quoted" text', undefined],
        ['x', 'Var', 1, 1, 'flows', 'positive'],
      ],
    );
    assert.equal(await dumpText(r, 's'), "\nAcronym UnknownACRO3;\n\nSet s(*) 'a \"quoted\" text' /\n'a' first?tab, \n'b' second /;\n");
    assert.match(await dumpText(r, 'p'), /'a'\.'b' Eps, \n'a'\.'c' -0\.5, \n'b'\.'a' NA, \n'c'\.'c' UnknownACRO3 \/;/);
    assert.match(await dumpText(r, 'x'), /'a'\.L 1\.5 \/;/);
  });
});

describe('native gdxdiff', () => {
  it('summarizes the differences and writes them with dif1, dif2, ins1 and ins2', async () => {
    const { result, summary, text } = await compare('pair1.gdx', 'pair2.gdx');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(
      summary.entries.map((e) => `${e.symbol}: ${e.status}`),
      [
        'd20: Dim >= maxdim & different',
        'dchange: Dimensions are different',
        'domchg: Keys are different',
        'eE: Keys are different',
        'eL: Data are different',
        'lev: Data are different',
        'newp: Symbol not found in file 1',
        'only1: Symbol not found in file 2',
        'pi_: Data are different',
        's2: Data are different',
        'sp: Keys are different',
        'tchange: Types are different',
        'w: Data are different',
        'x: Data are different',
        'z: Data are different',
      ],
    );
    assert.deepEqual(summary.messages, ['*** symbol = dchange cannot be compared', 'Dim1 = 1, Dim2 = 2', '*** symbol = tchange cannot be compared', 'Typ1 = Parameter, Typ2 = Set']);
    assert.equal(await text('sp'), "\nParameter sp(*,*) Differences /\n'eps'.'ins1' Eps, \n'na'.'dif1' NA, \n'na'.'dif2' 5, \n'one'.'dif1' 1, \n'one'.'dif2' 1.0000001, \n'extra'.'ins2' 9 /;\n");
    assert.equal(await text('s2'), "\nSet s2(*,*) Differences /\n'i2'.'dif1' second, \n'i2'.'dif2' changed, \n'i3'.'ins2' 'new text' /;\n");
    // Records of a variable: all fields of both files.
    assert.match(await text('x'), /^\npositive Variable x\(\*,\*,\*\) Differences \/\n'i1'\.'a'\.'dif1'\.L 2, \n'i1'\.'a'\.'dif1'\.M 0\.5, \n'i1'\.'a'\.'dif2'\.L 2, \n'i1'\.'a'\.'dif2'\.M Eps, /);
  });

  it('applies tolerances, fields, DiffOnly, FldOnly, ID and SkipID', async () => {
    // w('k2') changed by 1e-9 and w('k3') by 0.1%.
    assert.doesNotMatch(await (await compare('pair1.gdx', 'pair2.gdx', { eps: 1e-6 })).text('w'), /k2/);
    assert.doesNotMatch(await (await compare('pair1.gdx', 'pair2.gdx', { relEps: 0.01 })).text('w'), /k3/);
    const level = await compare('pair1.gdx', 'pair2.gdx', { field: 'L', fieldOnly: true });
    assert.equal(await level.text('x'), "\nParameter x(*,*,*) 'Differences Field = Level' /\n'i2'.'b'.'dif1' 4, \n'i2'.'b'.'dif2' 4.5, \n'i3'.'a'.'ins1' 4 /;\n");
    const diffOnly = await compare('pair1.gdx', 'pair2.gdx', { diffOnly: true });
    assert.match(await diffOnly.text('x'), /^\nParameter x\(\*,\*,\*,\*\) Differences Only \/\n'i1'\.'a'\.'Marginal'\.'dif1' 0\.5, \n'i1'\.'a'\.'Marginal'\.'dif2' Eps, /);
    const ids = await compare('pair1.gdx', 'pair2.gdx', { ids: ['W', 'x'], skipIds: ['x'] });
    assert.deepEqual(ids.summary.entries.map((e) => e.symbol), ['w']);
    assert.match(ids.result.stdout, /^ID    : W x\nSkipID: x$/m);
  });

  it('keeps labels byte for byte, also bytes 0x80-0x9F of UTF-8 (ß is C3 9F)', async () => {
    const raw = await GdxReader.open(fixture('edge.gdx'), RAW_BYTES);
    assert.ok(raw.uels.some((u) => Buffer.from(u, 'latin1').equals(Buffer.from('süß', 'utf8'))));
    const { reader } = await compare('native.gdx', 'types.gdx');
    const written = await GdxReader.open(reader.file, 'utf-8');
    assert.ok(written.uels.includes('süß'));
    assert.ok(!written.uels.some((u) => u.includes('\ufffd')));
  });

  it('reports identical files and names the files compared', async () => {
    const { result, summary, text } = await compare('transport1.gdx', 'transport1.gdx');
    assert.equal(result.exitCode, 0);
    assert.equal(summary.identical, true);
    assert.equal(await text('FilesCompared'), `\nSet FilesCompared(*) /\n'File1' '${fixture('transport1.gdx')}', \n'File2' '${fixture('transport1.gdx')}' /;\n`);
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

describe('native gdxdiff and gdxdiff', { skip: tools ? false : 'GAMS tools not found' }, () => {
  const pairs = [
    ['pair1.gdx', 'pair2.gdx'],
    ['pair2.gdx', 'pair1.gdx'],
    ['transport1.gdx', 'transport2.gdx'],
    ['native.gdx', 'types.gdx'],
    ['formats/transport1_v5.gdx', 'transport2.gdx'],
  ];
  const optionSets: DiffOptions[] = [
    {},
    { eps: 0.5 },
    { eps: 1e-6, relEps: 1e-6 },
    { field: 'M' },
    { field: 'L', fieldOnly: true },
    { diffOnly: true },
    { compareDefaults: true, compareDomains: true },
    { ignoreOrder: true, ignoreSetText: true },
    { ids: ['x', 'w', 'eE'], skipIds: ['w'] },
  ];
  /** A difference file as gdxdump writes it: the data, the symbols, their domains and the labels. */
  const dumps = async (file: string) => [
    await tools!.dump(file),
    await tools!.dump(file, { symbols: true }),
    await tools!.dump(file, { domainInfo: true }),
    (await tools!.dump(file, { uelTable: 'u', noData: true })).replace(/^\$gdxIn .*\n/m, ''),
  ];
  const summary = (stdout: string) => {
    const s = parseDiffOutput(stdout);
    return { ...s, messages: s.messages.filter((m) => !/^(GDXDIFF|Output)/.test(m)) };
  };
  for (const [a, b] of pairs) {
    it(`compares ${a} with ${b} alike`, async () => {
      for (const options of optionSets) {
        const [expected, actual] = [out(), out()];
        const x = await tools!.diff(fixture(a), fixture(b), expected, options);
        const y = await gdxDiff(fixture(a), fixture(b), actual, options);
        const what = JSON.stringify(options);
        assert.equal(y.exitCode, x.exitCode, what);
        assert.deepEqual(summary(y.stdout), summary(x.stdout), what);
        assert.deepEqual(await dumps(actual), await dumps(expected), what);
      }
    });
  }
});
