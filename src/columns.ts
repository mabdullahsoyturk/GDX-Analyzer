/**
 * Compact storage of table cells, so that symbols with millions of records fit into
 * the memory of the extension host: labels are stored once per column and referenced
 * by index, numbers are stored in typed arrays with a byte for special values.
 *
 * Also a streaming parser for the CSV written by gdxdump, which fills the storage
 * without ever holding the whole output as one string.
 */

/** Codes of special values (and of cells that are not numbers). */
export const enum Sp {
  None = 0,
  Eps = 1,
  NA = 2,
  PInf = 3,
  MInf = 4,
  Undf = 5,
  Empty = 6,
  /** A value that is neither a number nor a special value (kept as text). */
  Text = 7,
}

/** The names gdxdump writes for special values. */
export const SPECIAL_NAMES: readonly string[] = ['', 'Eps', 'NA', '+Inf', '-Inf', 'Undf', '', ''];

/** The special value code of a value as written by gdxdump. */
export function specialCode(v: string): Sp {
  switch (v.length) {
    case 0:
      return Sp.Empty;
    case 2:
      return v === 'NA' || v.toLowerCase() === 'na' ? Sp.NA : Sp.None;
    case 3:
      return v.toLowerCase() === 'eps' ? Sp.Eps : v.toLowerCase() === 'inf' ? Sp.PInf : Sp.None;
    case 4: {
      const l = v.toLowerCase();
      return l === '+inf' ? Sp.PInf : l === '-inf' ? Sp.MInf : l === 'undf' ? Sp.Undf : Sp.None;
    }
  }
  return Sp.None;
}

const view = new DataView(new ArrayBuffer(8));

/** The number of a value written by gdxdump with dFormat=hexBytes (0x + 16 hex digits), or NaN. */
export function hexBytesValue(v: string): number {
  if (v.length !== 18 || v.charCodeAt(0) !== 48 || (v.charCodeAt(1) | 32) !== 120) {
    return NaN;
  }
  const hi = parseInt(v.substring(2, 10), 16);
  const lo = parseInt(v.substring(10, 18), 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) {
    return NaN;
  }
  view.setUint32(0, hi);
  view.setUint32(4, lo);
  return view.getFloat64(0);
}

/** A number as text: the shortest representation that round-trips (like parse.ts's decodeHexBytes). */
export function numberText(x: number): string {
  return x === 0 ? '0' : String(x);
}

/** Interned labels of one column. */
export class Labels {
  readonly list: string[] = [];
  private readonly ids = new Map<string, number>();

  intern(s: string): number {
    let id = this.ids.get(s);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(s);
      this.ids.set(s, id);
    }
    return id;
  }
}

export interface LabelColumn {
  type: 'label';
  ids: Int32Array;
  labels: Labels;
}

export interface NumberColumn {
  type: 'number';
  values: Float64Array;
  special: Uint8Array;
  /** Values that are not numbers (Sp.Text), by row. */
  texts?: Map<number, string>;
}

export type StoredColumn = LabelColumn | NumberColumn;

/** Column-wise cells of a table. */
export class ColumnStore {
  constructor(
    readonly length: number,
    readonly columns: StoredColumn[],
  ) {}

  get(row: number, col: number): string {
    const c = this.columns[col];
    if (c.type === 'label') {
      return c.labels.list[c.ids[row]];
    }
    const sp = c.special[row];
    if (sp === Sp.None) {
      return numberText(c.values[row]);
    }
    return sp === Sp.Text ? (c.texts?.get(row) ?? '') : SPECIAL_NAMES[sp];
  }
}

/** Fills a ColumnStore row by row; the capacity grows if needed. */
export class ColumnStoreBuilder {
  private rows = 0;
  private capacity: number;
  private readonly cols: StoredColumn[];

  constructor(
    private readonly kinds: ('label' | 'number')[],
    capacity: number,
  ) {
    this.capacity = Math.max(16, capacity);
    this.cols = kinds.map((k) =>
      k === 'label'
        ? { type: 'label', ids: new Int32Array(this.capacity), labels: new Labels() }
        : { type: 'number', values: new Float64Array(this.capacity), special: new Uint8Array(this.capacity) },
    );
  }

  private grow() {
    this.capacity *= 2;
    for (const c of this.cols) {
      if (c.type === 'label') {
        const ids = new Int32Array(this.capacity);
        ids.set(c.ids);
        c.ids = ids;
      } else {
        const values = new Float64Array(this.capacity);
        values.set(c.values);
        c.values = values;
        const special = new Uint8Array(this.capacity);
        special.set(c.special);
        c.special = special;
      }
    }
  }

  /** Sets a cell of the current row. */
  set(col: number, v: string) {
    if (this.rows >= this.capacity) {
      this.grow();
    }
    const c = this.cols[col];
    if (!c) {
      return;
    }
    const r = this.rows;
    if (c.type === 'label') {
      c.ids[r] = c.labels.intern(v);
      return;
    }
    let x = hexBytesValue(v);
    if (!Number.isNaN(x)) {
      c.values[r] = x;
      c.special[r] = Sp.None;
      return;
    }
    const sp = specialCode(v);
    if (sp !== Sp.None) {
      c.special[r] = sp;
      return;
    }
    x = Number(v);
    if (Number.isNaN(x)) {
      c.special[r] = Sp.Text;
      (c.texts ??= new Map()).set(r, v);
    } else {
      c.values[r] = x;
      c.special[r] = Sp.None;
    }
  }

  /** Completes the current row (missing cells stay empty labels or zeros). */
  endRow() {
    this.rows++;
  }

  build(): ColumnStore {
    const n = this.rows;
    // Trim to the actual length (frees the unused capacity).
    for (const c of this.cols) {
      if (c.type === 'label') {
        if (c.ids.length !== n) c.ids = c.ids.slice(0, n);
      } else if (c.values.length !== n) {
        c.values = c.values.slice(0, n);
        c.special = c.special.slice(0, n);
      }
    }
    return new ColumnStore(n, this.cols);
  }
}

/**
 * Streaming parser for RFC 4180 CSV (quoted fields, "" escapes, CRLF): feed chunks with
 * push(); fields and row ends are reported as they are complete.
 */
export class CsvStream {
  private field = '';
  private col = 0;
  private quoted = false;
  /** In a quoted field, a quote was the last character of the previous chunk. */
  private pendingQuote = false;
  /** The previous chunk ended with \r (a following \n belongs to the same line end). */
  private pendingCR = false;
  private rowHasContent = false;

  constructor(
    private readonly onField: (col: number, value: string) => void,
    private readonly onRowEnd: () => void,
  ) {}

  private endField() {
    this.onField(this.col++, this.field);
    this.field = '';
    this.rowHasContent = true;
  }

  private endRow() {
    this.endField();
    this.onRowEnd();
    this.col = 0;
    this.rowHasContent = false;
  }

  push(chunk: string) {
    const n = chunk.length;
    let i = 0;
    if (this.pendingCR) {
      this.pendingCR = false;
      if (n > 0 && chunk.charCodeAt(0) === 10) {
        i = 1;
      }
    }
    while (i < n) {
      if (this.quoted) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (chunk.charCodeAt(i) === 34) {
            this.field += '"';
            i++;
            continue;
          }
          this.quoted = false;
          continue;
        }
        const q = chunk.indexOf('"', i);
        if (q < 0) {
          this.field += chunk.substring(i);
          return;
        }
        this.field += chunk.substring(i, q);
        i = q + 1;
        if (i >= n) {
          this.pendingQuote = true;
          return;
        }
        if (chunk.charCodeAt(i) === 34) {
          this.field += '"';
          i++;
        } else {
          this.quoted = false;
        }
        continue;
      }
      const ch = chunk.charCodeAt(i);
      if (ch === 34) {
        this.quoted = true;
        i++;
      } else if (ch === 44) {
        this.endField();
        i++;
      } else if (ch === 13 || ch === 10) {
        this.endRow();
        i++;
        if (ch === 13) {
          if (i >= n) {
            this.pendingCR = true;
          } else if (chunk.charCodeAt(i) === 10) {
            i++;
          }
        }
      } else {
        // An unquoted run up to the next separator, quote or line end.
        let j = i + 1;
        while (j < n) {
          const c = chunk.charCodeAt(j);
          if (c === 44 || c === 13 || c === 10 || c === 34) break;
          j++;
        }
        this.field += chunk.substring(i, j);
        i = j;
      }
    }
  }

  end() {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.quoted = false;
    }
    if (this.field !== '' || this.rowHasContent || this.col > 0) {
      this.endRow();
    }
  }
}
