/*
 * gdxdump's text output written natively (gdxText.ts): numbers, the normal format and CSV.
 * gdxReader.test.ts compares them with gdxdump's when a GAMS system is found.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { GdxReader } from '../../gdxReader';
import { dumpText, formatDouble, symbolCsv } from '../../gdxText';

const fixture = (name: string) => path.resolve(__dirname, '../../../test/fixtures', name);

describe('gdxdump text written natively', () => {
  it('writes numbers like gdxdump: 15 digits, fixed from 1e-4 to below 1e15, ties to even', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [-0, '0'],
      [50, '50'],
      [0.009000000000000008, '0.00900000000000001'],
      [153.675, '153.675'],
      [1 / 3, '0.333333333333333'],
      [-2.5, '-2.5'],
      [0.0001, '0.0001'],
      [9.999999999999999e-5, '1E-4'],
      [999999999999999.9, '1000000000000000'],
      [1e15, '1E15'],
      [1.5e30, '1.5E30'],
      [-7.25e-12, '-7.25E-12'],
      // Ties at the 16th digit go to the even 15th digit (JavaScript would round them up).
      [1234567890123465, '1.23456789012346E15'],
      [1234567890123455, '1.23456789012346E15'],
      [5e-324, '4.94065645841247E-324'],
    ];
    assert.deepEqual(
      cases.map(([x]) => formatDouble(x)),
      cases.map(([, s]) => s),
    );
  });

  it('dumps a symbol: declaration, records and defaults left out', async () => {
    const reader = await GdxReader.open(fixture('transport1.gdx'));
    assert.equal(await dumpText(reader, 'a'), "\nParameter a(i) capacity of plant i in cases /\n'seattle' 350, \n'san-diego' 600 /;\n");
    assert.equal(await dumpText(reader, 'f'), '\nScalar f freight in dollars per case per thousand miles / 90 /;\n');
    assert.equal(await dumpText(reader, 'ii'), '\nAlias (ii, i);\n');
    // Fields with their default value are left out; symbol names are case-insensitive.
    assert.match(await dumpText(reader, 'X'), /^\npositive Variable x\(i,j\) shipment quantities in cases \/\n'seattle'\.'new-york'\.L 50, \n'seattle'\.'chicago'\.L 300, \n'seattle'\.'topeka'\.M 0\.036, /);
    assert.match(await dumpText(reader, 'z'), /^\nfree     Variable z total transportation costs \/L 153\.675 \/;\n$/);
    await assert.rejects(dumpText(reader, 'nope'), /Symbol not found: nope/);
  });

  it('dumps a whole file and lists its acronyms', async () => {
    const text = await dumpText(await GdxReader.open(fixture('transport1.gdx')));
    assert.match(text, /^\$onEmpty\n\nSet i\(\*\) canning plants \/\n'seattle' 'Seattle WA', \n'san-diego' 'San Diego CA' \/;\n/);
    assert.match(text, /\n\$offEmpty\n$/);
    // All acronyms (gdxdump lists an empty first one instead of the last).
    assert.match(await dumpText(await GdxReader.open(fixture('native.gdx')), 'level'), /^\nAcronym high;\nAcronym low;\n\nParameter level\(\*\) acronyms \/\n'i1' high, \n'i2' low, \n'i3' 7 \/;\n$/);
  });

  it('writes CSV with all fields and set texts', async () => {
    const reader = await GdxReader.open(fixture('transport1.gdx'));
    assert.equal(await symbolCsv(reader, 'i'), '"Dim1","Text"\n"seattle","Seattle WA"\n"san-diego","San Diego CA"\n');
    assert.match(await symbolCsv(reader, 'x'), /^"i","j","Val","Marginal","Lower","Upper","Scale"\n"seattle","new-york",50,0,0,\+Inf,1\n/);
    assert.equal(await symbolCsv(await GdxReader.open(fixture('edge.gdx')), 'k'), '"Dim1","Text"\n"a,b","has, comma"\n"it\'s","single quote"\n"x""y","dq label"\n"süß","ümlaut ""text"""\n');
  });
});
