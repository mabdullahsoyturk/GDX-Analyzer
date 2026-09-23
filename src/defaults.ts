/**
 * Default values of variable and equation fields (as GAMS 55 stores them), used to
 * "squeeze" fields that have their default value in every record.
 *
 * gdxdump reports variable subtypes but not equation types, so the type of an
 * equation is inferred from the bounds of its records.
 */

const INF = '+Inf';
const MINF = '-Inf';

/** Lower and upper bound defaults by variable subtype. */
const VARIABLE_BOUNDS: Record<string, [string, string]> = {
  free: [MINF, INF],
  positive: ['0', INF],
  negative: [MINF, '0'],
  binary: ['0', '1'],
  integer: ['0', INF],
  sos1: ['0', INF],
  sos2: ['0', INF],
  semicont: ['1', INF],
  semiint: ['1', INF],
};

export type EquationType = 'E' | 'L' | 'G' | 'N';

const EQUATION_BOUNDS: Record<EquationType, [string, string]> = {
  E: ['0', '0'],
  L: [MINF, '0'],
  G: ['0', INF],
  N: [MINF, INF],
};

/** Compares two values as written by gdxdump (numbers numerically, special values by name). */
export function sameValue(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const x = Number(a);
  const y = Number(b);
  return a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/** Records as rows of strings, or an accessor of their cells (e.g. compact columns). */
export type Records = string[][] | { length: number; get(row: number, col: number): string };

function accessor(rows: Records): { length: number; get(row: number, col: number): string } {
  return Array.isArray(rows) ? { length: rows.length, get: (r, c) => rows[r][c] ?? '' } : rows;
}

/** The type of an equation if all records agree: =E= (lower = upper), =N=, =L= (no lower bound) or =G=. */
export function inferEquationType(records: Records, lower: number, upper: number): EquationType | undefined {
  let type: EquationType | undefined;
  const rows = accessor(records);
  for (let r = 0; r < rows.length; r++) {
    const lo = rows.get(r, lower);
    const up = rows.get(r, upper);
    const t: EquationType | undefined =
      lo === MINF && up === INF ? 'N' : sameValue(lo, up) ? 'E' : lo === MINF ? 'L' : up === INF ? 'G' : undefined;
    if (!t || (type && t !== type)) {
      return undefined;
    }
    type = t;
  }
  return type;
}

/**
 * Default value per column (undefined for keys, texts and fields without a known default)
 * of a variable (with its subtype) or an equation.
 */
export function fieldDefaults(symbolType: string, subtype: string | undefined, columns: string[], rows: Records): (string | undefined)[] {
  if (symbolType !== 'Var' && symbolType !== 'Equ') {
    return columns.map(() => undefined);
  }
  const lower = columns.indexOf('Lower');
  const upper = columns.indexOf('Upper');
  let bounds: [string, string] | undefined;
  if (symbolType === 'Var') {
    bounds = subtype ? VARIABLE_BOUNDS[subtype] : undefined;
  } else if (lower >= 0 && upper >= 0) {
    const t = inferEquationType(rows, lower, upper);
    bounds = t ? EQUATION_BOUNDS[t] : undefined;
  }
  return columns.map((c) => {
    switch (c) {
      case 'Level':
      case 'Marginal':
        return '0';
      case 'Scale':
        return '1';
      case 'Lower':
        return bounds?.[0];
      case 'Upper':
        return bounds?.[1];
      default:
        return undefined;
    }
  });
}
