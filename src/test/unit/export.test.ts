import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { DEFAULT_SPECIALS, buildSheets, connectInstructions } from '../../export';
import { DEFAULT_FORMAT } from '../../format';
import { TableView, symbolTable } from '../../table';
import { columnName, crc32, sheetNames, writeXlsx } from '../../xlsx';

/** The files of a ZIP archive (only what our writer produces: deflated entries). */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extra;
    const data = inflateRawSync(buf.subarray(start, start + size));
    assert.equal(crc32(data), buf.readUInt32LE(i + 14), `CRC of ${name}`);
    files.set(name, data.toString('utf8'));
    i = start + size;
  }
  return files;
}

describe('xlsx', () => {
  it('names columns and sheets like Excel', () => {
    assert.deepEqual([0, 25, 26, 701, 702, 16383].map(columnName), ['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
    assert.deepEqual(sheetNames(['a/b', 'A/B', 'x'.repeat(40)]), ['a_b', 'A_B (2)', 'x'.repeat(31)]);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('writes a valid workbook with numbers, texts, bold headers and frozen panes', () => {
    const files = unzip(writeXlsx([{ name: 'p', rows: [[{ v: 'i', bold: true }, { v: 'Value', bold: true }], [{ v: 'a<b' }, { v: 1.5 }], [{ v: ' x' }, { v: null }]], freezeRows: 1 }]));
    assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t>i<\/t><\/is><\/c>/);
    assert.match(sheet, /<c r="B2"><v>1.5<\/v><\/c>/);
    // The used range (needed by openpyxl in read-only mode, e.g. GAMS Connect).
    assert.match(sheet, /<dimension ref="A1:B3"\/>/);
    assert.match(sheet, /<t>a&lt;b<\/t>/);
    assert.match(sheet, /<t xml:space="preserve"> x<\/t>/);
    assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    assert.match(files.get('xl/workbook.xml')!, /<sheet name="p" sheetId="1" r:id="rId1"\/>/);
  });

  it('refuses sheets beyond the limits of Excel', () => {
    const cols = Array.from({ length: 16385 }, () => ({ v: 1 }));
    assert.throws(() => writeXlsx([{ name: 'wide', rows: [cols] }]), /at most/);
  });
});

function demand() {
  const data = {
    columns: ['r', 't', 'Value'],
    keyCount: 2,
    rows: [
      ['north', 'jan', '1'],
      ['north', 'feb', 'Eps'],
      ['south', 'jan', '3'],
    ],
  };
  const symbol = { name: 'demand', dim: 2, type: 'Par' as const, records: 3, text: '', domain: ['r', 't'] };
  return { symbol, view: new TableView(symbolTable(data, symbol)) };
}

const defaults = { format: DEFAULT_FORMAT, squeezeDefaults: false };

describe('buildSheets', () => {
  it('lays out a symbol like its view, with filters and special values', () => {
    const { symbol, view } = demand();
    const options = { applyFilters: true, includeHidden: false, specials: { ...DEFAULT_SPECIALS, eps: '0' } };
    const [list] = buildSheets([{ symbol, view, state: { columnFilters: [{ type: 'labels', column: 0, labels: ['north'] }] } }], options, defaults);
    assert.deepEqual(list.rows.map((r) => r.map((c) => c.v)), [['r', 't', 'Value'], ['north', 'jan', 1], ['north', 'feb', 0]]);
    assert.equal(list.freezeRows, 1);
    const [table] = buildSheets([{ symbol, view, state: { view: 'table' } }], { ...options, applyFilters: false }, defaults);
    assert.deepEqual(table.rows.map((r) => r.map((c) => c.v)), [['r', 'jan', 'feb'], ['north', 1, 0], ['south', 3, '']]);
    assert.deepEqual([table.freezeRows, table.freezeCols], [1, 1]);
  });
});

describe('connectInstructions', () => {
  it('reads, filters, reorders and writes the symbols', () => {
    const { symbol, view } = demand();
    const yaml = connectInstructions(
      'C:\\data\\x.gdx',
      'C:\\data\\x.xlsx',
      [{ symbol, view, state: { view: 'table', rowDims: [1], colDims: [0], columnFilters: [{ type: 'range', column: 2, min: 2, hideSpecials: ['eps'] }] } }],
      { applyFilters: true, includeHidden: false, specials: { ...DEFAULT_SPECIALS, eps: '0' } },
      defaults,
    );
    assert.match(yaml, /- GDXReader:\n    file: "C:\/data\/x.gdx"\n    symbols:\n      - name: demand/);
    assert.match(yaml, /- Filter:\n    name: demand\n    newName: demand_filtered\n    valueFilters:\n      - attribute: value\n        rule: "\(x >= 2\)"\n        rejectSpecialValues: \["EPS"\]/);
    assert.match(yaml, /- Projection:\n    name: demand_filtered\(d1,d2\)\n    newName: demand_view\(d2,d1\)/);
    assert.match(yaml, /valueSubstitutions: \{"EPS": 0\}/);
    assert.match(yaml, /      - name: demand_view\n        range: "demand!A1"\n        columnDimension: 1/);
  });

  it('projects the shown fields of variables', () => {
    const data = { columns: ['i', 'Level', 'Marginal', 'Lower', 'Upper', 'Scale'], keyCount: 1, rows: [['a', '1', '0', '0', '+Inf', '1']] };
    const symbol = { name: 'x', dim: 1, type: 'Var' as const, records: 1, text: '', domain: ['i'], subtype: 'positive' };
    const view = new TableView(symbolTable(data, symbol));
    const opts = { applyFilters: true, includeHidden: false, specials: DEFAULT_SPECIALS };
    const squeezed = connectInstructions('x.gdx', 'x.xlsx', [{ symbol, view, state: { squeeze: true } }], opts, defaults);
    assert.match(squeezed, /name: x\.l\(d1\)\n    newName: x_view\(d1\)/);
    assert.match(squeezed, /columnDimension: 0/);
    const two = connectInstructions('x.gdx', 'x.xlsx', [{ symbol, view, state: { hidden: [3, 4, 5] } }], opts, defaults);
    assert.match(two, /name: x\.\[l,m\]\(d1\)/);
    assert.match(two, /columnDimension: 1/);
    assert.doesNotMatch(two, /valueSubstitutions/);
  });
});
