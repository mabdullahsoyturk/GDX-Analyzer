/**
 * Creates GDX files from tables (CSV files and Excel sheets), like csv2gdx: some columns are the
 * dimensions (labels) of a symbol and the others its values. One value column gives a parameter;
 * several give a parameter with an extra last dimension whose labels are the column names (as
 * csv2gdx's ValueDim); none gives a set, optionally with element texts from a text column.
 *
 * No dependency on `vscode`.
 */
import { GdxWriter, RAW } from './gdxWriter';

/** Parses CSV text (RFC 4180 quoting) with a field separator, detected from the first line if not given. */
export function parseCsv(input: string, separator?: string): { rows: string[][]; separator: string } {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = separator ?? detectSeparator(s);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
    } else if (ch === '"' && field === '') {
      quoted = true;
      i++;
    } else if (ch === sep) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines are left out.
  return { rows: rows.filter((r) => r.length > 1 || r[0] !== ''), separator: sep };
}

/** The separator of the first line among comma, semicolon, tab and bar (outside quotes): the most frequent. */
function detectSeparator(s: string): string {
  const counts = new Map<string, number>([[',', 0], [';', 0], ['\t', 0], ['|', 0]]);
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ',';
  for (const [sep, n] of counts) if (n > counts.get(best)!) best = sep;
  return best;
}

/** The value of a cell for GDX, as a double of GAMS; undefined if it is not a number or special value. */
export function cellValue(v: string, decimalComma = false): number | undefined {
  const t = v.trim();
  switch (t.toLowerCase()) {
    case 'eps':
      return RAW.eps;
    case 'na':
      return RAW.na;
    case 'inf':
    case '+inf':
      return RAW.pinf;
    case '-inf':
      return RAW.minf;
    case 'undf':
    case 'undef':
      return RAW.undf;
  }
  const s = decimalComma && /^[+-]?\d*,\d+([eE][+-]?\d+)?$/.test(t) ? t.replace(',', '.') : t;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return undefined;
  return Number(s);
}

/** GAMS identifiers: a letter, then letters, digits and underscores, at most 63 characters. */
export const isIdentifier = (s: string) => /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(s);

/** Longest label (unique element) of GAMS, in bytes. */
const MAX_LABEL = 63;

export interface ImportSpec {
  /** The symbol and its explanatory text. */
  name: string;
  text?: string;
  /** Column names, and the rows of the table (without the header). */
  header: string[];
  rows: string[][];
  /** The 1-based number of the first row in the source (for messages). */
  firstRow?: number;
  /** The columns with the labels of the dimensions, in their order. */
  indexColumns: number[];
  /** Parameter: the columns with the values. Set: the column with the element texts, if any. */
  valueColumns: number[];
  type: 'parameter' | 'set';
  /** Numbers may use a decimal comma (e.g. with semicolon separated files). */
  decimalComma?: boolean;
  /** How labels and texts are written: UTF-8, or one byte per character (Latin-1). */
  encoding?: 'utf-8' | 'latin1';
}

export interface ImportResult {
  data: Buffer;
  dim: number;
  records: number;
  /** Rows without a value (empty cells), left out. */
  skipped: number;
}

/** Errors of the table (labels, numbers, duplicates), with the rows they are in. */
export class ImportError extends Error {}

/** Writes a symbol made from a table as a GDX file (in memory). */
export function tableToGdx(spec: ImportSpec): ImportResult {
  if (!isIdentifier(spec.name)) throw new ImportError(`${spec.name} is not a valid GAMS name: a letter, then letters, digits or _, at most 63 characters.`);
  if (!spec.indexColumns.length && spec.type === 'set') throw new ImportError('A set needs at least one column with labels.');
  const isSet = spec.type === 'set';
  const multi = !isSet && spec.valueColumns.length > 1;
  if (!isSet && !spec.valueColumns.length) throw new ImportError('A parameter needs a column with values.');
  const dim = spec.indexColumns.length + (multi ? 1 : 0);
  if (dim > 20) throw new ImportError('GAMS symbols have at most 20 dimensions.');
  const encode = (s: string) => (spec.encoding === 'latin1' ? s : Buffer.from(s, 'utf8').toString('latin1'));
  const errors: string[] = [];
  const error = (msg: string) => {
    if (errors.length < 5) errors.push(msg);
    else if (errors.length === 5) errors.push('…');
  };
  const rowNr = (r: number) => r + (spec.firstRow ?? 2);
  const columnName = (c: number) => spec.header[c] || `column ${c + 1}`;
  const label = (raw: string, where: string): string | undefined => {
    const l = raw.trim();
    if (!l) return error(`${where}: empty label`), undefined;
    const bytes = encode(l);
    if (spec.encoding === 'latin1' && /[^\u0000-ÿ]/.test(l)) return error(`${where}: "${l}" has characters that Latin-1 cannot encode`), undefined;
    if (bytes.length > MAX_LABEL) return error(`${where}: "${l}" is longer than ${MAX_LABEL} bytes`), undefined;
    return bytes;
  };

  const writer = new GdxWriter('GDX Analyzer', 'GDX Analyzer');
  // Relaxed domains: the column names that are GAMS names.
  const domain = [...spec.indexColumns.map((c) => (isIdentifier(spec.header[c]?.trim() ?? '') ? spec.header[c].trim() : '*')), ...(multi ? ['*'] : [])];
  // The labels of the extra dimension: the names of the value columns.
  const valueLabels = multi ? spec.valueColumns.map((c) => label(spec.header[c] ?? '', `Name of column ${c + 1}`)) : [];
  if (multi && new Set(valueLabels.map((l) => l?.toLowerCase())).size < valueLabels.length) error('The value columns need different names: they become the labels of the last dimension.');
  writer.startSymbol(spec.name, spec.text ?? '', dim, isSet ? 0 : 1, 0, undefined, { domainNames: domain });
  const key = new Int32Array(dim);
  const value = new Float64Array(1);
  const seen = new Map<string, number>();
  let records = 0;
  let skipped = 0;
  spec.rows.forEach((row, r) => {
    const keys: number[] = [];
    for (const c of spec.indexColumns) {
      const l = label(row[c] ?? '', `Row ${rowNr(r)}, ${columnName(c)}`);
      if (l === undefined) return;
      keys.push(writer.uel(l));
    }
    const write = (extra: number | undefined, x: number) => {
      keys.forEach((k, d) => (key[d] = k));
      if (extra !== undefined) key[dim - 1] = extra;
      // Labels are case-insensitive in GAMS: "A" and "a" are the same record.
      const id = Array.from(key).join(',');
      const before = seen.get(id);
      if (before !== undefined) return error(`Row ${rowNr(r)}: the same labels as row ${rowNr(before)} (labels are case-insensitive)`);
      seen.set(id, r);
      value[0] = x;
      writer.record(key, value);
      records++;
    };
    if (isSet) {
      const c = spec.valueColumns[0];
      const t = c === undefined ? '' : (row[c] ?? '').trim();
      write(undefined, t ? writer.setText(encode(t)) : 0);
      return;
    }
    spec.valueColumns.forEach((c, k) => {
      const cell = row[c] ?? '';
      if (cell.trim() === '') {
        skipped++;
        return;
      }
      const x = cellValue(cell, spec.decimalComma);
      if (x === undefined) return error(`Row ${rowNr(r)}, ${columnName(c)}: "${cell.trim()}" is not a number or special value (EPS, NA, INF, -INF, UNDF)`);
      const extra = multi ? valueLabels[k] : undefined;
      if (multi && extra === undefined) return;
      write(multi ? writer.uel(extra!) : undefined, x);
    });
  });
  if (errors.length) throw new ImportError(errors.join('\n'));
  writer.endSymbol();
  return { data: writer.bytes(), dim, records, skipped };
}
