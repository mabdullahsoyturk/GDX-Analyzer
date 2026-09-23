/**
 * Parsers for the textual output of gdxdump and gdxdiff.
 */
import { ColumnStore, ColumnStoreBuilder, CsvStream } from './columns';
import { decodeHexBytes } from './format';

export type SymbolType = 'Set' | 'Par' | 'Var' | 'Equ' | 'Alias';

export interface GdxSymbol {
  name: string;
  dim: number;
  type: SymbolType;
  records: number;
  text: string;
  /** Domain names, e.g. ["i", "j"]; "*" for the universe. */
  domain: string[];
  /** "None", "Relaxed" or "Regular" as reported by gdxdump DomainInfo. */
  domainType?: string;
  /** The symbol number in the GDX file (its entry). */
  entry?: number;
  /** Variables: free, positive, negative, binary, integer, sos1, sos2, semicont, semiint. Sets: singleton. */
  subtype?: string;
}

/**
 * Parses the output of `gdxdump <file> Symbols`:
 *
 *    Symbol   Dim Type Records  Explanatory text
 *  1 a          1  Par       2  capacity of plant i in cases
 */
export function parseSymbols(text: string): GdxSymbol[] {
  const symbols: GdxSymbol[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\d+\s+(\S+)\s+(\d+)\s+(Set|Par|Var|Equ|Alias)\s+(\d+)(?:\s(.*))?$/.exec(line);
    if (m) {
      const dim = Number(m[2]);
      symbols.push({
        name: m[1],
        dim,
        type: m[3] as SymbolType,
        records: Number(m[4]),
        text: (m[5] ?? '').trim(),
        domain: Array(dim).fill('*'),
      });
    }
  }
  return symbols;
}

export interface DomainInfo {
  domainType: string;
  domain: string[];
  /** The symbol number (SyNr). */
  number: number;
}

/**
 * Parses the output of `gdxdump <file> DomainInfo`:
 *
 * SyNr  Type  DomInf Symbol
 *    4   Par Regular a(i)
 *   12   Equ    None cost
 */
export function parseDomainInfo(text: string): Map<string, DomainInfo> {
  const result = new Map<string, DomainInfo>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(Set|Par|Var|Equ|Alias)\s+(\S+)\s+([^\s(]+)(?:\((.*)\))?\s*$/.exec(line);
    if (m) {
      result.set(m[4].toLowerCase(), {
        number: Number(m[1]),
        domainType: m[3],
        domain: m[5] ? m[5].split(',').map((d) => d.trim()) : [],
      });
    }
  }
  return result;
}

/** Adds the domain information to the symbols (GAMS identifiers are case-insensitive). */
export function mergeDomainInfo(symbols: GdxSymbol[], info: Map<string, DomainInfo>): GdxSymbol[] {
  return symbols.map((s) => {
    const d = info.get(s.name.toLowerCase());
    if (!d) {
      return s;
    }
    return d.domain.length === s.dim ? { ...s, domain: d.domain, domainType: d.domainType, entry: d.number } : { ...s, entry: d.number };
  });
}

/**
 * Parses the symbol declarations written by `gdxdump <file> NoData` for the subtypes:
 *
 * positive Variable x(i,j) shipment quantities in cases ;
 * Singleton Set s(*) ;
 */
export function parseSubtypes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    let m = /^(free|positive|negative|binary|integer|sos1|sos2|semicont|semiint)\s+Variable\s+([^\s(;]+)/i.exec(line);
    if (m) {
      result.set(m[2].toLowerCase(), m[1].toLowerCase());
      continue;
    }
    m = /^Singleton\s+Set\s+([^\s(;]+)/i.exec(line);
    if (m) {
      result.set(m[1].toLowerCase(), 'singleton');
    }
  }
  return result;
}

/** Adds the subtypes to the symbols. */
export function mergeSubtypes(symbols: GdxSymbol[], subtypes: Map<string, string>): GdxSymbol[] {
  return symbols.map((s) => {
    const subtype = subtypes.get(s.name.toLowerCase());
    return subtype ? { ...s, subtype } : s;
  });
}

/**
 * Parses the header written by `gdxdump <file> -V`:
 *
 * *  File version   : GDX Library C++ V7 ...
 * *  Producer       : GAMS Base Module 55.0.0 ...
 */
export function parseVersionInfo(text: string): [string, string][] {
  const result: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\s+([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (m) {
      result.push([m[1], m[2].trim()]);
    }
  }
  return result;
}

/**
 * Parses the unique element list written by `gdxdump <file> UelTable=uels NoData`:
 *
 * Set uels /
 *   'a,b' ,
 *   "it's" /;
 */
export function parseUelTable(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*Set\s+uels\s*\//i.test(l));
  const uels: string[] = [];
  if (start < 0) {
    return uels;
  }
  // Items may also follow the opening slash on the same line.
  const first = lines[start].replace(/^[^/]*\//, '');
  for (const line of [first, ...lines.slice(start + 1)]) {
    // Labels are quoted with ' or " (a label cannot contain both).
    const m = /^\s*(['"])(.*)\1\s*(,|\/;)?\s*$/.exec(line);
    if (m) {
      uels.push(m[2]);
      if (m[3] === '/;') {
        break;
      }
    } else if (/\/;\s*$/.test(line)) {
      break;
    }
  }
  return uels;
}

/** RFC 4180 CSV parser (quoted fields, "" escapes, embedded separators and newlines). */
export function parseCsv(text: string, separator = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
    } else if (c === '"') {
      quoted = true;
      i++;
    } else if (c === separator) {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\r' || c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface SymbolData {
  /** Column headers as written by gdxdump (domain names, then Val/Level/.../Text). */
  columns: string[];
  /** Number of leading key (domain) columns. */
  keyCount: number;
  rows: string[][];
}

const FIELD_LABELS: Record<string, string> = {
  Val: 'Value',
  Marginal: 'Marginal',
  Lower: 'Lower',
  Upper: 'Upper',
  Scale: 'Scale',
  Text: 'Text',
};

/**
 * Parses `gdxdump <file> Symb=<s> Format=csv CSVAllFields CSVSetText [dFormat=hexBytes]`.
 * For variables and equations the "Val" column is the level. Values written with
 * dFormat=hexBytes are decoded to the shortest decimal strings that round-trip.
 */
export function parseSymbolCsv(text: string, symbol: Pick<GdxSymbol, 'dim' | 'type' | 'domain'>): SymbolData {
  const [header = [], ...rows] = parseCsv(text);
  const keyCount = symbol.dim;
  const columns = columnNames(header, symbol);
  const valueColumns = header.flatMap((h, idx) => (idx >= keyCount && h !== 'Text' ? [idx] : []));
  for (const row of rows) {
    for (const idx of valueColumns) {
      if (row[idx] !== undefined && row[idx].startsWith('0x')) {
        row[idx] = decodeHexBytes(row[idx]);
      }
    }
  }
  return { columns, keyCount, rows };
}

/** Display names of the CSV columns written by gdxdump for a symbol. */
export function columnNames(header: string[], symbol: Pick<GdxSymbol, 'dim' | 'type' | 'domain'>): string[] {
  const isVarOrEqu = symbol.type === 'Var' || symbol.type === 'Equ';
  return header.map((h, idx) => {
    if (idx < symbol.dim) {
      // gdxdump writes "Dim1", "Dim2", ... for universe domains.
      const d = symbol.domain[idx];
      return d && d !== '*' ? d : h;
    }
    if (isVarOrEqu && h === 'Val') {
      return 'Level';
    }
    return FIELD_LABELS[h] ?? h;
  });
}

export interface SymbolColumns {
  columns: string[];
  keyCount: number;
  store: ColumnStore;
}

/**
 * A parser for `gdxdump <file> Symb=<s> Format=csv CSVAllFields CSVSetText dFormat=hexBytes`
 * that stores the records in compact columns as the output arrives: feed it with push()
 * and call finish() at the end. `records` (from the symbol list) sizes the storage.
 */
export function parseSymbolStream(symbol: Pick<GdxSymbol, 'dim' | 'type' | 'domain' | 'records'>) {
  let header: string[] | undefined;
  let headerRow: string[] = [];
  let builder: ColumnStoreBuilder | undefined;
  const csv = new CsvStream(
    (col, value) => {
      if (builder) {
        builder.set(col, value);
      } else {
        headerRow[col] = value;
      }
    },
    () => {
      if (builder) {
        builder.endRow();
      } else {
        header = headerRow;
        headerRow = [];
        // Keys and set texts are labels, all other columns numbers.
        builder = new ColumnStoreBuilder(
          header.map((h, i) => (i < symbol.dim || h === 'Text' ? 'label' : 'number')),
          symbol.records,
        );
      }
    },
  );
  return {
    push: (chunk: string) => csv.push(chunk),
    finish(): SymbolColumns {
      csv.end();
      const h = header ?? [];
      const store = (builder ?? new ColumnStoreBuilder(h.map(() => 'label'), 0)).build();
      return { columns: columnNames(h, symbol), keyCount: symbol.dim, store };
    },
  };
}

export interface DiffSummaryEntry {
  symbol: string;
  status: string;
}

export interface DiffSummary {
  file1?: string;
  file2?: string;
  identical: boolean;
  entries: DiffSummaryEntry[];
  messages: string[];
}

/**
 * Parses the console output of gdxdiff:
 *
 * Summary of differences:
 *        a   Data are different
 *    extra   Symbol not found in file 1
 */
export function parseDiffOutput(stdout: string): DiffSummary {
  const summary: DiffSummary = { identical: false, entries: [], messages: [] };
  let inSummary = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^File1\s*:\s*(.*)$/.exec(line))) {
      summary.file1 = m[1];
    } else if ((m = /^File2\s*:\s*(.*)$/.exec(line))) {
      summary.file2 = m[1];
    } else if (/^No differences found/i.test(line)) {
      summary.identical = true;
    } else if (/^Summary of differences:/i.test(line)) {
      inSummary = true;
    } else if (/^(Output:|GDXDiff finished|GDXDIFF\s)/i.test(line)) {
      inSummary = false;
    } else if (inSummary && (m = /^\s*(\S+)\s{2,}(\S.*)$/.exec(line))) {
      // Symbol names are right aligned, so the longest one has no leading blanks.
      summary.entries.push({ symbol: m[1], status: m[2].trim() });
    } else if (line.trim()) {
      inSummary = false;
      summary.messages.push(line.trim());
    }
  }
  return summary;
}

export type RecordStatus = 'changed' | 'only1' | 'only2';

export interface DiffRecord {
  keys: string[];
  status: RecordStatus;
  /** Values from file 1 (one per value column), undefined if the record is only in file 2. */
  values1?: string[];
  /** Values from file 2, undefined if the record is only in file 1. */
  values2?: string[];
}

export interface SymbolDiff {
  keyColumns: string[];
  valueColumns: string[];
  records: DiffRecord[];
}

/**
 * Turns a symbol of a gdxdiff difference file (whose last key is one of
 * dif1/dif2/ins1/ins2) into one record per original key.
 */
export function pivotDiff(data: SymbolData): SymbolDiff {
  const keyCount = data.keyCount - 1;
  const keyColumns = data.columns.slice(0, keyCount);
  const valueColumns = data.columns.slice(data.keyCount);
  const byKey = new Map<string, DiffRecord>();
  for (const row of data.rows) {
    const keys = row.slice(0, keyCount);
    const tag = (row[keyCount] ?? '').toLowerCase();
    const values = row.slice(data.keyCount);
    const id = JSON.stringify(keys);
    let rec = byKey.get(id);
    if (!rec) {
      rec = { keys, status: 'changed' };
      byKey.set(id, rec);
    }
    if (tag === 'dif1') {
      rec.values1 = values;
    } else if (tag === 'dif2') {
      rec.values2 = values;
    } else if (tag === 'ins1') {
      rec.status = 'only1';
      rec.values1 = values;
    } else if (tag === 'ins2') {
      rec.status = 'only2';
      rec.values2 = values;
    }
  }
  return { keyColumns, valueColumns, records: [...byKey.values()] };
}
