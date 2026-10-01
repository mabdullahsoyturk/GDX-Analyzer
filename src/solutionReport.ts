/**
 * The solution report of a GDX file: the solution status of all its variables and equations
 * at once (records outside their bounds, binding constraints, levels at their bounds), for the
 * viewer and the MCP tool gdx_solution_report.
 *
 * No dependency on `vscode`.
 */
import { numberText } from './columns';
import { NumberFormat, formatNumber } from './format';
import { GdxSource, loadSymbolColumns } from './gdxFile';
import type { GdxSymbol } from './parse';
import { SolutionFilter, SolutionRecord, TableView, columnTable } from './table';

/** Most records of each list of the report (the records outside their bounds and the binding constraints). */
export const MAX_REPORT_RECORDS = 1000;

/** The solution status of one variable or equation. */
export interface SymbolSolution {
  name: string;
  type: 'Var' | 'Equ';
  subtype?: string;
  dim: number;
  domain: string[];
  text: string;
  records: number;
  /** The number of records of each solution filter that applies. */
  counts: Partial<Record<SolutionFilter, number>>;
  /** How far the record farthest outside its bounds is outside them. */
  maxInfeasibility?: number;
  /** The largest |marginal| (EPS: 0) of the records with a non-zero or EPS marginal. */
  maxMarginal?: number;
  /** The column of the Marginal field in the viewer's table of the symbol. */
  marginalColumn?: number;
  /** Why the records could not be read. */
  error?: string;
}

export interface ReportRecord extends SolutionRecord {
  symbol: string;
  type: 'Var' | 'Equ';
}

export interface SolutionReport {
  /** The variables and equations in the order of the file. */
  symbols: SymbolSolution[];
  /** The records outside their bounds (variables and equations), farthest outside first. */
  infeasible: ReportRecord[];
  infeasibleCount: number;
  /** The equation records with a non-zero or EPS marginal, largest |marginal| first. */
  binding: ReportRecord[];
  bindingCount: number;
  /** The most records of each list. */
  top: number;
}

export function isSolutionSymbol(s: GdxSymbol): s is GdxSymbol & { type: 'Var' | 'Equ' } {
  return s.type === 'Var' || s.type === 'Equ';
}

/** Collects the solution summaries of the symbols into a report. */
export class SolutionReportBuilder {
  private readonly symbols = new Map<GdxSymbol, SymbolSolution>();
  private infeasible: ReportRecord[] = [];
  private binding: ReportRecord[] = [];
  private infeasibleCount = 0;
  private bindingCount = 0;
  private readonly rank: Map<string, number>;

  constructor(
    private readonly order: GdxSymbol[],
    readonly top: number,
  ) {
    this.rank = new Map(order.map((s, i) => [s.name, i]));
  }

  /** Larger amounts first; of equal amounts, the symbols in the order of the file. */
  private readonly compare = (a: ReportRecord, b: ReportRecord) => b.amount - a.amount || (this.rank.get(a.symbol) ?? 0) - (this.rank.get(b.symbol) ?? 0);

  private base(s: GdxSymbol & { type: 'Var' | 'Equ' }): SymbolSolution {
    return { name: s.name, type: s.type, subtype: s.subtype, dim: s.dim, domain: s.domain, text: s.text, records: s.records, counts: {} };
  }

  /** Adds a symbol from the view of its records (a symbol without records needs none). */
  add(symbol: GdxSymbol & { type: 'Var' | 'Equ' }, view?: TableView) {
    const result = this.base(symbol);
    this.symbols.set(symbol, result);
    const summary = view?.solutionSummary(this.top);
    if (!summary) {
      return;
    }
    result.counts = Object.fromEntries(summary.counts.map((c) => [c.filter, c.count]));
    result.marginalColumn = summary.marginalColumn;
    result.maxInfeasibility = summary.infeasible[0]?.amount;
    const tag = (r: SolutionRecord): ReportRecord => ({ ...r, symbol: symbol.name, type: symbol.type });
    this.infeasibleCount += result.counts.infeasible ?? 0;
    this.infeasible = this.merge(this.infeasible, summary.infeasible.map(tag));
    // Marginals of variables are reduced costs, of equations shadow prices: only equations are binding constraints.
    result.maxMarginal = summary.marginals[0]?.amount;
    if (symbol.type === 'Equ') {
      this.bindingCount += result.counts.marginal ?? 0;
      this.binding = this.merge(this.binding, summary.marginals.map(tag));
    }
  }

  fail(symbol: GdxSymbol & { type: 'Var' | 'Equ' }, message: string) {
    this.symbols.set(symbol, { ...this.base(symbol), error: message });
  }

  /** The `top` first records of two lists sorted by `compare` (`b`: the records of one symbol, not in `a`). */
  private merge(a: ReportRecord[], b: ReportRecord[]): ReportRecord[] {
    const result: ReportRecord[] = [];
    let i = 0;
    let j = 0;
    while (result.length < this.top && (i < a.length || j < b.length)) {
      result.push(j >= b.length || (i < a.length && this.compare(a[i], b[j]) <= 0) ? a[i++] : b[j++]);
    }
    return result;
  }

  result(): SolutionReport {
    return {
      symbols: this.order.flatMap((s) => this.symbols.get(s) ?? []),
      infeasible: this.infeasible,
      infeasibleCount: this.infeasibleCount,
      binding: this.binding,
      bindingCount: this.bindingCount,
      top: this.top,
    };
  }
}


export interface ReportOptions {
  /** The most records of each list (default and at most MAX_REPORT_RECORDS). */
  top?: number;
  signal?: AbortSignal;
  /** Symbols read at once (default 4). */
  concurrency?: number;
  /** Called after each symbol. */
  onProgress?: (done: number, total: number) => void;
  /** The view of a symbol's records if it is already in memory (otherwise they are read with gdxdump). */
  cached?: (symbol: GdxSymbol) => Promise<TableView> | undefined;
}

/**
 * The solution report of the variables and equations among `symbols` of a GDX file. The records
 * of each symbol are read and summarized one after another (a few at once), and not kept.
 */
export async function solutionReport(source: GdxSource, file: string, symbols: GdxSymbol[], options: ReportOptions = {}): Promise<SolutionReport> {
  const top = Math.min(MAX_REPORT_RECORDS, Math.max(1, Math.floor(options.top ?? MAX_REPORT_RECORDS)));
  // In the order of the file (gdxdump lists the symbols by name).
  const candidates = symbols.filter(isSolutionSymbol).sort((a, b) => (a.entry ?? 0) - (b.entry ?? 0));
  const builder = new SolutionReportBuilder(candidates, top);
  const read = (symbol: GdxSymbol) =>
    options.cached?.(symbol) ??
    loadSymbolColumns(source, file, symbol, options.signal).then((data) => new TableView(columnTable(data.columns, data.keyCount, data.store, symbol)));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const symbol = candidates[next++];
      if (symbol.records === 0) {
        builder.add(symbol);
      } else {
        try {
          builder.add(symbol, await read(symbol));
        } catch (err) {
          if (options.signal?.aborted) throw err;
          builder.fail(symbol, err instanceof Error ? err.message : String(err));
        }
      }
      options.onProgress?.(++done, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  options.signal?.throwIfAborted();
  return builder.result();
}

/** A record like GAMS writes it, e.g. x(seattle,'new york'); labels with blanks, commas, quotes etc. are quoted. */
export function recordName(symbol: string, keys: string[]): string {
  if (!keys.length) {
    return symbol;
  }
  const label = (k: string) => (/^[A-Za-z0-9_+-]+$/.test(k) ? k : k.includes("'") ? `"${k}"` : `'${k}'`);
  return `${symbol}(${keys.map(label).join(',')})`;
}

/** A report record for the viewer: its name and the fields as shown (`exact`: as stored). */
export interface ShownRecord {
  symbol: string;
  type: 'Var' | 'Equ';
  record: string;
  /** Level, marginal, lower and upper bound, and the amount (infeasibility or |marginal|). */
  cells: string[];
  exact: string[];
}

/** A variable or equation for the viewer, with its largest infeasibility and |marginal| as shown and exactly. */
export type ShownSymbol = SymbolSolution & { shown: { maxInfeasibility: [string, string]; maxMarginal: [string, string] } };

export type ShownReport = Omit<SolutionReport, 'symbols' | 'infeasible' | 'binding'> & { symbols: ShownSymbol[]; infeasible: ShownRecord[]; binding: ShownRecord[]; format: NumberFormat };

/** The report with the numbers in the number format of the viewer (as text: ±Infinity does not survive the webview messages). */
export function showReport(report: SolutionReport, format: NumberFormat): ShownReport {
  const show = (r: ReportRecord): ShownRecord => {
    const exact = [r.level, r.marginal, r.lower, r.upper, amountText(r.amount)];
    return { symbol: r.symbol, type: r.type, record: recordName(r.symbol, r.keys), exact, cells: exact.map((v) => formatNumber(v, format)) };
  };
  const amount = (x: number | undefined): [string, string] => (x === undefined ? ['', ''] : [formatNumber(amountText(x), format), amountText(x)]);
  return {
    ...report,
    symbols: report.symbols.map((s) => ({ ...s, shown: { maxInfeasibility: amount(s.maxInfeasibility), maxMarginal: amount(s.maxMarginal) } })),
    infeasible: report.infeasible.map(show),
    binding: report.binding.map(show),
    format,
  };
}

/** An amount as gdxdump writes numbers (+Inf for a level at -INF below a finite bound, and the like). */
export function amountText(x: number): string {
  return x === Infinity ? '+Inf' : x === -Infinity ? '-Inf' : numberText(x);
}
