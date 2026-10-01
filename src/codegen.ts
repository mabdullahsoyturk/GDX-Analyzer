/**
 * "Copy as Code": Python code that reads a symbol of a GDX file with GAMS Transfer or
 * GAMSPy into a pandas DataFrame and applies the view of the viewer to it: the column
 * filters, the solution status, sorting, the shown fields and the table view (pivot_table,
 * with aggregation and totals). What pandas cannot do like the viewer is noted as a comment.
 *
 * No dependency on `vscode`.
 */
import type { SymbolViewState } from './export';
import type { GdxSymbol } from './parse';
import { Aggregate, BOUND_TOLERANCE, ColumnFilter, SpecialValue, TableView } from './table';

export type CodeLanguage = 'transfer' | 'gamspy';

export interface CodeRequest {
  language: CodeLanguage;
  file: string;
  symbol: GdxSymbol;
  view: TableView;
  /** The view of the symbol; without it, the code only reads the records. */
  state?: SymbolViewState;
  /** Setting gdxAnalyzer.squeezeDefaults: the default of the view's "squeeze defaults". */
  squeezeDefaults?: boolean;
}

/** The record columns of GAMS Transfer (and GAMSPy) by the viewer's column names. */
const FIELD_COLUMNS: Record<string, string> = {
  Value: 'value',
  Level: 'level',
  Marginal: 'marginal',
  Lower: 'lower',
  Upper: 'upper',
  Scale: 'scale',
  Text: 'element_text',
};

const SPECIAL_TESTS: Record<SpecialValue, string> = { eps: 'isEps', na: 'isNA', undf: 'isUndef', pinf: 'isPosInf', minf: 'isNegInf' };

const PANDAS_AGGREGATE: Record<Aggregate, string> = { sum: 'sum', mean: 'mean', min: 'min', max: 'max', count: 'count' };

/** Names that the code uses itself, and Python keywords: a symbol variable with such a name gets a "_". */
const RESERVED = new Set(
  'm df v table np gt gp sv lo up l mg tol False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '),
);

/** The columns of the records' dimensions, like GAMS Transfer's domain_labels: if a name repeats, all get their position. */
export function domainLabels(domain: string[]): string[] {
  const base = domain.map((d) => (d === '*' ? 'uni' : d));
  return new Set(base).size < base.length ? base.map((b, k) => `${b}_${k}`) : base;
}

/** A Python string literal (raw for Windows paths). */
function py(s: string): string {
  return /^[^"\n]*$/.test(s) && !s.endsWith('\\') && s.includes('\\') ? `r"${s}"` : JSON.stringify(s);
}

const list = (items: string[]) => `[${items.map(py).join(', ')}]`;

/** A number as Python writes it (finite numbers from the viewer's filters). */
const num = (x: number) => (Number.isInteger(x) && Math.abs(x) < 1e15 ? String(x) : String(x).replace('e+', 'e'));

export function symbolCode(req: CodeRequest): string {
  const { symbol, view, state } = req;
  const columns = view.table.columns;
  const keys = view.keyColumns;
  const labels = domainLabels(symbol.domain.length === keys.length ? symbol.domain : keys.map((k) => columns[k].name));
  /** The record column of a viewer column. */
  const col = (c: number): string | undefined => (columns[c]?.kind === 'key' ? labels[keys.indexOf(c)] : FIELD_COLUMNS[columns[c]?.name]);
  const name = RESERVED.has(symbol.name) ? `${symbol.name}_` : symbol.name;
  const transfer = req.language === 'transfer';
  const lib = transfer ? 'gt' : 'gp';
  const lines: string[] = [];
  const notes: string[] = [];
  let numpy = false;
  let specials = false;

  // Filters.
  const body: string[] = [];
  for (const f of state?.columnFilters ?? []) {
    const c = col(f.column);
    if (!c) continue;
    body.push(...filterCode(f, c, columns[f.column].name, () => (specials = true)));
  }
  if (state?.solution && view.solutionFilters().some((s) => s.filter === state.solution)) {
    const code = solutionCode(state.solution);
    if (code) {
      body.push(...code);
      numpy = numpy || state.solution !== 'marginal';
      specials = specials || state.solution === 'marginal';
    } else {
      notes.push(`The solution filter "${state.solution}" is not translated.`);
    }
  }
  if (state?.search?.text && state.search.filterRows) {
    notes.push(`The text search ${JSON.stringify(state.search.text)} is not translated.`);
  }
  const pivot = state?.view === 'table' && keys.length >= 2;
  // Sorting (the table view has the order of the labels).
  if (!pivot && state?.sortColumn !== undefined && col(state.sortColumn)) {
    const c = col(state.sortColumn)!;
    const numbers = columns[state.sortColumn].kind === 'value';
    const how = state.sortAbsolute && numbers ? 'by magnitude' : state.sortDescending ? 'descending' : 'ascending';
    body.push(`# Sorted by ${columns[state.sortColumn].name} (${how}${numbers ? '' : ', alphabetically'})`);
    const key = state.sortAbsolute && numbers ? ', key=lambda s: s.abs()' : numbers ? '' : ', key=lambda s: s.astype(str)';
    // Stable: equal values keep the order of the file, as in the viewer.
    body.push(`df = df.sort_values(${py(c)}${key}, ascending=${state.sortDescending ? 'False' : 'True'}, kind="stable")`);
  }
  // The shown value columns (fields), in the order shown.
  const page = view.query({ hidden: state?.hidden, squeeze: state?.squeeze ?? req.squeezeDefaults, order: state?.order, pageSize: 1 });
  const shown = page.columnIndex;
  const shownValues = shown.filter((c) => columns[c].kind === 'value' || columns[c].kind === 'text');
  const allColumns = columns.map((_, i) => i);
  if (!pivot && shown.join(',') !== allColumns.join(',')) {
    const names = shown.map(col).filter((c): c is string => !!c);
    body.push('# The columns shown', `df = df[${list(names)}]`);
  }
  // The table view.
  let result = 'df';
  if (pivot) {
    const dims = view.pivotDims(state?.rowDims, state?.colDims, state?.aggDims);
    const aggregate = state?.aggregate ?? 'sum';
    const values = shownValues.map(col).filter((c): c is string => !!c);
    const aggregated = dims.aggDims.length > 0;
    const fn = aggregated || state?.totals ? PANDAS_AGGREGATE[aggregate] : 'first';
    const rows = dims.rowDims.map((d) => labels[keys.indexOf(d)]);
    const cols = dims.colDims.map((d) => labels[keys.indexOf(d)]);
    const valuesArg = values.length === 1 ? py(values[0]) : list(values);
    const what = [rows.length ? `${rows.join(', ')} as rows` : '', cols.length ? `${cols.join(', ')} as columns` : '', aggregated ? `${aggregate} over ${dims.aggDims.map((d) => labels[keys.indexOf(d)]).join(', ')}` : '']
      .filter(Boolean)
      .join(', ');
    body.push(`# The table view: ${what}${state?.totals ? ', with totals' : ''}`);
    if (rows.length || cols.length) {
      const args = [rows.length ? `index=${list(rows)}` : '', cols.length ? `columns=${list(cols)}` : '', `values=${valuesArg}`, `aggfunc=${py(fn)}`, 'observed=True'];
      if (state?.totals) args.push('margins=True', `margins_name=${py(aggregate.charAt(0).toUpperCase() + aggregate.slice(1))}`);
      body.push(`table = df.pivot_table(${args.filter(Boolean).join(', ')})`);
    } else {
      body.push(`table = df[${valuesArg}].agg(${py(fn)})`);
    }
    if (aggregated) notes.push('pandas skips NA and UNDF when aggregating (the viewer shows them as the result).');
    if ((aggregated || state?.totals) && aggregate === 'sum' && values.some((v) => v === 'lower' || v === 'upper' || v === 'scale')) {
      notes.push('pandas also sums the bounds and scale (the viewer leaves them empty).');
    }
    result = 'table';
  }

  // Header: imports and reading the symbol.
  lines.push(transfer ? 'import gams.transfer as gt' : 'import gamspy as gp');
  if (numpy) lines.splice(0, 0, 'import numpy as np');
  lines.push('');
  lines.push(`m = ${lib}.Container()`);
  lines.push(transfer ? `m.read(${py(req.file)}, symbols=[${py(symbol.name)}])` : `m.read(${py(req.file)}, symbol_names=[${py(symbol.name)}])`);
  lines.push(`${name} = m[${py(symbol.name)}]`);
  lines.push(`df = ${name}.records`);
  if (specials) lines.push(`sv = ${lib}.SpecialValues`);
  if (body.length) lines.push('', ...body);
  if (notes.length) lines.push('', ...notes.map((n) => `# Note: ${n}`));
  lines.push('', `print(${result})`);
  return lines.join('\n') + '\n';
}

/** A column filter as pandas code: label filters with isin, ranges with the viewer's special values. */
function filterCode(f: ColumnFilter, c: string, shownName: string, useSpecials: () => void): string[] {
  if (f.type === 'labels') {
    const labels = f.ignoreCase ? f.labels.map((l) => l.toLowerCase()) : f.labels;
    const column = f.ignoreCase ? `df[${py(c)}].str.lower()` : `df[${py(c)}]`;
    return [`# ${shownName} ${f.exclude ? 'not ' : ''}in ${labels.length} label${labels.length === 1 ? '' : 's'}`, `df = df[${f.exclude ? '~' : ''}${column}.isin(${list(labels)})]`];
  }
  const parts: string[] = [];
  if (f.min !== undefined && f.max !== undefined) parts.push(`v.between(${num(f.min)}, ${num(f.max)})`);
  else if (f.min !== undefined) parts.push(`(v >= ${num(f.min)})`);
  else if (f.max !== undefined) parts.push(`(v <= ${num(f.max)})`);
  let range = parts[0];
  if (range && f.exclude) range = `~${range}`;
  const hidden = new Set(f.hideSpecials ?? []);
  const all = Object.keys(SPECIAL_TESTS) as SpecialValue[];
  // Like the viewer: special values are kept regardless of the range, unless they are hidden.
  const kept = range ? all.filter((s) => !hidden.has(s)).map((s) => `sv.${SPECIAL_TESTS[s]}(v)`) : [];
  const keep = range ? (kept.length ? `(${[range, ...kept].join(' | ')})` : range) : '';
  const drop = all.filter((s) => hidden.has(s)).map((s) => `~sv.${SPECIAL_TESTS[s]}(v)`);
  const mask = [keep, ...drop].filter(Boolean).join(' & ');
  if (!mask) return [];
  useSpecials();
  const what = [f.min !== undefined || f.max !== undefined ? `${f.exclude ? 'outside' : 'within'} [${f.min ?? '-inf'}, ${f.max ?? 'inf'}]` : '', hidden.size ? `without ${[...hidden].join(', ')}` : '']
    .filter(Boolean)
    .join(', ');
  return [`# ${shownName} ${what}`, `v = df[${py(c)}]`, `df = df[${mask}]`];
}

/** The solution filters as pandas code (bounds with the viewer's tolerance); undefined if not translated. */
function solutionCode(filter: string): string[] | undefined {
  const tol = String(BOUND_TOLERANCE);
  switch (filter) {
    case 'marginal':
      return ['# Solution status: non-zero marginal (or EPS)', 'mg = df["marginal"]', 'df = df[((mg != 0) & mg.notna()) | sv.isEps(mg)]'];
    case 'atLower':
    case 'atUpper': {
      const b = filter === 'atLower' ? 'lower' : 'upper';
      return [
        `# Solution status: level at its finite ${b} bound (tolerance ${tol}, relative above 1)`,
        `l, b = df["level"], df["${b}"]`,
        `df = df[np.isfinite(b) & ((l - b).abs() <= ${tol} * np.maximum(1, b.abs()))]`,
      ];
    }
    case 'infeasible':
      return [
        `# Solution status: level outside its bounds (tolerance ${tol}, relative above 1)`,
        'l, lo, up = df["level"], df["lower"], df["upper"]',
        `tol = lambda b: np.where(np.isfinite(b), ${tol} * np.maximum(1, b.abs()), 0)`,
        'df = df[(l < lo - tol(lo)) | (l > up + tol(up))]',
      ];
  }
  return undefined;
}
