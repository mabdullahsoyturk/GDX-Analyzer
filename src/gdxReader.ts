/**
 * Reads GDX files natively, without gdxdump: the file format of the GDX library of GAMS
 * (versions 5 to 7, compressed or not; see https://github.com/GAMS-dev/gdx, src/gxfile.cpp
 * and src/gdlib/gmsstrm.cpp, MIT license). The results are those gdxdump gives as the rest
 * of the extension reads them (see gdxFile.ts): the symbols with their types, domains and
 * subtypes, the unique elements, and the records of a symbol in compact columns.
 *
 * Files are read in chunks with asynchronous reads, so large symbols do not block (see platform/files.ts).
 * No dependency on `vscode`.
 */
import * as zlib from 'zlib';
import { ColumnStore, LabelColumn, Labels, NumberColumn, Sp, StoredColumn } from './columns';
import type { GdxSymbol, SymbolColumns, SymbolType } from './parse';
import { columnNames } from './parse';
import { textDecoder } from './encoding';
import { ReadHandle, openFile } from './platform/files';

/**
 * The "encoding" that keeps labels and texts byte for byte, one character (0-255) per byte. Not the
 * text decoder's latin1: that is windows-1252 in some Node.js versions, which maps bytes 0x80-0x9F
 * to other characters.
 */
export const RAW_BYTES = 'x-raw-bytes';

/** The file is not a GDX file, or one this reader does not support. */
export class GdxFormatError extends Error {}

const HEADER_NR = 123;
const HEADER_ID = 'GAMSGDX';
const MAX_VERSION = 7;
const MARK_BOI = 19510624;
/** Before version 7, the first dimension that changed is coded as at most this many (MaxDimV148). */
const DELTA_BEFORE_V7 = 10;
const INDEX_INITIAL = -256;
/** Bytes of the largest record: the dimension byte, 20 keys of 4 bytes and 5 values of 9 bytes. */
const MAX_RECORD_BYTES = 1 + 20 * 4 + 5 * 9;
const CHUNK = 1 << 20;

/** Data types of symbols (gdxSyType) and the number of values of their records. */
const TYPES: SymbolType[] = ['Set', 'Par', 'Var', 'Equ', 'Alias'];
const VALUE_COUNT = [1, 1, 5, 5, 0];
const VAR_TYPES = ['', 'binary', 'integer', 'positive', 'negative', 'free', 'sos1', 'sos2', 'semicont', 'semiint'];
const VAR_FREE = 5;
const EQU_USERINFO_BASE = 53;
const SET_SINGLETON = 1;

/** Special values of GAMS as stored in memory (GMS_SV_*), and the start of acronyms. */
const SV_UNDF = 1e300;
const SV_NA = 2e300;
const SV_PINF = 3e300;
const SV_MINF = 4e300;
const SV_EPS = 5e300;
const SV_ACR = 1e301;

/** Value codes of records (TgdxIntlValTyp): specials, frequent numbers, or a double that follows. */
const enum Vm {
  Undf = 0,
  NA,
  PInf,
  MInf,
  Eps,
  Zero,
  One,
  MOne,
  Half,
  Two,
  Normal,
}
const VM_SPECIAL: Sp[] = [Sp.Undf, Sp.NA, Sp.PInf, Sp.MInf, Sp.Eps];
const VM_NUMBER = [0, 0, 0, 0, 0, 0, 1, -1, 0.5, 2];

/** Default records (level, marginal, lower, upper, scale) of variables by type and of equations by type. */
const INF = Infinity;
const VAR_DEFAULTS: number[][] = [
  [0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1],
  [0, 0, 0, INF, 1],
  [0, 0, 0, INF, 1],
  [0, 0, -INF, 0, 1],
  [0, 0, -INF, INF, 1],
  [0, 0, 0, INF, 1],
  [0, 0, 0, INF, 1],
  [0, 0, 1, INF, 1],
  [0, 0, 1, INF, 1],
];
const EQU_DEFAULTS: number[][] = [
  [0, 0, 0, 0, 1],
  [0, 0, 0, INF, 1],
  [0, 0, -INF, 0, 1],
  [0, 0, -INF, INF, 1],
  [0, 0, 0, 0, 1],
  [0, 0, 0, INF, 1],
  [0, 0, 0, 0, 1],
];

/**
 * Sequential reads from a position of the file, through the blocks of a compressed section
 * (a 3-byte header: compressed or not, and the length; zlib data or plain bytes). Before reading,
 * callers make sure enough bytes are available with `need` (only asynchronous when it reads).
 */
class Section {
  private buf = Buffer.alloc(0);
  private pos = 0;
  /** Compressed sections: raw bytes read from the file that do not form a whole block yet. */
  private raw = Buffer.alloc(0);
  private ended = false;

  constructor(
    private readonly fh: ReadHandle,
    private filePos: number,
    private readonly compressed: boolean,
    private readonly signal?: AbortSignal,
  ) {}

  get available(): number {
    return this.buf.length - this.pos;
  }

  /** Makes at least `n` bytes available, fewer only at the end of the file (or of a compressed section). */
  async need(n: number): Promise<void> {
    if (this.available >= n || this.ended) return;
    this.signal?.throwIfAborted();
    const kept = this.buf.subarray(this.pos);
    const added: Buffer[] = [];
    let size = kept.length;
    while (size < n && !this.ended) {
      const block = this.compressed ? await this.block() : await this.read(CHUNK);
      if (!block?.length) {
        this.ended = true;
      } else {
        added.push(block);
        size += block.length;
      }
    }
    this.buf = Buffer.concat([kept, ...added]);
    this.pos = 0;
  }

  private async read(length: number): Promise<Buffer> {
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.fh.read(chunk, 0, length, this.filePos);
    this.filePos += bytesRead;
    return chunk.subarray(0, bytesRead);
  }

  /**
   * The next block of a compressed section, decompressed. Blocks are only decoded when their
   * bytes are needed: what follows the last block of a section is not one. Undefined at the end.
   */
  private async block(): Promise<Buffer | undefined> {
    while (this.raw.length < 3 || this.raw.length < 3 + ((this.raw[1] << 8) | this.raw[2])) {
      const chunk = await this.read(CHUNK);
      if (!chunk.length) return undefined;
      this.raw = Buffer.concat([this.raw, chunk]);
    }
    const length = (this.raw[1] << 8) | this.raw[2];
    const data = this.raw.subarray(3, 3 + length);
    let block: Buffer | undefined;
    try {
      block = this.raw[0] ? zlib.inflateSync(data) : Buffer.from(data);
    } catch {
      // Not a block: the end of the section (reading on reports that the file ends).
      block = undefined;
    }
    this.raw = this.raw.subarray(3 + length);
    return block;
  }

  private check(n: number) {
    if (this.available < n) throw new GdxFormatError('The GDX file ends unexpectedly.');
  }

  byte(): number {
    this.check(1);
    return this.buf[this.pos++];
  }

  word(): number {
    this.check(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  int(): number {
    this.check(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  int64(): number {
    this.check(8);
    const v = Number(this.buf.readBigInt64LE(this.pos));
    this.pos += 8;
    return v;
  }

  double(): number {
    this.check(8);
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  /** A string: a length byte and that many bytes (as stored, decoded by the caller). */
  bytes(): Buffer {
    const length = this.byte();
    this.check(length);
    const v = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return v;
  }

  ascii(): string {
    return this.bytes().toString('latin1');
  }

  /** Reads a string such as _UEL_ that marks the start or end of a section. */
  marker(expected: string) {
    if (this.ascii() !== expected) throw new GdxFormatError(`The GDX file is damaged (no ${expected} marker).`);
  }
}

/**
 * The label ids of a column for numbers (of unique elements or set texts): the labels are interned in
 * order of first appearance, as from gdxdump's output; a table makes the lookup of a number cheap.
 */
class LabelIds {
  readonly labels = new Labels();
  /** By number: the id + 1 (0: not seen yet). */
  private readonly dense: Int32Array;
  private sparse?: Map<number, number>;

  constructor(
    size: number,
    private readonly name: (k: number) => string,
  ) {
    this.dense = new Int32Array(size + 1);
  }

  id(k: number): number {
    if (k >= 0 && k < this.dense.length) {
      const v = this.dense[k];
      if (v) return v - 1;
      const id = this.labels.intern(this.name(k));
      this.dense[k] = id + 1;
      return id;
    }
    // Numbers beyond the table (e.g. elements without a label): rare.
    const map = (this.sparse ??= new Map());
    let id = map.get(k);
    if (id === undefined) {
      id = this.labels.intern(this.name(k));
      map.set(k, id);
    }
    return id;
  }
}

/** A symbol as stored in the symbol table of a GDX file. */
export interface SymbolEntry {
  name: string;
  /** The symbol number (from 1). */
  entry: number;
  position: number;
  dim: number;
  /** gdxSyType: 0 set, 1 parameter, 2 variable, 3 equation, 4 alias. */
  dataType: number;
  userInfo: number;
  count: number;
  text: string;
  compressed: boolean;
  /** Regular domains: the numbers of the domain sets (0: the universe). */
  domainSymbols?: number[];
  /** Relaxed domains: the numbers of the domain names (0: the universe). */
  domainStrings?: number[];
  comments: string[];
}

/** An acronym of a GDX file: its name, text and the index of its values. */
export interface Acronym {
  name: string;
  text: string;
  index: number;
}

/**
 * A record as `scan` reports it (the arrays are reused for the next record): the keys as numbers
 * of unique elements, the first key that changed since the previous record, and the values of
 * its fields. Values are numbers (special = Sp.None) or special values; acronyms are Sp.Text with
 * the acronym index as value. The level of a set record is the number of its element text.
 */
export type RecordHandler = (keys: Int32Array, changedFrom: number, values: Float64Array, special: Uint8Array) => void;

export interface GdxContents {
  /** As gdxdump -V writes them: file version, producer, file format, compression, symbols, unique elements. */
  version: [string, string][];
  /** In the order of their names (as gdxdump lists them), with their entries. */
  symbols: GdxSymbol[];
  /** The unique elements, in GDX order (UEL numbers from 1). */
  uels: string[];
}

/**
 * The tables of a GDX file: its symbols, unique elements, set texts, acronyms and domains. The
 * file is read again for the records of a symbol (callers check that it did not change).
 */
export class GdxReader {
  private constructor(
    readonly file: string,
    private readonly versionRead: number,
    private readonly compressed: boolean,
    private readonly systemId: string,
    private readonly producer: string,
    /** By symbol number - 1. */
    readonly entries: SymbolEntry[],
    readonly uels: string[],
    readonly setTexts: string[],
    /** In the order of the file. */
    readonly acronyms: Acronym[],
    private readonly domainStrings: string[],
  ) {}

  /**
   * Opens a GDX file and reads its tables; labels and texts are decoded with `encoding`, or kept
   * byte for byte with RAW_BYTES (one character per byte, as gdxWriter.ts writes them back).
   */
  static async open(file: string, encoding = 'utf-8'): Promise<GdxReader> {
    let text: (b: Buffer) => string;
    if (encoding === RAW_BYTES) {
      text = (b) => b.toString('latin1');
    } else {
      const decoder = textDecoder(encoding);
      text = (b) => (b.length ? decoder.decode(b) : '');
    }
    const fh = await openFile(file);
    try {
      const head = new Section(fh, 0, false);
      await head.need(4096);
      // Byte order: the sizes and patterns of a word, an integer and a double.
      const sizes = [head.byte(), head.word(), head.byte(), head.int(), head.byte(), head.double()];
      if (sizes[0] !== 2 || sizes[2] !== 4 || sizes[4] !== 8) {
        throw new GdxFormatError('Not a GDX file.');
      }
      if (sizes[1] !== 0x1234 || sizes[3] !== 0x12345678 || sizes[5] !== 3.1415926535897932385) {
        throw new GdxFormatError('GDX files with big-endian byte order are not supported.');
      }
      if (head.byte() !== HEADER_NR || head.ascii().toUpperCase() !== HEADER_ID) {
        throw new GdxFormatError('Not a GDX file.');
      }
      const version = head.int();
      if (version > MAX_VERSION || version < 5) {
        throw new GdxFormatError(`GDX file format version ${version} is not supported.`);
      }
      const compression = version <= 5 ? 0 : head.int();
      const systemId = head.ascii();
      const producer = head.ascii();
      if (head.int() !== MARK_BOI) throw new GdxFormatError('The GDX file is damaged (no index).');
      const pos = () => (version <= 5 ? head.int() : head.int64());
      const symbolPos = pos();
      const uelPos = pos();
      const setTextPos = pos();
      let acronymPos = 0;
      let domainPos = 0;
      if (version <= 5) {
        pos();
      } else if (version >= 7) {
        acronymPos = head.int64();
        head.int64();
        domainPos = head.int64();
      }
      const compressed = compression > 0;
      const section = async (at: number) => {
        const s = new Section(fh, at, compressed);
        await s.need(MAX_RECORD_BYTES + 256);
        return s;
      };
      /** The strings of a list (count and strings), reading more as needed. */
      const strings = async (s: Section, n: number, out: string[] = []) => {
        for (let k = 0; k < n; k++) {
          if (s.available < 256) await s.need(256);
          out.push(text(s.bytes()));
        }
        return out;
      };

      // The symbol table.
      const syms = await section(symbolPos);
      syms.marker('_SYMB_');
      const count = syms.int();
      const entries: SymbolEntry[] = [];
      for (let n = 1; n <= count; n++) {
        await syms.need(1024 + 20 * 4);
        const name = text(syms.bytes());
        const e: SymbolEntry = {
          name,
          entry: n,
          position: version <= 5 ? syms.int() : syms.int64(),
          dim: syms.int(),
          dataType: syms.byte(),
          userInfo: syms.int(),
          count: syms.int(),
          text: '',
          compressed: false,
          comments: [],
        };
        syms.int(); // errors
        syms.byte(); // has set texts
        e.text = text(syms.bytes());
        e.compressed = version > 5 && syms.byte() !== 0;
        if (version >= 7) {
          if (syms.byte()) e.domainSymbols = Array.from({ length: e.dim }, () => syms.int());
          const comments = syms.int();
          for (let k = 0; k < comments; k++) {
            await syms.need(256);
            e.comments.push(text(syms.bytes()));
          }
        }
        entries.push(e);
      }
      await syms.need(16);
      syms.marker('_SYMB_');

      // The unique elements, the set texts, the acronyms and the domain names (of relaxed domains).
      const uelSection = await section(uelPos);
      uelSection.marker('_UEL_');
      const uels = await strings(uelSection, uelSection.int());
      await uelSection.need(16);
      uelSection.marker('_UEL_');

      const textSection = await section(setTextPos);
      textSection.marker('_SETT_');
      const setTexts = await strings(textSection, textSection.int());

      const acronyms: Acronym[] = [];
      if (version >= 7 && acronymPos) {
        const s = await section(acronymPos);
        s.marker('_ACRO_');
        const n = s.int();
        for (let k = 0; k < n; k++) {
          await s.need(600);
          acronyms.push({ name: text(s.bytes()), text: text(s.bytes()), index: s.int() });
        }
      }

      const domainStrings: string[] = [];
      if (version >= 7 && domainPos) {
        const s = await section(domainPos);
        s.marker('_DOMS_');
        await strings(s, s.int(), domainStrings);
        await s.need(16);
        s.marker('_DOMS_');
        for (;;) {
          await s.need(4 + 20 * 4);
          const nr = s.int();
          if (nr <= 0) break;
          const e = entries[nr - 1];
          if (!e) throw new GdxFormatError('The GDX file is damaged (domain of an unknown symbol).');
          e.domainStrings = Array.from({ length: e.dim }, () => s.int());
        }
      }
      return new GdxReader(file, version, compressed, systemId, producer, entries, uels, setTexts, acronyms, domainStrings);
    } finally {
      await fh.close();
    }
  }

  /** The domain of a symbol and its kind, as gdxSymbolGetDomainX (relaxed: names, regular: symbols). */
  domainOf(e: SymbolEntry): { domain: string[]; domainType: string } {
    const domain = Array<string>(e.dim).fill('*');
    if (e.domainStrings) {
      e.domainStrings.forEach((d, k) => d > 0 && (domain[k] = this.domainStrings[d - 1] ?? '*'));
      return { domain, domainType: 'Relaxed' };
    }
    if (!e.domainSymbols) {
      return { domain, domainType: 'None' };
    }
    e.domainSymbols.forEach((d, k) => d > 0 && (domain[k] = this.entries[d - 1]?.name ?? '*'));
    return { domain, domainType: 'Regular' };
  }

  /** The symbols, in the order and with the information gdxFile.ts reads from gdxdump. */
  contents(): GdxContents {
    const symbols = this.entries.map((e): GdxSymbol => {
      const { domain, domainType } = this.domainOf(e);
      const s: GdxSymbol = {
        name: e.name,
        dim: e.dim,
        type: TYPES[e.dataType] ?? 'Set',
        // Scalars have a record even if none is stored (gdxSymbolInfoX).
        records: e.dim === 0 ? 1 : e.count,
        text: e.text,
        domain,
        domainType,
        entry: e.entry,
      };
      if (e.dataType === 2) {
        const t = e.userInfo < 0 || e.userInfo >= VAR_TYPES.length ? VAR_FREE : e.userInfo;
        if (t) s.subtype = VAR_TYPES[t];
      } else if (e.dataType === 0 && e.userInfo === SET_SINGLETON) {
        s.subtype = 'singleton';
      }
      return s;
    });
    // gdxdump lists the symbols by name.
    symbols.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const nice = (n: number) => n.toLocaleString('en-US');
    return {
      version: [
        ['File version', this.systemId],
        ['Producer', this.producer],
        ['File format', nice(this.versionRead)],
        ['Compression', nice(this.compressed ? 1 : 0)],
        ['Symbols', nice(this.entries.length)],
        ['Unique Elements', nice(this.uels.length)],
      ],
      symbols,
      uels: this.uels,
    };
  }

  /**
   * The records of a symbol in compact columns, as gdxFile.ts reads them from gdxdump
   * (Format=csv CSVAllFields CSVSetText): the keys, then the value (Level for variables and
   * equations, with Marginal, Lower, Upper and Scale), or the element texts of sets.
   */
  async symbolColumns(symbol: Pick<GdxSymbol, 'name' | 'dim' | 'type' | 'domain' | 'records'>, signal?: AbortSignal): Promise<SymbolColumns> {
    const fh = await openFile(this.file);
    try {
      return await this.readRecords(fh, symbol, signal);
    } finally {
      await fh.close();
    }
  }

  /** The symbol of a name (as gdxFindSymbol: case-insensitive). */
  entry(name: string): SymbolEntry {
    const e = this.entries.find((x) => x.name === name) ?? this.entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!e) throw new GdxFormatError(`The GDX file has no symbol ${name}.`);
    return e;
  }

  /** The name of an acronym index (as gdxAcronymName). */
  acronymName(index: number): string {
    return this.acronyms.find((a) => a.index === index)?.name ?? `UnknownAcronym${index}`;
  }

  /**
   * Reads the records of a symbol and hands each to `onRecord` (see RecordHandler): an alias
   * reads its set or the universe, and a scalar without a stored record its default record.
   */
  async forEachRecord(e: SymbolEntry, onRecord: RecordHandler, signal?: AbortSignal): Promise<void> {
    const fh = await openFile(this.file);
    try {
      await this.scan(fh, e, onRecord, signal);
    } finally {
      await fh.close();
    }
  }

  private async scan(fh: ReadHandle, e: SymbolEntry, onRecord: RecordHandler, signal?: AbortSignal): Promise<void> {
    let target: SymbolEntry | undefined = e;
    for (let guard = 0; target && target.dataType === 4 && guard < 100; guard++) {
      target = target.userInfo > 0 ? this.entries[target.userInfo - 1] : undefined;
    }
    const values = new Float64Array(5);
    const special = new Uint8Array(5);
    if (!target) {
      // The universe: one record per unique element.
      const keys = new Int32Array(1);
      for (let k = 1; k <= this.uels.length; k++) {
        keys[0] = k;
        onRecord(keys, 0, values, special);
      }
      return;
    }
    const dim = target.dim;
    const keys = new Int32Array(dim);
    const s = new Section(fh, target.position, target.compressed, signal);
    await s.need(64 + dim * 8);
    s.marker('_DATA_');
    if (s.byte() !== dim) throw new GdxFormatError(`The GDX file is damaged (dimension of ${e.name}).`);
    s.int(); // record count
    const fields = VALUE_COUNT[target.dataType];
    const set = (f: number, x: number, code?: Sp) => {
      if (code !== undefined) {
        values[f] = 0;
        special[f] = code;
      } else if (Number.isNaN(x)) {
        // Special values and acronyms stored as numbers (gdxMapValue, gdxAcronymName).
        values[f] = 0;
        special[f] = Sp.NA;
      } else if (x >= SV_ACR) {
        values[f] = Math.round(x / SV_ACR);
        special[f] = Sp.Text;
      } else if (x === SV_UNDF || x === SV_NA || x === SV_PINF || x === SV_MINF || x === SV_EPS) {
        values[f] = 0;
        special[f] = x === SV_UNDF ? Sp.Undf : x === SV_NA ? Sp.NA : x === SV_PINF ? Sp.PInf : x === SV_MINF ? Sp.MInf : Sp.Eps;
      } else {
        values[f] = x;
        special[f] = Sp.None;
      }
    };
    if (dim === 0 && target.count === 0) {
      // A scalar without a stored record: its default record.
      const defaults =
        target.dataType === 2
          ? VAR_DEFAULTS[target.userInfo >= 0 && target.userInfo < VAR_DEFAULTS.length ? target.userInfo : 0]
          : target.dataType === 3
            ? EQU_DEFAULTS[target.userInfo >= EQU_USERINFO_BASE && target.userInfo < EQU_USERINFO_BASE + EQU_DEFAULTS.length ? target.userInfo - EQU_USERINFO_BASE : 0]
            : [0];
      for (let f = 0; f < fields; f++) {
        const x = defaults[f];
        set(f, x, x === INF ? Sp.PInf : x === -INF ? Sp.MInf : undefined);
      }
      onRecord(keys, 0, values, special);
      return;
    }
    const min = new Int32Array(dim);
    const size = new Uint8Array(dim);
    for (let d = 0; d < dim; d++) {
      min[d] = s.int();
      const span = s.int() - min[d] + 1;
      size[d] = span <= 0 ? 4 : span <= 255 ? 1 : span <= 65535 ? 2 : 4;
    }
    const delta = this.versionRead <= 6 ? DELTA_BEFORE_V7 : dim;
    keys.fill(INDEX_INITIAL);
    for (;;) {
      if (s.available < MAX_RECORD_BYTES) await s.need(MAX_RECORD_BYTES);
      const b = s.byte();
      let from: number;
      if (b > delta) {
        if (b === 255) break;
        from = dim - 1;
        if (dim > 0) keys[dim - 1] += b - delta;
      } else {
        from = Math.max(0, b - 1);
        for (let d = from; d < dim; d++) {
          keys[d] = (size[d] === 1 ? s.byte() : size[d] === 2 ? s.word() : s.int()) + min[d];
        }
      }
      for (let f = 0; f < fields; f++) {
        const code = s.byte();
        if (code === Vm.Normal) {
          set(f, s.double());
        } else if (code < Vm.Zero) {
          set(f, 0, VM_SPECIAL[code]);
        } else {
          // Out of range codes are read as 0 (as the GDX library does).
          set(f, VM_NUMBER[code] ?? 0);
        }
      }
      onRecord(keys, Math.max(0, from), values, special);
    }
  }

  private async readRecords(fh: ReadHandle, symbol: Pick<GdxSymbol, 'name' | 'dim' | 'type' | 'domain' | 'records'>, signal?: AbortSignal): Promise<SymbolColumns> {
    const e = this.entry(symbol.name);
    let target: SymbolEntry | undefined = e;
    for (let guard = 0; target && target.dataType === 4 && guard < 100; guard++) {
      target = target.userInfo > 0 ? this.entries[target.userInfo - 1] : undefined;
    }
    const isSet = e.dataType === 0 || e.dataType === 4;
    const dim = e.dim;
    const fields = isSet ? 0 : VALUE_COUNT[e.dataType];
    // Sized by the record count of the symbol table; grown if the file has more records.
    let capacity = Math.max(16, target ? target.count : this.uels.length);
    // Keys as label ids of their column (labels in order of appearance, as from gdxdump).
    const uel = (k: number) => this.uels[k - 1] ?? `L__${k}`;
    const keyLabels = Array.from({ length: dim }, () => new LabelIds(this.uels.length, uel));
    const keyIds = Array.from({ length: dim }, () => new Int32Array(capacity));
    const columns = Array.from({ length: fields }, () => ({ values: new Float64Array(capacity), special: new Uint8Array(capacity), texts: undefined as Map<number, string> | undefined }));
    /** Sets: the label id of the element text of each record (number 0: none, else the text number + 1). */
    const textLabels = new LabelIds(isSet ? this.setTexts.length : 0, (k) => (k === 0 ? '' : (this.setTexts[k - 1] ?? '')));
    let textIds = new Int32Array(isSet ? capacity : 0);
    let rows = 0;
    const grow = () => {
      capacity *= 2;
      const bigger = <T extends Int32Array | Float64Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(capacity);
        b.set(a);
        return b;
      };
      keyIds.forEach((k, d) => (keyIds[d] = bigger(k)));
      columns.forEach((v) => ((v.values = bigger(v.values)), (v.special = bigger(v.special))));
      if (isSet) textIds = bigger(textIds);
    };
    /** The label id of each key of the last record. */
    const lastId = new Int32Array(dim);
    await this.scan(
      fh,
      e,
      (keys, from, values, special) => {
        if (rows >= capacity) grow();
        for (let d = from; d < dim; d++) lastId[d] = keyLabels[d].id(keys[d]);
        for (let d = 0; d < dim; d++) keyIds[d][rows] = lastId[d];
        if (isSet) {
          const level = special[0] === Sp.None ? values[0] : 0;
          textIds[rows] = textLabels.id(level !== 0 ? Math.round(level) + 1 : 0);
        }
        for (let f = 0; f < fields; f++) {
          const c = columns[f];
          c.values[rows] = special[f] === Sp.Text ? 0 : values[f];
          c.special[rows] = special[f];
          if (special[f] === Sp.Text) (c.texts ??= new Map()).set(rows, this.acronymName(values[f]));
        }
        rows++;
      },
      signal,
    );

    // Trimmed to the records read (usually the count of the symbol table: no copy).
    const trim = <T extends Int32Array | Float64Array | Uint8Array>(a: T): T => (a.length === rows ? a : (a.slice(0, rows) as T));
    const stored: StoredColumn[] = keyIds.map((ids, d): LabelColumn => ({ type: 'label', ids: trim(ids), labels: keyLabels[d].labels }));
    if (isSet) {
      stored.push({ type: 'label', ids: trim(textIds), labels: textLabels.labels });
    }
    for (const v of columns) {
      const column: NumberColumn = { type: 'number', values: trim(v.values), special: trim(v.special) };
      if (v.texts) column.texts = v.texts;
      stored.push(column);
    }
    return { columns: columnNames(this.header(e, isSet), symbol), keyCount: dim, store: new ColumnStore(rows, stored) };
  }

  /** The column headers gdxdump writes in CSV format (domain names, Dim1... for the universe, renamed duplicates). */
  header(e: SymbolEntry, isSet: boolean): string[] {
    const domain = this.domainOf(e).domain.map((d, k) => (d === '*' ? `Dim${k + 1}` : d));
    const names: string[] = [];
    // As gdxdump does: compared with the names before the previous one, numbered across all dimensions.
    let nr = 1;
    for (let d = 0; d < e.dim; d++) {
      let s = domain[d];
      while (names.slice(0, Math.max(0, d - 1)).includes(s)) s = `${domain[d]}_${nr++}`;
      names.push(s);
    }
    if (isSet) return [...names, 'Text'];
    return [...names, 'Val', ...(e.dataType === 2 || e.dataType === 3 ? ['Marginal', 'Lower', 'Upper', 'Scale'] : [])];
  }
}
