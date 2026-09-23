import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fieldDefaults, inferEquationType, sameValue } from '../../defaults';
import { mergeSubtypes, parseSubtypes, parseSymbolCsv, parseSymbols } from '../../parse';
import { TableView, symbolTable } from '../../table';
import { GdxTools, resolveTools } from '../../tools';

const NODATA = `$gdxIn types.gdx
Set i(*) ;
Singleton Set s(*) ;
free     Variable vfree(i) ; !!empty
positive Variable x(i,j) shipment quantities in cases ;
semicont Variable vsc(i) ;
Equation eE(i) ;
Alias (ii, i);
`;

describe('subtypes', () => {
  it('parses variable subtypes and singleton sets from the declarations', () => {
    const m = parseSubtypes(NODATA);
    assert.deepEqual([...m], [
      ['s', 'singleton'],
      ['vfree', 'free'],
      ['x', 'positive'],
      ['vsc', 'semicont'],
    ]);
    const symbols = mergeSubtypes(parseSymbols(' 1 X  2 Var 6  shipment\n 2 i 1 Set 2  \n'), m);
    assert.equal(symbols[0].subtype, 'positive');
    assert.equal(symbols[1].subtype, undefined);
  });
});

describe('defaults', () => {
  it('compares numbers numerically and special values by name', () => {
    assert.ok(sameValue('1', '1.0'));
    assert.ok(sameValue('+Inf', '+Inf'));
    assert.ok(!sameValue('0', 'Eps'));
    assert.ok(!sameValue('', '0'));
  });

  it('infers equation types from the bounds', () => {
    const cols = ['i', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'];
    const rows = (lo: string, up: string) => [['a', '1', '0', lo, up, '1']];
    assert.equal(inferEquationType(rows('3', '3'), 3, 4), 'E');
    assert.equal(inferEquationType(rows('-Inf', '5'), 3, 4), 'L');
    assert.equal(inferEquationType(rows('5', '+Inf'), 3, 4), 'G');
    assert.equal(inferEquationType(rows('-Inf', '+Inf'), 3, 4), 'N');
    assert.equal(inferEquationType([...rows('3', '3'), ...rows('-Inf', '5')], 3, 4), undefined);
    assert.deepEqual(fieldDefaults('Equ', undefined, cols, rows('-Inf', '5')), [undefined, '0', '0', '-Inf', '0', '1']);
    assert.deepEqual(fieldDefaults('Var', 'binary', cols, []), [undefined, '0', '0', '0', '1', '1']);
    assert.deepEqual(fieldDefaults('Var', undefined, cols, []), [undefined, '0', '0', undefined, undefined, '1']);
    assert.deepEqual(fieldDefaults('Par', undefined, ['i', 'Value'], []), [undefined, undefined]);
  });
});

// Squeezable fields of every variable and equation type in test/fixtures/types.gdx
// (levels were assigned, so every field except the level has its default value).
const fixture = path.resolve(__dirname, '../../../test/fixtures/types.gdx');
for (const backend of ['gams', 'gamspy'] as const) {
  let tools: GdxTools | undefined;
  try {
    tools = new GdxTools(resolveTools({ backend, gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR, gamspyExecutable: process.env.GDX_TEST_GAMSPY }));
  } catch {
    tools = undefined;
  }
  describe(`squeezing defaults (${backend} backend)`, { skip: tools ? false : `${backend} tools not found` }, () => {
    it('hides every field but the level for all types', async () => {
      const t = tools!;
      const symbols = mergeSubtypes(parseSymbols(await t.dump(fixture, { symbols: true })), parseSubtypes(await t.dump(fixture, { noData: true })));
      const checked: string[] = [];
      for (const s of symbols.filter((x) => x.type === 'Var' || x.type === 'Equ')) {
        const csv = await t.dump(fixture, { symbol: s.name, format: 'csv', csvAllFields: true, dFormat: 'hexBytes' });
        const data = parseSymbolCsv(csv, s);
        const view = new TableView(symbolTable(data, s));
        const hidden = view.squeezableColumns().map((c) => data.columns[c]);
        assert.deepEqual(hidden, ['Marginal', 'Lower', 'Upper', 'Scale'], `${s.name} (${s.subtype ?? 'equation'})`);
        checked.push(s.name);
      }
      assert.equal(checked.length, 13);
    });
  });
}
