import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeDomainInfo,
  parseCsv,
  parseDiffOutput,
  parseDomainInfo,
  parseSymbolCsv,
  parseSymbols,
  parseVersionInfo,
  pivotDiff,
} from '../../parse';

const SYMBOLS = `   Symbol   Dim Type Records  Explanatory text\r
 1 a          1  Par       2  capacity of plant i in cases\r
 4 cost       0  Equ       1  define objective function\r
 9 ii         1 Alias       0  Aliased with i\r
10 j          1  Set       3  \r
13 x          2  Var       6  shipment quantities in cases\r
`;

const DOMAINS = `SyNr  Type  DomInf Symbol
   4   Par Regular a(i)
  12   Equ    None cost
   3 Alias    None ii(*)
   2   Set    None j(*)
  10   Var Regular x(i, j)
`;

describe('parseSymbols', () => {
  it('parses the symbol table including aliases and empty texts', () => {
    const symbols = parseSymbols(SYMBOLS);
    assert.deepEqual(
      symbols.map((s) => [s.name, s.dim, s.type, s.records, s.text]),
      [
        ['a', 1, 'Par', 2, 'capacity of plant i in cases'],
        ['cost', 0, 'Equ', 1, 'define objective function'],
        ['ii', 1, 'Alias', 0, 'Aliased with i'],
        ['j', 1, 'Set', 3, ''],
        ['x', 2, 'Var', 6, 'shipment quantities in cases'],
      ],
    );
    assert.deepEqual(symbols[4].domain, ['*', '*']);
  });

  it('returns nothing for output without symbols', () => {
    assert.deepEqual(parseSymbols('   Symbol   Dim Type Records  Explanatory text\n'), []);
  });
});

describe('parseDomainInfo', () => {
  it('parses domains and merges them into the symbols', () => {
    const info = parseDomainInfo(DOMAINS);
    assert.deepEqual(info.get('x'), { number: 10, domainType: 'Regular', domain: ['i', 'j'] });
    assert.deepEqual(info.get('cost'), { number: 12, domainType: 'None', domain: [] });
    const merged = mergeDomainInfo(parseSymbols(SYMBOLS), info);
    assert.deepEqual(merged.find((s) => s.name === 'x')?.domain, ['i', 'j']);
    assert.equal(merged.find((s) => s.name === 'a')?.domainType, 'Regular');
    assert.deepEqual(merged.find((s) => s.name === 'j')?.domain, ['*']);
    assert.equal(merged.find((s) => s.name === 'a')?.entry, 4);
  });
});

describe('parseVersionInfo', () => {
  it('parses key/value lines', () => {
    const v = parseVersionInfo('*  File version   : GDX Library C++ V7\n*  Symbols        :   14\n');
    assert.deepEqual(v, [
      ['File version', 'GDX Library C++ V7'],
      ['Symbols', '14'],
    ]);
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, separators and CRLF', () => {
    const rows = parseCsv('"Dim1","Text"\r\n"a,b","has, comma"\r\n"x""y",\r\n"u",Eps\r\n');
    assert.deepEqual(rows, [
      ['Dim1', 'Text'],
      ['a,b', 'has, comma'],
      ['x"y', ''],
      ['u', 'Eps'],
    ]);
  });

  it('handles a missing trailing newline and embedded newlines', () => {
    assert.deepEqual(parseCsv('"a\nb",1\n"c",2'), [
      ['a\nb', '1'],
      ['c', '2'],
    ]);
  });
});

describe('parseSymbolCsv', () => {
  it('labels variable fields and uses domain names for key columns', () => {
    const data = parseSymbolCsv('"i","j","Val","Marginal","Lower","Upper","Scale"\n"seattle","new-york",50,0,0,+Inf,1\n', {
      dim: 2,
      type: 'Var',
      domain: ['i', 'j'],
    });
    assert.deepEqual(data.columns, ['i', 'j', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale']);
    assert.equal(data.keyCount, 2);
    assert.deepEqual(data.rows, [['seattle', 'new-york', '50', '0', '0', '+Inf', '1']]);
  });

  it('keeps DimN for universe domains and labels parameter values', () => {
    const data = parseSymbolCsv('"Dim1","Val"\n"eps",Eps\n', { dim: 1, type: 'Par', domain: ['*'] });
    assert.deepEqual(data.columns, ['Dim1', 'Value']);
  });
});

const DIFF_OUTPUT = `GDXDIFF          55.0.0 2f738565 Aug 11, 2026  (ALPHA) WEI x86 64bit/MS Windows
File1 : transport1.gdx
File2 : transport2.gdx
Summary of differences:
       a   Data are different
   extra   Symbol not found in file 1
specials   Keys are different
Output: C:/tmp/diff.gdx
GDXDiff finished
`;

describe('parseDiffOutput', () => {
  it('parses the summary including the longest (unindented) symbol name', () => {
    const s = parseDiffOutput(DIFF_OUTPUT);
    assert.equal(s.identical, false);
    assert.equal(s.file1, 'transport1.gdx');
    assert.equal(s.file2, 'transport2.gdx');
    assert.deepEqual(s.entries, [
      { symbol: 'a', status: 'Data are different' },
      { symbol: 'extra', status: 'Symbol not found in file 1' },
      { symbol: 'specials', status: 'Keys are different' },
    ]);
    assert.deepEqual(s.messages, []);
  });

  it('recognizes identical files', () => {
    const s = parseDiffOutput('GDXDIFF 55\nFile1 : a.gdx\nFile2 : a.gdx\nNo differences found\nOutput: d.gdx\nGDXDiff finished\n');
    assert.equal(s.identical, true);
    assert.deepEqual(s.entries, []);
  });
});

describe('pivotDiff', () => {
  it('combines dif1/dif2 rows and marks ins1/ins2 rows', () => {
    const data = parseSymbolCsv(
      '"Dim1","Dim2","Val"\n"seattle","dif1",350\n"seattle","dif2",360\n"minf","ins1",-Inf\n"added","ins2",7\n',
      { dim: 2, type: 'Par', domain: ['i', '*'] },
    );
    const diff = pivotDiff(data);
    assert.deepEqual(diff.keyColumns, ['i']);
    assert.deepEqual(diff.valueColumns, ['Value']);
    assert.deepEqual(diff.records, [
      { keys: ['seattle'], status: 'changed', values1: ['350'], values2: ['360'] },
      { keys: ['minf'], status: 'only1', values1: ['-Inf'] },
      { keys: ['added'], status: 'only2', values2: ['7'] },
    ]);
  });
});
