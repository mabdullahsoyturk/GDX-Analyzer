/*
 * Copying symbols into new GDX files (gdxSubset.ts) and creating GDX files from tables
 * (gdxImport.ts, xlsxRead.ts): read back with the native reader.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { ImportError, cellValue, parseCsv, tableToGdx } from '../../gdxImport';
import { GdxReader, RAW_BYTES } from '../../gdxReader';
import { writeGdxSubset } from '../../gdxSubset';
import { dumpText } from '../../gdxText';
import { RAW } from '../../gdxWriter';
import { DEFAULT_FORMAT } from '../../format';
import { filterSelection } from '../../export';
import { TableView, columnTable } from '../../table';
import { writeXlsx, zip } from '../../xlsx';
import { readXlsx } from '../../xlsxRead';

const fixture = (name: string) => path.resolve(__dirname, '../../../test/fixtures', name);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-subset-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const out = () => path.join(dir, `out${++n}.gdx`);

/** What a symbol is in a file: its table entry, domain and records as gdxdump writes them. */
async function describeSymbol(r: GdxReader, name: string) {
  const e = r.entry(name);
  return { dim: e.dim, dataType: e.dataType, userInfo: e.userInfo, count: e.count, text: e.text, comments: e.comments, domain: r.domainOf(e), dump: await dumpText(r, name) };
}

describe('writeGdxSubset', () => {
  for (const name of ['native.gdx', 'types.gdx', 'edge.gdx', 'transport1.gdx', 'solution.gdx', 'latin1.gdx', 'formats/transport1_v5.gdx', 'formats/transport1_v6c.gdx']) {
    it(`copies every symbol of ${name} unchanged`, async () => {
      const source = await GdxReader.open(fixture(name), RAW_BYTES);
      const file = out();
      const result = await writeGdxSubset(fixture(name), file, source.entries.map((e) => ({ name: e.name })));
      assert.deepEqual(result.relaxed, []);
      const copy = await GdxReader.open(file, RAW_BYTES);
      assert.deepEqual(copy.entries.map((e) => e.name), source.entries.map((e) => e.name));
      for (const e of source.entries) assert.deepEqual(await describeSymbol(copy, e.name), await describeSymbol(source, e.name), e.name);
      assert.deepEqual(copy.acronyms, source.acronyms);
      // Only the labels used, in the order of the source.
      const used = copy.uels.map((u) => source.uels.indexOf(u));
      assert.deepEqual(used, [...used].sort((a, b) => a - b));
    });
  }

  it('copies chosen records, and the set of a chosen alias', async () => {
    const source = await GdxReader.open(fixture('transport1.gdx'), RAW_BYTES);
    const file = out();
    const result = await writeGdxSubset(fixture('transport1.gdx'), file, [{ name: 'ii' }, { name: 'd', rows: [0, 5], recordCount: 6 }]);
    assert.deepEqual(result.symbols, ['i', 'ii', 'd']);
    assert.deepEqual(result.addedSets, ['i']);
    // j is not written: d keeps the names of its domain.
    assert.deepEqual(result.relaxed, [{ name: 'd', reason: 'j not written' }]);
    assert.equal(result.records, 2 + 2);
    const copy = await GdxReader.open(file, RAW_BYTES);
    assert.deepEqual(copy.domainOf(copy.entry('d')), { domain: ['i', 'j'], domainType: 'Relaxed' });
    assert.equal(copy.entry('ii').dataType, 4);
    assert.equal(copy.entry('ii').userInfo, copy.entry('i').entry);
    const lines = (await dumpText(source, 'd')).split('\n').filter((l) => l.includes("'."));
    const copied = (await dumpText(copy, 'd')).split('\n').filter((l) => l.includes("'."));
    assert.deepEqual(copied.map((l) => l.replace(/[,/;\s]+$/, '')), [lines[0], lines[5]].map((l) => l.replace(/[,/;\s]+$/, '')));
  });

  it('keeps regular domains unless records are outside the records of a domain set written', async () => {
    const kept = out();
    await writeGdxSubset(fixture('transport1.gdx'), kept, [{ name: 'i' }, { name: 'j' }, { name: 'd', rows: [0], recordCount: 6 }]);
    const r1 = await GdxReader.open(kept, RAW_BYTES);
    assert.deepEqual(r1.domainOf(r1.entry('d')), { domain: ['i', 'j'], domainType: 'Regular' });

    const relaxed = out();
    const result = await writeGdxSubset(fixture('transport1.gdx'), relaxed, [{ name: 'i', rows: [0], recordCount: 2 }, { name: 'a' }]);
    assert.deepEqual(result.relaxed, [{ name: 'a', reason: '1 record outside the records of i written' }]);
    const r2 = await GdxReader.open(relaxed, RAW_BYTES);
    assert.deepEqual(r2.domainOf(r2.entry('a')), { domain: ['i'], domainType: 'Relaxed' });
  });

  it('saves the records passing the filters of a view, as the viewer finds them', async () => {
    // The symbol as the viewer reads it: its rows are its records in the order of the file.
    const reader = await GdxReader.open(fixture('transport1.gdx'));
    const symbol = reader.contents().symbols.find((s) => s.name === 'x')!;
    const data = await reader.symbolColumns(symbol);
    const view = new TableView(columnTable(data.columns, data.keyCount, data.store, symbol));
    const state = { columnFilters: [{ type: 'labels' as const, column: 1, labels: ['chicago'] }], search: { text: 'seattle', filterRows: true } };
    const rows = view.matchingRows(filterSelection(state, true, DEFAULT_FORMAT));
    assert.equal(rows.length, 1);
    const file = out();
    await writeGdxSubset(fixture('transport1.gdx'), file, [{ name: 'x', rows, recordCount: view.length }]);
    const copy = await GdxReader.open(file);
    const copied = await copy.symbolColumns(copy.contents().symbols.find((s) => s.name === 'x')!);
    assert.equal(copied.store.length, 1);
    assert.deepEqual([copied.store.get(0, 0), copied.store.get(0, 1)], ['seattle', 'chicago']);
    for (let c = 2; c < data.columns.length; c++) assert.equal(copied.store.get(0, c), view.table.store!.get(rows[0], c));
  });

  it('refuses record positions of a file that changed', async () => {
    await assert.rejects(writeGdxSubset(fixture('transport1.gdx'), out(), [{ name: 'd', rows: [0], recordCount: 7 }]), /the file changed/);
  });
});

describe('parseCsv', () => {
  it('reads quoted fields, CRLF line ends and a byte order mark, without blank lines', () => {
    const { rows, separator } = parseCsv('﻿i,"a ""b"", c",v\r\n\r\nx,"multi\nline",1\n');
    assert.equal(separator, ',');
    assert.deepEqual(rows, [
      ['i', 'a "b", c', 'v'],
      ['x', 'multi\nline', '1'],
    ]);
  });

  it('detects semicolons, tabs and bars as separators', () => {
    assert.equal(parseCsv('a;b;c\n1;2;3').separator, ';');
    assert.equal(parseCsv('a\tb\n1\t2').separator, '\t');
    assert.equal(parseCsv('"a,b"|c\n').separator, '|');
  });
});

describe('cellValue', () => {
  it('reads numbers, special values and (optionally) decimal commas', () => {
    assert.equal(cellValue(' 1.5e3 '), 1500);
    assert.equal(cellValue('-.5'), -0.5);
    assert.equal(cellValue('EPS'), RAW.eps);
    assert.equal(cellValue('-inf'), RAW.minf);
    assert.equal(cellValue('Undef'), RAW.undf);
    assert.equal(cellValue('1,5'), undefined);
    assert.equal(cellValue('1,5', true), 1.5);
    assert.equal(cellValue('12abc'), undefined);
    assert.equal(cellValue('0x10'), undefined);
  });
});

describe('tableToGdx', () => {
  const read = async (data: Buffer, encoding = 'utf-8') => {
    const file = out();
    fs.writeFileSync(file, data);
    return GdxReader.open(file, encoding);
  };
  const header = ['region', 'year', 'demand', 'supply'];
  const rows = [
    ['north', '2020', '1.5', '2'],
    ['south', '2020', 'eps', ''],
    ['north', '2021', '3', 'NA'],
  ];

  it('writes a parameter of one value column, with the column names as relaxed domain', async () => {
    const result = tableToGdx({ name: 'demand', header, rows, indexColumns: [0, 1], valueColumns: [2], type: 'parameter' });
    assert.deepEqual([result.dim, result.records, result.skipped], [2, 3, 0]);
    const r = await read(result.data);
    assert.deepEqual(r.domainOf(r.entry('demand')), { domain: ['region', 'year'], domainType: 'Relaxed' });
    assert.match(await dumpText(r, 'demand'), /'north'\.'2020' 1\.5,\s*'north'\.'2021' 3,\s*'south'\.'2020' Eps/);
    // Labels in the order they appear.
    assert.deepEqual(r.uels, ['north', '2020', 'south', '2021']);
  });

  it('makes several value columns an extra dimension and leaves out empty cells', async () => {
    const result = tableToGdx({ name: 'p', header, rows, indexColumns: [0, 1], valueColumns: [2, 3], type: 'parameter' });
    assert.deepEqual([result.dim, result.records, result.skipped], [3, 5, 1]);
    const r = await read(result.data);
    assert.deepEqual(r.domainOf(r.entry('p')).domain, ['region', 'year', '*']);
    assert.match(await dumpText(r, 'p'), /'north'\.'2021'\.'supply' NA/);
  });

  it('writes sets with element texts', async () => {
    const result = tableToGdx({ name: 'r', header: ['region', 'name'], rows: [['n', 'North'], ['s', 'Süd']], indexColumns: [0], valueColumns: [1], type: 'set' });
    const r = await read(result.data);
    assert.match(await dumpText(r, 'r'), /'n' North,\s*'s' Süd/);
  });

  it('reports the rows with errors', () => {
    const write = (body: string[][]) => () => tableToGdx({ name: 'p', header: ['i', 'v'], rows: body, indexColumns: [0], valueColumns: [1], type: 'parameter' });
    assert.throws(write([['a', '1'], ['A', '2']]), (e: Error) => e instanceof ImportError && /Row 3: the same labels as row 2/.test(e.message));
    assert.throws(write([['a', 'x']]), /Row 2, v: "x" is not a number/);
    assert.throws(write([[' ', '1']]), /Row 2, i: empty label/);
    assert.throws(write([['a'.repeat(64), '1']]), /longer than 63 bytes/);
    assert.throws(() => tableToGdx({ name: '1p', header: ['i', 'v'], rows: [], indexColumns: [0], valueColumns: [1], type: 'parameter' }), /not a valid GAMS name/);
  });

  it('writes labels in Latin-1 when asked to', async () => {
    const result = tableToGdx({ name: 'p', header: ['i', 'v'], rows: [['café', '1']], indexColumns: [0], valueColumns: [1], type: 'parameter', encoding: 'latin1' });
    const r = await read(result.data, 'windows-1252');
    assert.deepEqual(r.uels, ['café']);
  });
});

describe('readXlsx', () => {
  it('reads the sheets that writeXlsx writes', () => {
    const book = readXlsx(
      writeXlsx([
        { name: 'first', rows: [[{ v: 'i' }, { v: 'value' }], [{ v: 'a & b' }, { v: 1.25 }], [], [{ v: 'c' }, { v: null }, { v: -3 }]] },
        { name: 'second', rows: [[{ v: 'x' }]] },
      ]),
    );
    assert.deepEqual(book.sheets, ['first', 'second']);
    assert.deepEqual(book.rows('first'), [['i', 'value'], ['a & b', '1.25'], [], ['c', '', '-3']]);
  });

  it('reads shared strings, rich text and booleans', () => {
    const files: [string, Buffer][] = [
      ['xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')],
      ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')],
      ['xl/sharedStrings.xml', Buffer.from('<sst><si><t>plain</t></si><si><r><t>ri</t></r><r><t xml:space="preserve">ch</t></r></si></sst>')],
      ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="2"><c r="B2" t="s"><v>1</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="s"><v>0</v></c></row></sheetData></worksheet>')],
    ];
    assert.deepEqual(readXlsx(zip(files)).rows('S'), [[], ['', 'rich', '1', 'plain']]);
  });
});
