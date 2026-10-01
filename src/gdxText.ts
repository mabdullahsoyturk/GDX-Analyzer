/**
 * The text output of gdxdump, written from the native reader (gdxReader.ts): a whole file or one
 * symbol in gdxdump's normal format (GAMS declarations with their data), and a symbol in its CSV
 * format with all fields and set texts. The text is the one gdxdump writes (with its default
 * options; see https://github.com/GAMS-dev/gdx, src/tools/gdxdump/gdxdump.cpp, MIT license).
 *
 * No dependency on `vscode`.
 */
import { Sp } from './columns';
import { GdxReader, SymbolEntry } from './gdxReader';

const TYPE_NAMES = ['Set', 'Parameter', 'Variable', 'Equation', 'Alias'];
/** Variable types as gdxdump declares them (varTypStr, padded). */
const VAR_TYPE_NAMES = ['unknown ', 'binary  ', 'integer ', 'positive', 'negative', 'free    ', 'sos1    ', 'sos2    ', 'semicont', 'semiint '];
const FIELD_NAMES = ['L', 'M', 'LO', 'UP', 'SCALE'];
const SPECIAL_NAMES: Partial<Record<Sp, string>> = { [Sp.Undf]: 'Undf', [Sp.NA]: 'NA', [Sp.PInf]: '+Inf', [Sp.MInf]: '-Inf', [Sp.Eps]: 'Eps' };

/** Special values of GAMS as doubles (GMS_SV_*), to compare values with defaults as gdxdump does. */
const RAW_SPECIAL: Partial<Record<Sp, number>> = { [Sp.Undf]: 1e300, [Sp.NA]: 2e300, [Sp.PInf]: 3e300, [Sp.MInf]: 4e300, [Sp.Eps]: 5e300 };
const P = 3e300;
const M = 4e300;
/** Default records (level, marginal, lower, upper, scale) by variable type and equation type (gmsDefRecVar, gmsDefRecEqu). */
const VAR_DEFAULTS = [
  [0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1],
  [0, 0, 0, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, M, 0, 1],
  [0, 0, M, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, 1, P, 1],
  [0, 0, 1, P, 1],
];
const EQU_DEFAULTS = [
  [0, 0, 0, 0, 1],
  [0, 0, 0, P, 1],
  [0, 0, M, 0, 1],
  [0, 0, M, P, 1],
  [0, 0, 0, 0, 1],
  [0, 0, 0, P, 1],
  [0, 0, 0, 0, 1],
];

const bits = new DataView(new ArrayBuffer(8));

/** The exact value of a positive double as a fraction of BigInts. */
function exact(x: number): [bigint, bigint] {
  bits.setFloat64(0, x);
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent = biased - 1075;
  if (biased === 0) exponent = -1074;
  else mantissa |= 1n << 52n;
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

/**
 * The 15 significant digits of a positive number, rounded to nearest with ties to even (as
 * dtoa mode 2 does; JavaScript rounds ties up), without trailing zeros, and the decimal exponent.
 */
/** The smallest normal double: below it, doubles have fewer significant digits. */
const MIN_NORMAL = 2.2250738585072014e-308;

/** Powers of ten that are doubles exactly. */
const POW10 = Array.from({ length: 23 }, (_, k) => Number(`1e${k}`));

/**
 * The 15 digits of a normal number scaled into [1e14, 1e15) by an exact power of ten: one rounding,
 * off by at most 0.0625, so the nearest integer is right unless the number lies near a half.
 */
function fast15(x: number): { digits: string; exponent: number } | undefined {
  let exponent = Math.floor(Math.log10(x));
  for (let attempt = 0; attempt < 2; attempt++) {
    const k = 14 - exponent;
    if (k < -22 || k > 22) return undefined;
    const scaled = k >= 0 ? x * POW10[k] : x / POW10[-k];
    // log10 may be off by one near powers of ten.
    if (scaled < 1e14) {
      exponent--;
      continue;
    }
    if (scaled >= 1e15) {
      exponent++;
      continue;
    }
    const whole = Math.floor(scaled);
    const fraction = scaled - whole;
    if (Math.abs(fraction - 0.5) < 0.07) return undefined;
    let n = fraction > 0.5 ? whole + 1 : whole;
    if (n >= 1e15) {
      n = 1e14;
      exponent++;
    }
    return { digits: String(n).replace(/0+$/, ''), exponent };
  }
  return undefined;
}

function digits15(x: number): { digits: string; exponent: number } {
  const fast = x >= MIN_NORMAL ? fast15(x) : undefined;
  if (fast) return fast;
  // The shortest digits that give the number back: if there are at most 15, they are its digits
  // (for normal numbers: their precision is about 16 digits).
  const shortest = x >= MIN_NORMAL ? String(x) : '';
  const ei = shortest.indexOf('e');
  const decimal = ei < 0 ? shortest : shortest.slice(0, ei);
  const dot = decimal.indexOf('.');
  const whole = dot < 0 ? decimal : decimal.slice(0, dot);
  const all = dot < 0 ? whole : whole + decimal.slice(dot + 1);
  let lead = 0;
  while (all.charCodeAt(lead) === 48) lead++;
  const significant = all.slice(lead).replace(/0+$/, '');
  const shortestExponent = (ei < 0 ? 0 : Number(shortest.slice(ei + 1))) + whole.length - 1 - lead;
  if (shortest && significant.length <= 15) {
    return { digits: significant || '0', exponent: shortestExponent };
  }
  // 17 digits are the correctly rounded ones: rounding them to 15 is that of the number, unless the
  // last two are 50 (the number may lie on either side of the middle).
  if (significant.length === 17 && significant.slice(15) !== '50') {
    let digits = significant.slice(0, 15);
    let exponent = shortestExponent;
    if (significant.charCodeAt(15) >= 53) {
      const up = (BigInt(digits) + 1n).toString();
      if (up.length > 15) {
        digits = up.slice(0, 15);
        exponent++;
      } else {
        digits = up;
      }
    }
    return { digits: digits.replace(/0+$/, '') || '0', exponent };
  }
  const [mantissa, e] = x.toExponential(14).split('e');
  let digits = mantissa.replace('.', '');
  let exponent = Number(e);
  // A tie: the exact value ends with a 5 at the 16th digit (then its shortest digits are those 16).
  const sixteen = significant.length === 16 && significant.endsWith('5') ? x.toExponential(15).split('e') : undefined;
  const d16 = sixteen?.[0].replace('.', '');
  if (sixteen && d16 && d16.endsWith('5')) {
    const e16 = Number(sixteen[1]) - 15;
    const [num, den] = exact(x);
    const scale = 10n ** BigInt(Math.abs(e16));
    const value = BigInt(d16);
    if (e16 >= 0 ? value * scale * den === num : value * den === num * scale) {
      // Ties to even: down if the 15th digit is even.
      let rounded = value / 10n;
      if (rounded % 2n === 1n) rounded += 1n;
      digits = rounded.toString();
      exponent = Number(sixteen[1]);
      if (digits.length > 15) {
        digits = digits.slice(0, 15);
        exponent++;
      }
    }
  }
  return { digits: digits.replace(/0+$/, '') || '0', exponent };
}

/**
 * A number as gdxdump writes it (DblToStrSep): 15 significant digits, in fixed notation for
 * magnitudes from 1e-4 to below 1e15 (e.g. 0.009, 153.675), otherwise in E notation (1.5E30, 1E-300).
 */
export function formatDouble(x: number): string {
  if (x === 0) return '0';
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
  const a = Math.abs(x);
  const { digits, exponent } = digits15(a);
  let s: string;
  if (a >= 1e-4 && a < 1e15) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
      const fraction = digits.slice(exponent + 1);
      s = fraction ? `${whole}.${fraction}` : whole;
    } else {
      s = `0.${'0'.repeat(-exponent - 1)}${digits}`;
    }
  } else {
    s = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}E${exponent < 0 ? '-' : ''}${Math.abs(exponent)}`;
  }
  return x < 0 ? `-${s}` : s;
}

/** gdxdump's QQ: single quotes unless the text has one. */
const quoteOf = (s: string) => (s.includes("'") ? '"' : "'");

/** A label, always quoted (WriteUEL). */
const label = (s: string) => `${quoteOf(s)}${s}${quoteOf(s)}`;

/** A text, preceded by a blank, quoted if it has one of `special` or ".." (WriteQuotedCommon). */
function quotedText(s: string, special: string, from = 0, plain = true): string {
  for (let k = from; k < s.length && plain; k++) {
    if (special.includes(s[k]) || (s[k] === '.' && s[k + 1] === '.')) plain = false;
  }
  return plain ? ` ${s}` : ` ${quoteOf(s)}${s}${quoteOf(s)}`;
}

/** Explanatory text (WriteQText); a parenthesis at its start would confuse the GAMS compiler. */
function explanatoryText(s: string, checkParenthesis: boolean): string {
  let i = 0;
  let plain = true;
  if (checkParenthesis) {
    while (i < s.length && s[i] === ' ') i++;
    if (i < s.length) plain = s[i] !== '(';
  }
  return quotedText(s, ',;/$=\'"', i, plain);
}

/** The text of a set element (WriteQUELText). */
const elementText = (s: string) => quotedText(s, ' ,;/$=*');

/** A field of a CSV file, quoted with doubled quotes (QQCSV). */
const csvField = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Writes the records of symbols as gdxdump does. */
class Writer {
  readonly out: string[] = [];
  private badUels = 0;
  /** Labels as written, by number of unique element (quoted, or as CSV fields). */
  private readonly quoted: string[] = [];
  private readonly csvQuoted: string[] = [];

  constructor(private readonly reader: GdxReader) {}

  private uel(k: number): string {
    const s = this.reader.uels[k - 1];
    if (s === undefined) {
      this.badUels++;
      return `L__${k}`;
    }
    return s;
  }

  private quotedUel(k: number): string {
    return this.quoted[k] ?? (k >= 1 && k <= this.reader.uels.length ? (this.quoted[k] = label(this.uel(k))) : label(this.uel(k)));
  }

  private csvUel(k: number): string {
    return this.csvQuoted[k] ?? (k >= 1 && k <= this.reader.uels.length ? (this.csvQuoted[k] = csvField(this.uel(k))) : csvField(this.uel(k)));
  }

  private value(x: number, sp: Sp): string {
    if (sp === Sp.Text) return this.reader.acronymName(x);
    return SPECIAL_NAMES[sp] ?? formatDouble(x);
  }

  private setText(level: number): string {
    const n = Math.round(level);
    return this.reader.setTexts[n] ?? `?Str__${n}`;
  }

  private badUelNote(): string {
    return this.badUels > 0 ? `**** ${this.badUels} reference(s) to unique elements without a string representation` : '';
  }

  acronyms() {
    if (!this.reader.acronyms.length) return;
    this.out.push('\n');
    for (const a of this.reader.acronyms) {
      this.out.push(`Acronym ${a.name}${a.text ? explanatoryText(a.text, true) : ''};\n`);
    }
  }

  /** A symbol in the normal format (WriteSymbol, with header and data). */
  async symbol(e: SymbolEntry, signal?: AbortSignal) {
    const out = this.out;
    const { dim, dataType: type } = e;
    const isScalar = dim === 0 && type === 1;
    const count = dim === 0 ? 1 : e.count;
    let user = e.userInfo;
    let defaults = [0];
    let subtype = '';
    this.badUels = 0;
    if (type === 0) {
      if (user === 1) subtype = 'Singleton';
    } else if (type === 2) {
      if (user < 0 || user > 9) user = 5;
      defaults = VAR_DEFAULTS[user];
      if (user !== 0) subtype = VAR_TYPE_NAMES[user];
    } else if (type === 3) {
      // gdxdump compares the stored user info (53 + type) with the equation types: =E= defaults.
      if (user < 0 || user > 6) user = 0;
      defaults = EQU_DEFAULTS[user];
      if (user === 6) subtype = 'Logic';
    }
    out.push('\n');
    out.push(isScalar ? 'Scalar' : `${subtype ? `${subtype} ` : ''}${TYPE_NAMES[type] ?? 'Unknown'}`);
    if (type === 4) {
      out.push(` (${e.name}, ${user === 0 ? '*' : (this.reader.entries[user - 1]?.name ?? '*')});\n`);
    } else {
      out.push(` ${e.name}`);
      if (dim >= 1) {
        const names = Array.from({ length: dim }, (_, d) => {
          const nr = e.domainSymbols?.[d] ?? 0;
          return nr > 0 ? (this.reader.entries[nr - 1]?.name ?? '*') : '*';
        });
        out.push(`(${names.join(',')})`);
      }
      if (e.text) out.push(explanatoryText(e.text, dim === 0));
    }
    const comments = () => e.comments.forEach((c) => out.push(`* ${c}\n`));
    if (count === 0) {
      if (isScalar) {
        out.push(' / 0.0 /;\n');
        comments();
      } else if (type !== 4) {
        out.push(' / /;\n');
        comments();
      }
    } else {
      out.push(' /');
      if (dim > 0) out.push('\n');
      comments();
      const fields = type === 2 || type === 3 ? 5 : 1;
      const separator = type !== 2 && type !== 3 ? ', \n' : dim !== 0 ? ', \n' : ', ';
      let first = true;
      await this.reader.forEachRecord(
        e,
        (keys, _, values, special) => {
          for (let f = 0; f < fields; f++) {
            const raw = special[f] === Sp.None ? values[f] : special[f] === Sp.Text ? values[f] * 1e301 : RAW_SPECIAL[special[f] as Sp]!;
            // Fields with their default value are left out (FilterDef), except the bounds of equations.
            if (!isScalar && type !== 0 && raw === defaults[f] && (type !== 3 || (f !== 2 && f !== 3))) continue;
            if (first) first = false;
            else out.push(separator);
            let item = '';
            for (let d = 0; d < dim; d++) item += (d ? '.' : '') + this.quotedUel(keys[d]);
            if (type === 0) {
              if (special[0] === Sp.None && values[0] !== 0) item += elementText(this.setText(values[0]));
            } else if (type === 1) {
              item += ` ${this.value(values[f], special[f])}`;
            } else if (type === 2 || type === 3) {
              item += `${dim > 0 ? '.' : ''}${FIELD_NAMES[f]} ${this.value(values[f], special[f])}`;
            } else {
              item += 'Oops';
            }
            out.push(item);
          }
        },
        signal,
      );
      out.push(' /;\n');
    }
    out.push(this.badUelNote());
  }

  /** A symbol in CSV format with all fields and set texts (WriteSymbolCSV). */
  async csv(e: SymbolEntry, signal?: AbortSignal) {
    const out = this.out;
    const isSet = e.dataType === 0 || e.dataType === 4;
    const fields = e.dataType === 2 || e.dataType === 3 ? 5 : 1;
    this.badUels = 0;
    out.push(`${this.reader.header(e, isSet).map(csvField).join(',')}\n`);
    await this.reader.forEachRecord(
      e,
      (keys, _, values, special) => {
        const cells: string[] = [];
        for (let d = 0; d < e.dim; d++) cells.push(this.csvUel(keys[d]));
        if (isSet) {
          cells.push(special[0] === Sp.None && values[0] !== 0 ? csvField(this.setText(values[0])) : '');
        } else {
          for (let f = 0; f < fields; f++) cells.push(this.value(values[f], special[f]));
        }
        out.push(`${cells.join(',')}\n`);
      },
      signal,
    );
    out.push(this.badUelNote() && `${this.badUelNote()}\n`);
  }
}

/** The symbol of a name as gdxdump finds it (case-insensitive), or an error as gdxdump reports it. */
function symbolOf(reader: GdxReader, name: string): SymbolEntry {
  const e = reader.entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!e) throw new Error(`Symbol not found: ${name}`);
  return e;
}

/** The output of `gdxdump <file>` (all symbols) or `gdxdump <file> Symb=<symbol>`. */
export async function dumpText(reader: GdxReader, symbol?: string, signal?: AbortSignal): Promise<string> {
  const w = new Writer(reader);
  w.acronyms();
  if (symbol) {
    await w.symbol(symbolOf(reader, symbol), signal);
  } else {
    w.out.push('$onEmpty\n');
    for (const e of reader.entries) {
      await w.symbol(e, signal);
    }
    w.out.push('\n$offEmpty\n');
  }
  return w.out.join('');
}

/** The output of `gdxdump <file> Symb=<symbol> Format=csv CSVAllFields CSVSetText`. */
export async function symbolCsv(reader: GdxReader, symbol: string, signal?: AbortSignal): Promise<string> {
  const w = new Writer(reader);
  await w.csv(symbolOf(reader, symbol), signal);
  return w.out.join('');
}
