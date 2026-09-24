/**
 * Answers the table queries and copy requests of the webviews (see media/table.js).
 * No dependency on `vscode`: tableHost.ts supplies the settings.
 */
import { NumberFormat, formatNumber, normalizeFormat } from './format';
import { TextSearch, compileSearch, isSearchError } from './search';
import { CellSelection, ChartData, ChartSpec, ColumnFilter, CopyResult, Hit, PivotPage, SelectionStats, SpecialValue, TablePage, TableView } from './table';

/** Table state sent by the webview with each query. */
export interface WebviewQuery {
  /** Text search; `filterRows` hides the rows without a match, otherwise matches are highlighted. */
  search?: TextSearch & { filterRows?: boolean };
  /** Show this match (index into all matches, wrapping around), changing pages as needed. */
  findIndex?: number;
  /** Older webviews: a text filter. */
  filter?: string;
  columnFilters?: ColumnFilter[];
  sortColumn?: number;
  sortDescending?: boolean;
  hidden?: number[];
  /** Column order of the list view. */
  order?: number[];
  page?: number;
  /** The first row (list) or pivot row (table view) to return, instead of `page` (continuous scrolling). */
  offset?: number;
  /** Echoed in the answer, so that the webview can drop answers to older queries. */
  seq?: number;
  view?: 'list' | 'table' | 'chart';
  /** Chart view: what the chart shows. */
  chart?: ChartSpec;
  rowDims?: number[];
  colDims?: number[];
  colPage?: number;
  /** Number format chosen for this symbol; the default applies if absent. */
  format?: Partial<NumberFormat>;
  /** Hide variable/equation fields that have their default value in every record; the default applies if absent. */
  squeeze?: boolean;
}

export interface QuerySettings {
  pageSize: number;
  colPageSize: number;
  defaultFormat: NumberFormat;
  /** Default of squeezing fields with default values only. */
  squeezeDefaults?: boolean;
}

/** Whether squeezing applies to the symbol and which columns it hides. */
export interface SqueezeInfo {
  available: boolean;
  active: boolean;
  columns: number[];
}

export interface SearchInfo {
  /** Number of matches in the whole view (highlight mode). */
  count: number;
  /** Matches on this page. */
  hits: Hit[];
  /** The match that was navigated to. */
  current?: { index: number; hit: Hit };
  error?: string;
}

/** Chart data with the values also formatted in the number format of the view (null: no value). */
export type ChartAnswer = ChartData & { series: (ChartData['series'][number] & { texts: (string | null)[] })[] };

export type QueryAnswer = (TablePage | PivotPage | ChartAnswer) & { format: NumberFormat; search?: SearchInfo; squeeze: SqueezeInfo; seq?: number };

export function isPivot(view: TableView, q: WebviewQuery): boolean {
  return q.view === 'table' && view.keyColumns.length > 0;
}

/** The row selection of a query: the search filters rows only in "filter rows" mode. */
function rowSelection(q: WebviewQuery): { filter?: string | TextSearch } {
  if (q.search?.text) {
    return { filter: q.search.filterRows ? q.search : undefined };
  }
  return { filter: q.filter };
}

function squeezeInfo(view: TableView, q: WebviewQuery, byDefault = false): SqueezeInfo {
  const available = !!view.table.defaults;
  const active = available && (q.squeeze ?? byDefault);
  return { available, active, columns: active ? view.squeezableColumns() : [] };
}

function effectiveFormat(q: WebviewQuery, defaults: NumberFormat): NumberFormat {
  return q.format ? normalizeFormat(q.format, defaults) : defaults;
}

/** A page of the list or table view; `format` is the number format in effect, `search` the matches. */
export function answerQuery(view: TableView, q: WebviewQuery, settings: QuerySettings): QueryAnswer {
  const format = effectiveFormat(q, settings.defaultFormat);
  if (q.view === 'chart') {
    // Charts follow the filters and the "filter rows" search; highlighted matches do not apply.
    const data = view.chart({ ...q, ...rowSelection(q), format });
    const series = data.series.map((s) => ({ ...s, texts: s.values.map((v) => (v === null ? null : formatNumber(String(v), format))) }));
    return { ...data, series, format, squeeze: squeezeInfo(view, q, settings.squeezeDefaults), seq: q.seq };
  }
  const pivot = isPivot(view, q);
  const rows = settings.pageSize;
  const cols = settings.colPageSize;
  const squeeze = squeezeInfo(view, q, settings.squeezeDefaults);
  const base = { ...q, ...rowSelection(q), format, squeeze: squeeze.active };
  let page = q.page;
  let offset = q.offset;
  let colPage = q.colPage;
  let search: SearchInfo | undefined;
  const run = () =>
    pivot ? view.pivot({ ...base, page, offset, colPage, pageSize: rows, colPageSize: cols }) : view.query({ ...base, page, offset, pageSize: rows });

  if (q.search?.text && !q.search.filterRows) {
    const found = pivot ? view.findPivot(base, q.search) : view.findList({ ...base, pageSize: rows }, q.search);
    search = { count: found.hits.length, hits: [], error: found.error };
    if (q.findIndex !== undefined && found.hits.length) {
      const n = found.hits.length;
      const index = ((q.findIndex % n) + n) % n;
      const hit = found.hits[index];
      if (hit.kind !== 'col') {
        if (offset !== undefined) {
          // A window of rows: keep it if it shows the match, else start a little above the match.
          if (hit.r < offset || hit.r >= offset + rows) offset = Math.max(0, hit.r - Math.floor(rows / 4));
        } else {
          page = Math.floor(hit.r / rows);
        }
      }
      if (pivot && hit.kind !== 'row') {
        colPage = Math.floor(hit.c / cols);
      }
      search.current = { index, hit };
    }
    const result = run();
    search.hits = found.hits.filter((h) => {
      const inRows = h.r >= result.offset && h.r < result.offset + result.rows.length;
      if (result.kind === 'list') {
        return inRows;
      }
      const inCols = h.c >= result.colOffset && h.c < result.colOffset + result.headers.length;
      return h.kind === 'row' ? inRows : h.kind === 'col' ? inCols : inRows && inCols;
    });
    return { ...result, format, search, squeeze, seq: q.seq };
  }
  if (q.search?.text) {
    // Filter mode: report an invalid regular expression (the rows are then not filtered).
    const rx = compileSearch(q.search);
    search = { count: 0, hits: [], error: isSearchError(rx) ? rx.error : undefined };
  }
  return { ...run(), format, search, squeeze, seq: q.seq };
}

/** A copy request of a webview: cells of the current view (positions as in its pages). */
export interface CopyRequest {
  type: 'copy';
  name: string;
  query: WebviewQuery;
  selection: CellSelection;
  separator: 'tab' | 'comma';
  /** Table view: with row labels and column headers. */
  labels: boolean;
}

/** Most cells copied at once (larger selections: use the Excel export or filter the records). */
export const MAX_COPY_CELLS = 5_000_000;

/** The text for a copy request, with exact values. */
export function copyText(
  view: TableView,
  req: CopyRequest,
  defaultFormat: NumberFormat,
  decimalSeparator: string,
  squeezeDefaults = false,
): CopyResult {
  // Rows are matched against the displayed values (as in the view); the copied values are exact.
  const squeeze = squeezeInfo(view, req.query, squeezeDefaults).active;
  const q = { ...req.query, ...rowSelection(req.query), format: effectiveFormat(req.query, defaultFormat), squeeze };
  const opts = {
    separator: req.separator === 'comma' ? (',' as const) : ('\t' as const),
    labels: req.labels,
    decimalSeparator,
    // The clipboard text of larger selections would need too much memory.
    limits: { maxCells: MAX_COPY_CELLS, what: 'The selection to copy' },
  };
  return isPivot(view, req.query) ? view.copyPivot(q, req.selection, opts) : view.copyList({ ...q, pageSize: 1 }, req.selection, opts);
}

/** The selection of a webview whose statistics are shown in the status bar. */
export interface SelectionRequest {
  type: 'selection';
  name: string;
  query: WebviewQuery;
  /** No selection: nothing is shown. */
  selection: CellSelection | null;
}

/** Statistics of the selected cells (exact values), and the number format of the view to show them in. */
export function selectionStats(view: TableView, req: SelectionRequest & { selection: CellSelection }, defaultFormat: NumberFormat, squeezeDefaults = false): ShownStats {
  // Rows are selected like for copying: the search matches the displayed values.
  const squeeze = squeezeInfo(view, req.query, squeezeDefaults).active;
  const format = effectiveFormat(req.query, defaultFormat);
  const q = { ...req.query, ...rowSelection(req.query), format, squeeze };
  const stats = isPivot(view, req.query) ? view.selectionStatsPivot(q, req.selection) : view.selectionStatsList({ ...q, pageSize: 1 }, req.selection);
  return { ...stats, format };
}

export type ShownStats = SelectionStats & { format: NumberFormat };

const SPECIAL_LABELS: Record<SpecialValue, string> = { eps: 'EPS', na: 'NA', pinf: '+INF', minf: '-INF', undf: 'UNDF' };

/** Status bar text and tooltip for the statistics of a selection; undefined for fewer than two cells. */
export function describeStats(s: ShownStats): { text: string; tooltip: string } | undefined {
  if (s.cells < 2) {
    return undefined;
  }
  const f = (x: number) => formatNumber(String(x), s.format);
  const count = (n: number) => n.toLocaleString();
  const specials = (Object.entries(s.specials) as [SpecialValue, number][]).map(([k, n]) => `${SPECIAL_LABELS[k]}: ${count(n)}`);
  const text = s.numbers ? `Sum: ${f(s.sum)}  Average: ${f(s.sum / s.numbers)}  Count: ${count(s.numbers)}` : `Count: ${count(s.numbers)}`;
  const lines = [
    `${count(s.cells)} cells selected`,
    `Numbers: ${count(s.numbers)}`,
    ...(s.numbers
      ? [`Sum: ${f(s.sum)}`, `Average: ${f(s.sum / s.numbers)}`, `Min: ${f(s.min!)}`, `Max: ${f(s.max!)}`]
      : []),
    ...(specials.length ? [`Special values (not counted as numbers): ${specials.join(', ')}`] : []),
    ...(s.texts ? [`Labels and texts: ${count(s.texts)}`] : []),
  ];
  return { text, tooltip: lines.join('\n') };
}
