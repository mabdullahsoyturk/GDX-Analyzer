/**
 * Number formats of the GDX viewer, following GAMS Studio:
 *
 * - g: fixed notation for numbers of moderate size, scientific notation otherwise;
 *      `precision` significant digits (1-17), or "full" for the fewest digits that
 *      reproduce the stored value exactly.
 * - f: fixed notation with `precision` decimals (0-14); scientific for very large numbers.
 * - e: scientific notation with `precision` significant digits (1-17) or "full".
 *
 * Special values (Eps, NA, +Inf, -Inf, Undf) and non-numeric cells are left unchanged.
 */

export type NumberStyle = 'g' | 'f' | 'e';

export interface NumberFormat {
  style: NumberStyle;
  precision: number | 'full';
  /** Remove trailing zeros after the decimal point (always done with "full"). */
  squeeze: boolean;
}

export const DEFAULT_FORMAT: NumberFormat = { style: 'g', precision: 6, squeeze: true };

/** Beyond this magnitude, f-format switches to scientific notation. */
const FIXED_LIMIT = 1e15;

/** Validates a format, e.g. one sent by the webview or read from the settings. */
export function normalizeFormat(f: Partial<NumberFormat> | undefined, fallback: NumberFormat = DEFAULT_FORMAT): NumberFormat {
  const style: NumberStyle = f?.style === 'f' || f?.style === 'e' || f?.style === 'g' ? f.style : fallback.style;
  let precision: number | 'full' = f?.precision === 'full' || typeof f?.precision === 'number' ? f.precision : fallback.precision;
  if (style === 'f') {
    precision = precision === 'full' ? 6 : clamp(precision, 0, 14);
  } else if (precision !== 'full') {
    precision = clamp(precision, 1, 17);
  }
  return { style, precision, squeeze: typeof f?.squeeze === 'boolean' ? f.squeeze : fallback.squeeze };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
}

/** Number of significant digits of the shortest representation that round-trips. */
function shortestDigits(x: number): number {
  const mantissa = x.toExponential().split('e')[0];
  return mantissa.replace(/^-/, '').replace('.', '').length;
}

function stripZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Scientific notation like GAMS: 1.5E+20, 3E-07. */
function scientific(x: number, decimals: number, squeeze: boolean): string {
  const [m, e] = x.toExponential(decimals).split('e');
  const exp = Number(e);
  const mantissa = squeeze ? stripZeros(m) : m;
  return `${mantissa}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/** Avoids "-0" and "-0.00" after rounding. */
function noNegativeZero(s: string): string {
  return /^-0(\.0*)?(E[+-]\d+)?$/.test(s) ? s.slice(1) : s;
}

export function formatNumber(value: string, f: NumberFormat): string {
  if (value === '' || !/^[-+]?(\d|\.\d)/.test(value)) {
    return value; // special value, text or empty
  }
  const x = Number(value);
  if (!Number.isFinite(x)) {
    return value;
  }
  const full = f.precision === 'full';
  let s: string;
  if (f.style === 'f') {
    const decimals = full ? 6 : (f.precision as number);
    s = Math.abs(x) >= FIXED_LIMIT ? scientific(x, shortestDigits(x) - 1, true) : x.toFixed(decimals);
    if (f.squeeze) {
      s = stripZeros(s);
    }
  } else if (f.style === 'e') {
    s = scientific(x, full ? shortestDigits(x) - 1 : (f.precision as number) - 1, full || f.squeeze);
  } else if (full) {
    const digits = shortestDigits(x);
    const exp = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)));
    // Fixed notation while the shortest digits fit into a double's ~15-16 significant digits.
    s = exp < -4 || exp >= 15 ? scientific(x, digits - 1, true) : stripZeros(x.toFixed(Math.max(0, digits - 1 - exp)));
  } else {
    // Like C's %g.
    const p = f.precision as number;
    const exp = x === 0 ? 0 : Number(x.toExponential(p - 1).split('e')[1]);
    s = exp < -4 || exp >= p ? scientific(x, p - 1, f.squeeze) : x.toFixed(Math.max(0, p - 1 - exp));
    if (f.squeeze && !s.includes('E')) {
      s = stripZeros(s);
    }
  }
  return noNegativeZero(s);
}

/**
 * Decodes a value written by gdxdump with dFormat=hexBytes (the IEEE 754 bits, e.g.
 * 0x4049000000000000) into the shortest decimal string that round-trips. Other
 * values (special values like Eps or NA) are returned unchanged.
 */
export function decodeHexBytes(value: string): string {
  const m = /^0x([0-9a-f]{16})$/i.exec(value);
  if (!m) {
    return value;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt('0x' + m[1]));
  const x = view.getFloat64(0);
  return Object.is(x, -0) ? '0' : String(x);
}
