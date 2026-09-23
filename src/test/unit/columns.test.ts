import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ColumnStoreBuilder, CsvStream, hexBytesValue, numberText } from '../../columns';
import { DEFAULT_FORMAT, decodeHexBytes } from '../../format';
import { mergeDomainInfo, mergeSubtypes, parseCsv, parseDomainInfo, parseSubtypes, parseSymbolCsv, parseSymbolStream, parseSymbols, parseUelTable } from '../../parse';
import { TableView, columnTable, symbolTable } from '../../table';
import { GdxTools, resolveTools } from '../../tools';

function streamed(text: string, cuts: number[]): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const csv = new CsvStream(
    (col, v) => (row[col] = v),
    () => {
      rows.push(row);
      row = [];
    },
  );
  let at = 0;
  for (const c of [...cuts, text.length]) {
    csv.push(text.slice(at, c));
    at = c;
  }
  csv.end();
  return rows;
}

describe('CsvStream', () => {
  const text = '"i","Text"\r\n"a,b","has ""quotes"", commas"\r\n"x",\r\n"y","line\nbreak"\n"z",1.5E20';

  it('parses like the one-shot parser for every split of the input', () => {
    const expected = parseCsv(text);
    assert.deepEqual(streamed(text, []), expected);
    for (let i = 0; i <= text.length; i++) {
      assert.deepEqual(streamed(text, [i]), expected, `split at ${i}`);
    }
    // Many small chunks.
    assert.deepEqual(
      streamed(
        text,
        Array.from({ length: text.length }, (_, i) => i),
      ),
      expected,
    );
  });
});

describe('ColumnStore', () => {
  it('decodes hexBytes values like decodeHexBytes', () => {
    for (const hex of ['0x4049000000000000', '0x3f826e978d4fdf40', '0xc202a05f20000000', '0x8000000000000000', '0x0000000000000001']) {
      assert.equal(numberText(hexBytesValue(hex)), decodeHexBytes(hex));
    }
    assert.ok(Number.isNaN(hexBytesValue('Eps')));
  });

  it('stores labels once and numbers with special values', () => {
    const b = new ColumnStoreBuilder(['label', 'number'], 1);
    for (const [k, v] of [['a', '0x4049000000000000'], ['b', 'Eps'], ['a', '-Inf'], ['c', '1.5'], ['d', 'oops']]) {
      b.set(0, k);
      b.set(1, v);
      b.endRow();
    }
    const s = b.build();
    assert.equal(s.length, 5);
    assert.deepEqual([0, 1, 2, 3, 4].map((r) => [s.get(r, 0), s.get(r, 1)]), [
      ['a', '50'],
      ['b', 'Eps'],
      ['a', '-Inf'],
      ['c', '1.5'],
      ['d', 'oops'],
    ]);
    const labels = s.columns[0];
    assert.equal(labels.type === 'label' && labels.labels.list.length, 4);
  });
});

// Every fixture symbol, loaded as rows of strings and as streamed compact columns, must behave the same.
const fixtures = path.resolve(__dirname, '../../../test/fixtures');
const samples = path.resolve(__dirname, '../../../samples');
let tools: GdxTools | undefined;
try {
  tools = new GdxTools(resolveTools({ backend: 'gams', gamsSystemDirectory: process.env.GDX_TEST_GAMS_DIR }));
} catch {
  tools = undefined;
}

describe('compact columns behave like rows', { skip: tools ? false : 'GAMS tools not found' }, () => {
  for (const file of [path.join(fixtures, 'transport1.gdx'), path.join(fixtures, 'edge.gdx'), path.join(fixtures, 'types.gdx'), path.join(samples, 'scenario.gdx')]) {
    it(path.basename(file), async () => {
      const t = tools!;
      const symbols = mergeSubtypes(mergeDomainInfo(parseSymbols(await t.dump(file, { symbols: true })), parseDomainInfo(await t.dump(file, { domainInfo: true }))), parseSubtypes(await t.dump(file, { noData: true })));
      const uels = parseUelTable(await t.dump(file, { uelTable: 'uels', noData: true }));
      for (const s of symbols) {
        const options = { symbol: s.name, format: 'csv' as const, csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' as const };
        const rows = new TableView(symbolTable(parseSymbolCsv(await t.dump(file, options), s), s));
        const parser = parseSymbolStream(s);
        await t.dumpStream(file, options, parser.push);
        const c = parser.finish();
        const cols = new TableView(columnTable(c.columns, c.keyCount, c.store, s));
        rows.setUelOrder(uels);
        cols.setUelOrder(uels);
        const msg = `${path.basename(file)}: ${s.name}`;
        const n = rows.table.columns.length;
        const base = { pageSize: 10000, format: DEFAULT_FORMAT };
        assert.deepEqual(cols.query(base), rows.query(base), msg);
        for (let col = 0; col < n; col++) {
          for (const sortDescending of [false, true]) {
            assert.deepEqual(cols.query({ ...base, sortColumn: col, sortDescending }).rows, rows.query({ ...base, sortColumn: col, sortDescending }).rows, `${msg} sort ${col}`);
          }
          if (rows.table.columns[col].kind !== 'value') {
            assert.deepEqual(cols.columnValues(col), rows.columnValues(col), `${msg} labels ${col}`);
          }
        }
        assert.deepEqual(cols.squeezableColumns(), rows.squeezableColumns(), msg);
        const filters = [{ type: 'range' as const, column: n - 1, min: 1 }];
        assert.deepEqual(cols.query({ ...base, columnFilters: filters }), rows.query({ ...base, columnFilters: filters }), `${msg} range`);
        for (const text of ['1', 'a', 'Y']) {
          assert.deepEqual(cols.findList(base, { text }), rows.findList(base, { text }), `${msg} find ${text}`);
          assert.deepEqual(cols.query({ ...base, filter: { text } }), rows.query({ ...base, filter: { text } }), `${msg} filter ${text}`);
        }
        if (s.dim >= 2) {
          const pq = { pageSize: 1000, colPageSize: 1000, format: DEFAULT_FORMAT };
          assert.deepEqual(cols.pivot(pq), rows.pivot(pq), `${msg} pivot`);
          assert.deepEqual(cols.findPivot(pq, { text: '1' }), rows.findPivot(pq, { text: '1' }), `${msg} find pivot`);
          assert.equal(cols.pivotTsv(pq), rows.pivotTsv(pq), `${msg} pivot copy`);
        }
        assert.equal(cols.toTsv(base), rows.toTsv(base), `${msg} copy`);
      }
    });
  }
});

describe('compact difference tables behave like rows', { skip: tools ? false : 'GAMS tools not found' }, () => {
  const os = require('node:os') as typeof import('node:os');
  const variants: [string, object][] = [
    ['default', {}],
    ['field only', { field: 'L', fieldOnly: true }],
    ['diff only', { diffOnly: true }],
  ];
  for (const [label, options] of variants) {
    it(label, async () => {
      const { diffColumnTable, diffTable } = await import('../../table');
      const { pivotDiff } = await import('../../parse');
      const t = tools!;
      const base = path.join(samples, 'base.gdx');
      const d = path.join(os.tmpdir(), `gdx-parity-${label.replace(' ', '-')}.gdx`);
      await t.diff(base, path.join(samples, 'scenario.gdx'), d, options);
      const orig = mergeDomainInfo(parseSymbols(await t.dump(base, { symbols: true })), parseDomainInfo(await t.dump(base, { domainInfo: true })));
      for (const ds of parseSymbols(await t.dump(d, { symbols: true }))) {
        const o = orig.find((s) => s.name === ds.name);
        if (!o) continue;
        const sym = { ...ds, domain: [...o.domain, ...(ds.dim - o.dim === 2 ? ['Field'] : []), '*'] };
        const dump = { symbol: ds.name, format: 'csv' as const, csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' as const };
        const rows = new TableView(diffTable(pivotDiff(parseSymbolCsv(await t.dump(d, dump), sym))));
        const parser = parseSymbolStream(sym);
        await t.dumpStream(d, dump, parser.push);
        const cols = new TableView(diffColumnTable(parser.finish()));
        const msg = `${label}: ${ds.name}`;
        const q = { pageSize: 100000, format: DEFAULT_FORMAT };
        assert.deepEqual(cols.query(q), rows.query(q), msg);
        for (let c = 0; c < rows.table.columns.length; c++) {
          assert.deepEqual(cols.query({ ...q, sortColumn: c, sortDescending: true }).rows, rows.query({ ...q, sortColumn: c, sortDescending: true }).rows, `${msg} sort ${c}`);
        }
        const status = rows.table.columns.findIndex((c) => c.kind === 'status');
        assert.deepEqual(cols.columnValues(status), rows.columnValues(status), msg);
        const f = [{ type: 'labels' as const, column: status, labels: ['changed'] }];
        assert.deepEqual(cols.query({ ...q, columnFilters: f }), rows.query({ ...q, columnFilters: f }), `${msg} filter`);
        assert.deepEqual(cols.findList(q, { text: '1' }), rows.findList(q, { text: '1' }), `${msg} find`);
        assert.equal(cols.toTsv(q), rows.toTsv(q), `${msg} copy`);
      }
    });
  }
});

describe('cachedView', () => {
  it('keeps the most recently used views', async () => {
    const { cachedView, MAX_CACHED_VIEWS } = await import('../../table');
    const cache = new Map<string, number>();
    let loads = 0;
    const get = (n: string) => cachedView(cache, n, () => ++loads);
    for (let i = 0; i < MAX_CACHED_VIEWS; i++) get('s' + i);
    get('s0'); // used again: now the most recent
    get('new'); // evicts s1, the least recently used
    assert.deepEqual([...cache.keys()], ['s2', 's3', 's0', 'new']);
    assert.equal(get('s0'), 1);
    assert.equal(loads, MAX_CACHED_VIEWS + 1);
  });
});
