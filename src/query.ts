/**
 * Answers the table queries and copy requests of the webviews (see media/table.js).
 * No dependency on `vscode`: tableHost.ts supplies the settings.
 */
import { NumberFormat, normalizeFormat } from './format';
import { TextSearch, compileSearch, isSearchError } from './search';
import { CellSelection, ColumnFilter, CopyResult, Hit, PivotPage, TablePage, TableView } from './table';

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
  view?: 'list' | 'table';
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

export type QueryAnswer = (TablePage | PivotPage) & { format: NumberFormat; search?: SearchInfo; squeeze: SqueezeInfo };

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
  const pivot = isPivot(view, q);
  const rows = settings.pageSize;
  const cols = settings.colPageSize;
  const squeeze = squeezeInfo(view, q, settings.squeezeDefaults);
  const base = { ...q, ...rowSelection(q), format, squeeze: squeeze.active };
  let page = q.page;
  let colPage = q.colPage;
  let search: SearchInfo | undefined;
  const run = () =>
    pivot ? view.pivot({ ...base, page, colPage, pageSize: rows, colPageSize: cols }) : view.query({ ...base, page, pageSize: rows });

  if (q.search?.text && !q.search.filterRows) {
    const found = pivot ? view.findPivot(base, q.search) : view.findList({ ...base, pageSize: rows }, q.search);
    search = { count: found.hits.length, hits: [], error: found.error };
    if (q.findIndex !== undefined && found.hits.length) {
      const n = found.hits.length;
      const index = ((q.findIndex % n) + n) % n;
      const hit = found.hits[index];
      if (hit.kind !== 'col') {
        page = Math.floor(hit.r / rows);
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
    return { ...result, format, search, squeeze };
  }
  if (q.search?.text) {
    // Filter mode: report an invalid regular expression (the rows are then not filtered).
    const rx = compileSearch(q.search);
    search = { count: 0, hits: [], error: isSearchError(rx) ? rx.error : undefined };
  }
  return { ...run(), format, search, squeeze };
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
  const opts = { separator: req.separator === 'comma' ? (',' as const) : ('\t' as const), labels: req.labels, decimalSeparator };
  return isPivot(view, req.query) ? view.copyPivot(q, req.selection, opts) : view.copyList({ ...q, pageSize: 1 }, req.selection, opts);
}
