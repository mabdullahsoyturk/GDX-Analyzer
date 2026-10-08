/**
 * Writes GDX files (format version 7, uncompressed) as the GDX library of GAMS does (see
 * https://github.com/GAMS-dev/gdx, src/gxfile.cpp, MIT license): the difference files of
 * gdxDiff.ts, copies of symbols (gdxSubset.ts) and files made from tables (gdxImport.ts). Strings are written one byte per character (so that labels read with RAW_BYTES of
 * gdxReader.ts are written unchanged, whatever their encoding).
 *
 * No dependency on `vscode`.
 */
import { writeFile } from './platform/files';

const HEADER_NR = 123;
const VERSION = 7;
const MARK_BOI = 19510624;
const INDEX_INITIAL = -256;

/** The special values of GAMS as doubles (GMS_SV_*) and the start of acronyms. */
export const RAW = { undf: 1e300, na: 2e300, pinf: 3e300, minf: 4e300, eps: 5e300, acronym: 1e301 };

/** Values with a code of their own (TgdxIntlValTyp): specials, then 0, 1, -1, 0.5 and 2. */
const CODED = [RAW.undf, RAW.na, RAW.pinf, RAW.minf, RAW.eps, 0, 1, -1, 0.5, 2];
const VM_NORMAL = 10;
const VALUE_COUNT = [1, 1, 5, 5, 0];

/** Explanatory texts as the GDX library stores them: control characters as ?, one kind of quote. */
export function goodText(s: string): string {
  let quote = '';
  let out = '';
  for (const c of s) {
    if (c === '"' || c === "'") {
      if (!quote) quote = c;
      out += quote;
    } else {
      out += c.charCodeAt(0) < 32 ? '?' : c;
    }
  }
  return out;
}

/** Case-insensitive as GAMS compares names and labels (ASCII letters only). */
export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** A growing buffer of little-endian values. */
class Bytes {
  private buf = Buffer.alloc(1 << 16);
  length = 0;

  private room(n: number) {
    if (this.length + n > this.buf.length) {
      const bigger = Buffer.alloc(Math.max(this.buf.length * 2, this.length + n));
      this.buf.copy(bigger, 0, 0, this.length);
      this.buf = bigger;
    }
  }

  byte(v: number) {
    this.room(1);
    this.buf[this.length++] = v;
  }

  word(v: number) {
    this.room(2);
    this.buf.writeUInt16LE(v, this.length);
    this.length += 2;
  }

  int(v: number) {
    this.room(4);
    this.buf.writeInt32LE(v, this.length);
    this.length += 4;
  }

  int64(v: number) {
    this.room(8);
    this.buf.writeBigInt64LE(BigInt(v), this.length);
    this.length += 8;
  }

  double(v: number) {
    this.room(8);
    this.buf.writeDoubleLE(v, this.length);
    this.length += 8;
  }

  /** A string: a length byte and at most 255 bytes. */
  string(s: string) {
    const b = Buffer.from(s, 'latin1').subarray(0, 255);
    this.byte(b.length);
    this.room(b.length);
    b.copy(this.buf, this.length);
    this.length += b.length;
  }

  setInt64(at: number, v: number) {
    this.buf.writeBigInt64LE(BigInt(v), at);
  }

  setInt(at: number, v: number) {
    this.buf.writeInt32LE(v, at);
  }

  bytes(): Buffer {
    return this.buf.subarray(0, this.length);
  }
}

interface WrittenSymbol {
  name: string;
  position: number;
  dim: number;
  type: number;
  userInfo: number;
  count: number;
  hasSetText: boolean;
  text: string;
  /** Regular domain: the numbers of the domain sets (0: the universe). */
  domainSymbols?: number[];
  /** Relaxed domain: the numbers of the domain names (from 1; 0: the universe). */
  domainStrings?: number[];
  comments: string[];
}

/** The domain and comments of a symbol (gdxSymbolSetDomain, gdxSymbolSetDomainX, gdxSymbolAddComment). */
export interface SymbolExtras {
  /** Regular domain: the symbol numbers (as returned by startSymbol and addAlias) of the domain sets, 0 for the universe. */
  domainSymbols?: number[];
  /** Relaxed domain: the names of the domains, '*' for the universe. */
  domainNames?: string[];
  comments?: string[];
}

/** A GDX file written in memory: symbols one after another, then the tables. */
export class GdxWriter {
  private readonly out = new Bytes();
  private readonly indexPosition: number;
  private readonly symbols: WrittenSymbol[] = [];
  private readonly uels: string[] = [];
  private readonly uelNumbers = new Map<string, number>();
  private readonly setTexts: string[] = [''];
  private readonly setTextNumbers = new Map<string, number>([['', 0]]);
  private readonly acronyms: number[] = [];
  private readonly acronymNames = new Map<number, { name: string; text: string }>();
  private readonly domainStrings: string[] = [];
  private readonly domainStringNumbers = new Map<string, number>();
  /** The symbol being written: its records kept (sorted at its end) or written as they come (`stream`). */
  private current?: {
    symbol: WrittenSymbol;
    fields: number;
    keys: Int32Array;
    values: Float64Array;
    count: number;
    /** Records given (with duplicates), for the record count of the data. */
    added: number;
    last: number[];
    stream?: { countAt: number; min: number[]; size: number[] };
  };

  constructor(systemId: string, producer: string) {
    const o = this.out;
    // Byte order: the sizes and patterns of a word, an integer and a double.
    o.byte(2);
    o.word(0x1234);
    o.byte(4);
    o.int(0x12345678);
    o.byte(8);
    o.double(3.1415926535897932385);
    o.byte(HEADER_NR);
    o.string('GAMSGDX');
    o.int(VERSION);
    o.int(0);
    o.string(systemId);
    o.string(producer);
    this.indexPosition = o.length;
    for (let k = 0; k < 10; k++) o.int64(0);
  }

  /** The number (from 1) of a label, added if new (labels are case-insensitive). */
  uel(label: string): number {
    const key = asciiLower(label.replace(/ +$/, ''));
    let nr = this.uelNumbers.get(key);
    if (nr === undefined) {
      this.uels.push(label.replace(/ +$/, ''));
      nr = this.uels.length;
      this.uelNumbers.set(key, nr);
    }
    return nr;
  }

  hasUel(label: string): boolean {
    return this.uelNumbers.has(asciiLower(label));
  }

  /** The number of a set element text, added if new (gdxAddSetText). */
  setText(text: string): number {
    const s = goodText(text);
    let nr = this.setTextNumbers.get(s);
    if (nr === undefined) {
      nr = this.setTexts.length;
      this.setTexts.push(s);
      this.setTextNumbers.set(s, nr);
    }
    return nr;
  }

  hasSymbol(name: string): boolean {
    const key = asciiLower(name);
    return this.symbols.some((s) => asciiLower(s.name) === key);
  }

  /**
   * Starts a symbol (gdxDataWriteStrStart): its records follow with `record`, then `endSymbol`.
   * With the ranges of its keys (`bounds`), records given in order of their keys are written
   * as they come; otherwise they are kept and sorted. Returns the number of the symbol (from 1).
   */
  startSymbol(name: string, text: string, dim: number, type: number, userInfo: number, bounds?: { min: number[]; max: number[] }, extras?: SymbolExtras): number {
    const symbol: WrittenSymbol = { name, position: 0, dim, type, userInfo, count: 0, hasSetText: false, text: goodText(text), comments: extras?.comments ?? [] };
    if (extras?.domainSymbols) {
      symbol.domainSymbols = extras.domainSymbols.slice(0, dim);
    } else if (extras?.domainNames) {
      symbol.domainStrings = extras.domainNames.slice(0, dim).map((d) => (d === '*' ? 0 : this.domainString(d)));
    }
    this.symbols.push(symbol);
    const fields = VALUE_COUNT[type];
    this.current = { symbol, fields, keys: new Int32Array(dim * 1024), values: new Float64Array(fields * 1024), count: 0, added: 0, last: Array<number>(dim).fill(INDEX_INITIAL) };
    if (bounds) {
      this.current.stream = this.dataHeader(symbol, bounds.min, bounds.max);
    }
    return this.symbols.length;
  }

  /**
   * Adds an alias (gdxAddAlias) of the set with the number `setNumber` (0: the universe), which has
   * `dim` dimensions; aliases have no records. Returns the number of the alias.
   */
  addAlias(name: string, setNumber: number, dim: number, text: string): number {
    this.symbols.push({ name, position: 0, dim: setNumber ? dim : 1, type: 4, userInfo: setNumber, count: 0, hasSetText: false, text: goodText(text), comments: [] });
    return this.symbols.length;
  }

  /** The name and text of the acronym with an index (gdxAcronymSetInfo); others are written as UnknownACRO<index>. */
  acronym(index: number, name: string, text: string) {
    this.acronymNames.set(index, { name, text: goodText(text) });
  }

  /** The number (from 1) of a domain name of relaxed domains. */
  private domainString(name: string): number {
    const key = asciiLower(name);
    let nr = this.domainStringNumbers.get(key);
    if (nr === undefined) {
      this.domainStrings.push(name);
      nr = this.domainStrings.length;
      this.domainStringNumbers.set(key, nr);
    }
    return nr;
  }

  /** Starts the data of a symbol: the record count (set at its end) and the ranges of its keys. */
  private dataHeader(symbol: WrittenSymbol, min: number[], max: number[]): { countAt: number; min: number[]; size: number[] } {
    const o = this.out;
    symbol.position = o.length;
    o.string('_DATA_');
    o.byte(symbol.dim);
    const countAt = o.length;
    o.int(0);
    const size = min.map((m, d) => {
      const span = max[d] - m + 1;
      return span <= 0 ? 4 : span <= 255 ? 1 : span <= 65535 ? 2 : 4;
    });
    for (let d = 0; d < symbol.dim; d++) {
      o.int(min[d]);
      o.int(max[d]);
    }
    return { countAt, min, size };
  }

  /** A record: its keys as label numbers and its values as doubles of GAMS (see RAW). */
  record(keys: ArrayLike<number>, values: ArrayLike<number>) {
    const c = this.current!;
    const { dim, fields } = { dim: c.symbol.dim, fields: c.fields };
    c.added++;
    if (c.stream) {
      this.encode(c, keys, values);
      return;
    }
    if ((c.count + 1) * dim > c.keys.length || (c.count + 1) * fields > c.values.length) {
      const k = new Int32Array(c.keys.length * 2 || 1024);
      k.set(c.keys);
      c.keys = k;
      const v = new Float64Array(c.values.length * 2 || 1024);
      v.set(c.values);
      c.values = v;
    }
    for (let d = 0; d < dim; d++) c.keys[c.count * dim + d] = keys[d];
    for (let f = 0; f < fields; f++) c.values[c.count * fields + f] = values[f] ?? 0;
    c.count++;
  }

  /** Writes a record after the previous one (DoWrite): which keys changed, the keys, then the values. */
  private encode(c: NonNullable<GdxWriter['current']>, k: ArrayLike<number>, values: ArrayLike<number>) {
    const o = this.out;
    const { symbol, fields, last } = c;
    const { min, size } = c.stream!;
    const dim = symbol.dim;
    let first = dim + 1;
    let delta = 0;
    for (let d = 0; d < dim; d++) {
      delta = k[d] - last[d];
      if (delta) {
        first = d + 1;
        break;
      }
    }
    if (first > dim) {
      // A duplicate (or the record of a scalar).
      if (dim > 0 && symbol.count >= 1) return;
      o.byte(1);
    } else if (delta < 0) {
      throw new Error(`The records of ${symbol.name} are not in order.`);
    } else if (first === dim && delta <= 255 - dim - 1) {
      o.byte(dim + delta);
      last[dim - 1] = k[dim - 1];
    } else {
      o.byte(first);
      for (let d = first - 1; d < dim; d++) {
        const v = k[d] - min[d];
        if (size[d] === 1) o.byte(v);
        else if (size[d] === 2) o.word(v);
        else o.int(v);
        last[d] = k[d];
      }
    }
    for (let f = 0; f < fields; f++) {
      const x = values[f] ?? 0;
      // -0 is written as 0, NaN as NA, infinities as ±INF.
      let code = CODED.indexOf(x);
      if (code < 0 && !Number.isFinite(x)) code = Number.isNaN(x) ? 1 : x > 0 ? 2 : 3;
      if (code < 0) code = VM_NORMAL;
      o.byte(code);
      if (code === VM_NORMAL) {
        o.double(x);
        if (x >= RAW.acronym) {
          const index = Math.round(x / RAW.acronym);
          if (!this.acronyms.includes(index)) this.acronyms.push(index);
        }
      }
    }
    if ((symbol.type === 0 || symbol.type === 4) && (values[0] ?? 0) !== 0) symbol.hasSetText = true;
    symbol.count++;
  }

  /** Ends the records of the symbol (gdxDataWriteDone): kept records are sorted by their keys first. */
  endSymbol() {
    const c = this.current!;
    if (!c.stream) {
      const { dim, fields, keys, count } = { dim: c.symbol.dim, fields: c.fields, keys: c.keys, count: c.count };
      const order = new Int32Array(count).map((_, i) => i);
      order.sort((a, b) => {
        for (let d = 0; d < dim; d++) {
          const x = keys[a * dim + d] - keys[b * dim + d];
          if (x) return x;
        }
        return a - b;
      });
      // Without records, the ranges are as the GDX library writes them (InitDoWrite).
      const min = Array<number>(dim).fill(0x7fffffff);
      const max = Array<number>(dim).fill(0);
      for (let r = 0; r < count; r++) {
        for (let d = 0; d < dim; d++) {
          const v = keys[r * dim + d];
          if (v < min[d]) min[d] = v;
          if (v > max[d]) max[d] = v;
        }
      }
      c.stream = this.dataHeader(c.symbol, min, max);
      for (const i of order) this.encode(c, keys.subarray(i * dim, i * dim + dim), c.values.subarray(i * fields, i * fields + fields));
    }
    this.out.byte(255);
    // The record count of the data counts the records given, duplicates too (InitDoWrite).
    this.out.setInt(c.stream.countAt, c.added);
    this.current = undefined;
  }

  /** The file: the symbols written, then the symbol table, set texts, labels, acronyms and domains (gdxClose). */
  bytes(): Buffer {
    const o = this.out;
    const symbolPos = o.length;
    o.string('_SYMB_');
    o.int(this.symbols.length);
    for (const s of this.symbols) {
      o.string(s.name);
      o.int64(s.position);
      o.int(s.dim);
      o.byte(s.type);
      o.int(s.userInfo);
      o.int(s.count);
      o.int(0); // errors
      o.byte(s.hasSetText ? 1 : 0);
      o.string(s.text);
      o.byte(0); // not compressed
      o.byte(s.domainSymbols ? 1 : 0);
      for (const d of s.domainSymbols ?? []) o.int(d);
      o.int(s.comments.length);
      for (const c of s.comments) o.string(c);
    }
    o.string('_SYMB_');
    const setTextPos = o.length;
    o.string('_SETT_');
    o.int(this.setTexts.length);
    for (const t of this.setTexts) o.string(t);
    o.string('_SETT_');
    const uelPos = o.length;
    o.string('_UEL_');
    o.int(this.uels.length);
    for (const u of this.uels) o.string(u);
    o.string('_UEL_');
    const acronymPos = o.length;
    o.string('_ACRO_');
    o.int(this.acronyms.length);
    for (const index of this.acronyms) {
      // Acronyms without a name, as values written by the library get them.
      const info = this.acronymNames.get(index);
      o.string(info?.name || `UnknownACRO${index}`);
      o.string(info?.text ?? '');
      o.int(index);
    }
    o.string('_ACRO_');
    const domainPos = o.length;
    o.string('_DOMS_');
    o.int(this.domainStrings.length);
    for (const d of this.domainStrings) o.string(d);
    o.string('_DOMS_');
    this.symbols.forEach((s, k) => {
      if (!s.domainStrings) return;
      o.int(k + 1);
      for (const d of s.domainStrings) o.int(d);
    });
    o.int(-1);
    o.string('_DOMS_');
    const nextWrite = o.length;
    o.setInt(this.indexPosition, MARK_BOI);
    [symbolPos, uelPos, setTextPos, acronymPos, nextWrite, domainPos].forEach((p, k) => o.setInt64(this.indexPosition + 4 + 8 * k, p));
    return o.bytes();
  }

  /** Writes the file (to a temporary file that replaces `file`, so that readers never see half of it). */
  async write(file: string): Promise<void> {
    await writeFile(file, this.bytes());
  }
}
