/**
 * Host-side table model: rows stay in the extension host and the webview only
 * receives the page it displays, so symbols with millions of records stay usable.
 * Supports a text filter, column filters, sorting, hidden value columns and a
 * pivoted "table view" with some dimensions as rows and the others as columns.
 */
import { fieldDefaults, sameValue } from './defaults';
import { NumberFormat, formatNumber } from './format';
import type { SymbolData, SymbolDiff } from './parse';
import { TextSearch, compileSearch, isSearchError } from './search';

export type ColumnKind = 'key' | 'value' | 'text' | 'status';

export interface Column {
  name: string;
  kind: ColumnKind;
  /** For difference tables: which file the column's values come from. */
  side?: 1 | 2;
}

export interface Row {
  cells: string[];
  /** In pages: the exact values of the cells, if the number format changed any of them. */
  exact?: string[];
  /** Indexes of cells to highlight (e.g. values that differ). */
  marks?: number[];
  /** CSS class for the row (e.g. the diff status). */
  cls?: string;
}

export interface Table {
  columns: Column[];
  rows: Row[];
  /** Default value per column (variables and equations), for squeezing fields with default values only. */
  defaults?: (string | undefined)[];
  /** The Text column holds set element texts: an element without text is shown as "Y" (like GAMS Studio). */
  setTexts?: boolean;
}

export type SpecialValue = 'eps' | 'na' | 'pinf' | 'minf' | 'undf';

/** Shows only the rows whose cell in `column` is (or, with `exclude`, is not) one of `labels`. */
export interface LabelFilter {
  type: 'labels';
  column: number;
  labels: string[];
  exclude?: boolean;
}

/**
 * Shows only the rows whose value in `column` lies within [min, max] (or outside
 * of it, with `exclude`). Special values are shown unless listed in `hideSpecials`,
 * regardless of the range. Empty cells never lie within a range.
 */
export interface RangeFilter {
  type: 'range';
  column: number;
  min?: number;
  max?: number;
  exclude?: boolean;
  hideSpecials?: SpecialValue[];
}

export type ColumnFilter = LabelFilter | RangeFilter;

export interface RowSelection {
  /** Only rows with a cell matching this search (see search.ts); matched against the displayed values. */
  filter?: string | TextSearch;
  columnFilters?: ColumnFilter[];
  /** The number format of the view: searches match the values as displayed. */
  format?: NumberFormat;
}

/**
 * A search match. Cells: row and column position in the view (list: among the shown
 * columns; table view: pivot row and column). Table view labels: `kind: 'row'` with
 * `c` the row dimension, `kind: 'col'` with `r` the header level.
 */
export interface Hit {
  r: number;
  c: number;
  kind?: 'row' | 'col';
}

export interface FindResult {
  hits: Hit[];
  error?: string;
}

export interface TableQuery extends RowSelection {
  /** Order of the columns in the list view (column indexes; missing ones follow in their natural order). */
  order?: number[];
  /** Also hide value columns that have their default value in every record. */
  squeeze?: boolean;
  /** How numbers are shown; unformatted if absent. */
  format?: NumberFormat;
  sortColumn?: number;
  sortDescending?: boolean;
  /** Indexes of value/text columns that are not shown. */
  hidden?: number[];
  page?: number;
  pageSize: number;
}

interface Paging {
  /** Index of the first row of the page within all (filtered) rows. */
  offset: number;
  page: number;
  pageCount: number;
  /** Number of records matching the filters. */
  filteredCount: number;
  totalCount: number;
}

export interface TablePage extends Paging {
  kind: 'list';
  /** All columns of the table; `columnIndex` maps the shown cells to them. */
  allColumns: Column[];
  columnIndex: number[];
  rows: Row[];
}

export interface PivotQuery extends RowSelection {
  order?: number[];
  squeeze?: boolean;
  format?: NumberFormat;
  hidden?: number[];
  /** Key columns shown as row headers and as column headers (together: all key columns). */
  rowDims?: number[];
  colDims?: number[];
  page?: number;
  pageSize: number;
  colPage?: number;
  colPageSize: number;
}

export interface PivotPage extends Paging {
  kind: 'pivot';
  allColumns: Column[];
  rowDims: number[];
  colDims: number[];
  /** Value columns shown in the cells. */
  valueColumns: number[];
  /** Names of the column header levels: the column dimensions, then "Field" if there are several value columns. */
  levels: string[];
  /** Per shown column: its label at each level. */
  headers: string[][];
  /** Per shown column: the kind of its values. */
  cellKinds: ColumnKind[];
  rows: { labels: string[]; cells: string[]; exact?: string[] }[];
  /** Number of pivot rows (combinations of the row dimensions). */
  rowCount: number;
  colOffset: number;
  colPage: number;
  colPageCount: number;
  /** Number of pivot columns. */
  colCount: number;
}

export interface ColumnValues {
  column: number;
  values: string[];
  /** True if there were more distinct values than returned. */
  truncated: boolean;
}

/** Special values of GAMS as written by gdxdump. */
export function specialOf(v: string): SpecialValue | undefined {
  switch (v.toLowerCase()) {
    case 'eps':
      return 'eps';
    case 'na':
      return 'na';
    case '+inf':
    case 'inf':
      return 'pinf';
    case '-inf':
      return 'minf';
    case 'undf':
      return 'undf';
  }
  return undefined;
}

/** Order of GAMS special values relative to ordinary numbers. */
function numericKey(v: string): [number, number] {
  switch (specialOf(v)) {
    case 'minf':
      return [0, 0];
    case 'eps':
      return [1, 0];
    case 'pinf':
      return [2, 0];
    case 'na':
      return [3, 0];
    case 'undf':
      return [4, 0];
  }
  if (v === '') {
    return [5, 0];
  }
  const n = Number(v);
  return Number.isNaN(n) ? [6, 0] : [1, n];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareValues(a: string, b: string): number {
  const [ca, na] = numericKey(a);
  const [cb, nb] = numericKey(b);
  if (ca !== cb) {
    return ca - cb;
  }
  if (ca === 6) {
    return collator.compare(a, b);
  }
  return na - nb;
}

function rangeMatches(f: RangeFilter, v: string): boolean {
  const special = specialOf(v);
  if (special) {
    return !(f.hideSpecials ?? []).includes(special);
  }
  if (f.min === undefined && f.max === undefined) {
    return true;
  }
  const x = v === '' ? NaN : Number(v);
  if (Number.isNaN(x)) {
    return !!f.exclude;
  }
  const inside = (f.min === undefined || x >= f.min) && (f.max === undefined || x <= f.max);
  return f.exclude ? !inside : inside;
}

const MAX_COLUMN_VALUES = 100000;

export class TableView {
  private lastKey?: string;
  private lastIndex: number[] = [];
  private lastPivotKey?: string;
  private lastPivot?: PivotData;
  private readonly firstSeen = new Map<number, Map<string, number>>();
  private uelRank?: Map<string, number>;

  constructor(readonly table: Table) {}

  /** Orders labels like the GDX file does (its unique element list); otherwise by first appearance. */
  setUelOrder(uels: string[]) {
    this.uelRank = new Map(uels.map((u, i) => [u, i]));
    this.lastPivotKey = undefined;
  }

  get keyColumns(): number[] {
    return this.table.columns.flatMap((c, i) => (c.kind === 'key' ? [i] : []));
  }

  /** Ranks labels of a column for ordering: GDX order if known, else order of first appearance. */
  private rank(column: number): (label: string) => number {
    const uel = this.uelRank;
    if (uel && this.table.columns[column]?.kind === 'key') {
      return (l) => uel.get(l) ?? Number.MAX_SAFE_INTEGER;
    }
    let seen = this.firstSeen.get(column);
    if (!seen) {
      seen = new Map();
      for (const row of this.table.rows) {
        const v = row.cells[column] ?? '';
        if (!seen.has(v)) {
          seen.set(v, seen.size);
        }
      }
      this.firstSeen.set(column, seen);
    }
    const s = seen;
    return (l) => s.get(l) ?? Number.MAX_SAFE_INTEGER;
  }

  private matcher(selection: RowSelection): ((row: Row) => boolean) | undefined {
    const tests: ((row: Row) => boolean)[] = [];
    const n = this.table.columns.length;
    for (const f of selection.columnFilters ?? []) {
      if (f.column < 0 || f.column >= n) {
        continue; // e.g. a saved filter for a symbol whose dimension changed
      }
      if (f.type === 'labels') {
        const set = new Set(f.labels);
        tests.push(f.exclude ? (r) => !set.has(r.cells[f.column] ?? '') : (r) => set.has(r.cells[f.column] ?? ''));
      } else {
        tests.push((r) => rangeMatches(f, r.cells[f.column] ?? ''));
      }
    }
    const rx = compileSearch(selection.filter);
    if (rx instanceof RegExp) {
      const show = this.formatter(selection.format);
      tests.push((r) => r.cells.some((c, i) => rx.test(show(i, c))));
    }
    return tests.length ? (r) => tests.every((t) => t(r)) : undefined;
  }

  /** Indexes of the rows matching the filters, in display order (cached for paging). */
  private indexFor(q: RowSelection & { sortColumn?: number; sortDescending?: boolean }): number[] {
    const searching = compileSearch(q.filter) !== undefined;
    const key = JSON.stringify([q.filter ?? '', q.columnFilters ?? [], q.sortColumn, !!q.sortDescending, searching ? q.format : null]);
    if (key === this.lastKey) {
      return this.lastIndex;
    }
    const rows = this.table.rows;
    let index = rows.map((_, i) => i);
    const matches = this.matcher(q);
    if (matches) {
      index = index.filter((i) => matches(rows[i]));
    }
    const col = q.sortColumn;
    if (col !== undefined && col >= 0 && col < this.table.columns.length) {
      const kind = this.table.columns[col].kind;
      const cmp = kind === 'value' ? compareValues : (a: string, b: string) => collator.compare(a, b);
      const dir = q.sortDescending ? -1 : 1;
      // Stable sort keeps the original (GDX) order for equal values.
      index.sort((i, j) => dir * cmp(rows[i].cells[col] ?? '', rows[j].cells[col] ?? '') || i - j);
    }
    this.lastKey = key;
    this.lastIndex = index;
    return index;
  }

  private squeezeCache?: number[];

  /** Value columns whose value is the default in every record (none without known defaults). */
  squeezableColumns(): number[] {
    if (!this.squeezeCache) {
      const defaults = this.table.defaults ?? [];
      const rows = this.table.rows;
      this.squeezeCache = defaults.flatMap((d, i) => (d !== undefined && rows.every((r) => sameValue(r.cells[i] ?? '', d)) ? [i] : []));
    }
    return this.squeezeCache;
  }

  /** Columns that are shown: all key/status columns plus the value/text columns that are not hidden. */
  private visibleColumns(hidden: number[] = [], squeeze?: boolean, order?: number[]): number[] {
    const hide = new Set(squeeze ? [...hidden, ...this.squeezableColumns()] : hidden);
    const cols = this.orderedColumns(order);
    const visible = cols.filter((i) => this.table.columns[i].kind === 'key' || this.table.columns[i].kind === 'status' || !hide.has(i));
    // Never hide every value column.
    return visible.some((i) => this.isValueColumn(i)) ? visible : cols;
  }

  /** All column indexes in the given order; invalid entries are ignored, missing columns follow in their natural order. */
  orderedColumns(order?: number[]): number[] {
    const n = this.table.columns.length;
    const seen = new Set<number>();
    const result: number[] = [];
    for (const i of order ?? []) {
      if (Number.isInteger(i) && i >= 0 && i < n && !seen.has(i)) {
        seen.add(i);
        result.push(i);
      }
    }
    for (let i = 0; i < n; i++) {
      if (!seen.has(i)) {
        result.push(i);
      }
    }
    return result;
  }

  /** A cell as displayed without number format: set elements without text show "Y". */
  private textOf(column: number, v: string): string {
    return v === '' && this.table.setTexts && this.table.columns[column]?.kind === 'text' ? 'Y' : v;
  }

  private isValueColumn(i: number): boolean {
    const k = this.table.columns[i].kind;
    return k === 'value' || k === 'text';
  }

  query(q: TableQuery): TablePage {
    const index = this.indexFor(q);
    const pageSize = Math.max(1, q.pageSize);
    const pageCount = Math.max(1, Math.ceil(index.length / pageSize));
    const page = Math.min(Math.max(0, q.page ?? 0), pageCount - 1);
    const offset = page * pageSize;
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const show = this.formatter(q.format);
    const project = (r: Row): Row => {
      const marks = r.marks?.flatMap((m) => {
        const pos = columnIndex.indexOf(m);
        return pos >= 0 ? [pos] : [];
      });
      const exact = columnIndex.map((i) => r.cells[i] ?? '');
      const cells = columnIndex.map((i, k) => show(i, exact[k]));
      const row: Row = { cells, marks, cls: r.cls };
      // Exact values only matter for numbers the format changed.
      if (columnIndex.some((i, k) => this.table.columns[i].kind === 'value' && cells[k] !== exact[k])) {
        row.exact = exact;
      }
      return row;
    };
    return {
      kind: 'list',
      allColumns: this.table.columns,
      columnIndex,
      rows: index.slice(offset, offset + pageSize).map((i) => project(this.table.rows[i])),
      offset,
      page,
      pageCount,
      filteredCount: index.length,
      totalCount: this.table.rows.length,
    };
  }

  /** Formats the cells of value columns (numbers) with the given number format. */
  private formatter(format: NumberFormat | undefined): (column: number, value: string) => string {
    const numeric = this.table.columns.map((c) => c.kind === 'value');
    if (!format) {
      return (column, v) => (numeric[column] ? v : this.textOf(column, v));
    }
    return (column, v) => (numeric[column] ? formatNumber(v, format) : this.textOf(column, v));
  }

  /** Distinct values of a column over all rows, in GDX order for key columns and in order of appearance otherwise. */
  columnValues(column: number): ColumnValues {
    const rank = this.rank(column);
    const seen = new Set<string>();
    for (const row of this.table.rows) {
      seen.add(row.cells[column] ?? '');
    }
    const values = [...seen].sort((a, b) => rank(a) - rank(b));
    return { column, values: values.slice(0, MAX_COLUMN_VALUES), truncated: values.length > MAX_COLUMN_VALUES };
  }

  /** Validated row/column dimensions: by default the last key column is shown as columns. */
  pivotDims(rowDims?: number[], colDims?: number[]): { rowDims: number[]; colDims: number[] } {
    const keys = this.keyColumns;
    const given = [...(rowDims ?? []), ...(colDims ?? [])];
    const valid = given.length === keys.length && keys.every((k) => given.includes(k));
    if (valid) {
      return { rowDims: [...(rowDims ?? [])], colDims: [...(colDims ?? [])] };
    }
    return { rowDims: keys.slice(0, -1), colDims: keys.slice(-1) };
  }

  private pivotData(q: PivotQuery): PivotData {
    const { rowDims, colDims } = this.pivotDims(q.rowDims, q.colDims);
    const valueColumns = this.visibleColumns(q.hidden, q.squeeze, q.order).filter((i) => this.isValueColumn(i));
    const key = JSON.stringify([q.filter ?? '', q.columnFilters ?? [], rowDims, colDims, valueColumns, !!this.uelRank, compileSearch(q.filter) ? q.format : null]);
    if (key === this.lastPivotKey && this.lastPivot) {
      return this.lastPivot;
    }
    const rows = this.table.rows;
    const index = this.indexFor({ filter: q.filter, columnFilters: q.columnFilters, format: q.format });
    const rowCombos = new Map<string, { labels: string[]; cells: Map<string, number> }>();
    const colCombos = new Map<string, string[]>();
    for (const i of index) {
      const cells = rows[i].cells;
      const rLabels = rowDims.map((d) => cells[d] ?? '');
      const cLabels = colDims.map((d) => cells[d] ?? '');
      const rKey = rLabels.join('\u0000');
      const cKey = cLabels.join('\u0000');
      let r = rowCombos.get(rKey);
      if (!r) {
        r = { labels: rLabels, cells: new Map() };
        rowCombos.set(rKey, r);
      }
      r.cells.set(cKey, i);
      if (!colCombos.has(cKey)) {
        colCombos.set(cKey, cLabels);
      }
    }
    const byRank = (dims: number[]) => {
      const ranks = dims.map((d) => this.rank(d));
      return (a: string[], b: string[]) => {
        for (let k = 0; k < dims.length; k++) {
          const d = ranks[k](a[k]) - ranks[k](b[k]);
          if (d !== 0) {
            return d;
          }
        }
        return 0;
      };
    };
    const sortedRows = [...rowCombos.values()].sort((a, b) => byRank(rowDims)(a.labels, b.labels));
    const colCmp = byRank(colDims);
    const sortedCols = [...colCombos.entries()].sort((a, b) => colCmp(a[1], b[1]));
    // With several value columns (variables, equations) or no column dimension, the fields form the last level.
    const fieldLevel = this.table.columns.filter((_, i) => this.isValueColumn(i)).length > 1 || colDims.length === 0;
    const columns: { key: string; labels: string[]; value: number }[] = [];
    for (const [cKey, labels] of sortedCols) {
      for (const v of valueColumns) {
        columns.push({ key: cKey, labels: fieldLevel ? [...labels, this.table.columns[v].name] : labels, value: v });
      }
    }
    const levels = [...colDims.map((d) => this.table.columns[d].name), ...(fieldLevel ? ['Field'] : [])];
    this.lastPivotKey = key;
    const columnPos = new Map(columns.map((c, i) => [c.key + '\u0001' + c.value, i]));
    this.lastPivot = { rowDims, colDims, valueColumns, levels, fieldLevel, rows: sortedRows, columns, columnPos, filteredCount: index.length };
    return this.lastPivot;
  }

  pivot(q: PivotQuery): PivotPage {
    const p = this.pivotData(q);
    const show = this.formatter(q.format);
    const pageSize = Math.max(1, q.pageSize);
    const pageCount = Math.max(1, Math.ceil(p.rows.length / pageSize));
    const page = Math.min(Math.max(0, q.page ?? 0), pageCount - 1);
    const offset = page * pageSize;
    const colPageSize = Math.max(1, q.colPageSize);
    const colPageCount = Math.max(1, Math.ceil(p.columns.length / colPageSize));
    const colPage = Math.min(Math.max(0, q.colPage ?? 0), colPageCount - 1);
    const colOffset = colPage * colPageSize;
    const cols = p.columns.slice(colOffset, colOffset + colPageSize);
    return {
      kind: 'pivot',
      allColumns: this.table.columns,
      rowDims: p.rowDims,
      colDims: p.colDims,
      valueColumns: p.valueColumns,
      levels: p.levels,
      headers: cols.map((c) => c.labels),
      cellKinds: cols.map((c) => this.table.columns[c.value].kind),
      rows: p.rows.slice(offset, offset + pageSize).map((r) => {
        const exact = cols.map((c) => this.cell(r.cells, c));
        // An empty cell is a missing record (cell() already shows set elements without text as Y).
        const cells = cols.map((c, k) => (exact[k] === '' ? '' : show(c.value, exact[k])));
        return cells.some((c, k) => c !== exact[k]) ? { labels: r.labels, cells, exact } : { labels: r.labels, cells };
      }),
      offset,
      page,
      pageCount,
      filteredCount: p.filteredCount,
      totalCount: this.table.rows.length,
      rowCount: p.rows.length,
      colOffset,
      colPage,
      colPageCount,
      colCount: p.columns.length,
    };
  }

  private cell(cells: Map<string, number>, c: { key: string; value: number }): string {
    const i = cells.get(c.key);
    if (i === undefined) {
      return '';
    }
    // Like GAMS Studio: a set element without explanatory text is shown as "Y".
    return this.textOf(c.value, this.table.rows[i].cells[c.value] ?? '');
  }

  private lastFindKey?: string;
  private lastFind?: FindResult;

  private cachedFind(key: string, compute: () => FindResult): FindResult {
    if (key !== this.lastFindKey || !this.lastFind) {
      this.lastFind = compute();
      this.lastFindKey = key;
    }
    return this.lastFind;
  }

  /** All cells of the list view matching `search`, row by row (displayed values). */
  findList(q: TableQuery, search: TextSearch): FindResult {
    const rx = compileSearch(search);
    if (!rx) {
      return { hits: [] };
    }
    if (isSearchError(rx)) {
      return { hits: [], error: rx.error };
    }
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const index = this.indexFor(q);
    const key = JSON.stringify(['list', search, q.filter ?? '', q.columnFilters ?? [], q.sortColumn, !!q.sortDescending, columnIndex, q.format ?? null]);
    return this.cachedFind(key, () => {
      const show = this.formatter(q.format);
      const hits: Hit[] = [];
      index.forEach((ri, r) => {
        const cells = this.table.rows[ri].cells;
        columnIndex.forEach((ci, c) => {
          if (rx.test(show(ci, cells[ci] ?? ''))) {
            hits.push({ r, c });
          }
        });
      });
      return { hits };
    });
  }

  /**
   * All matches of the table view: column header labels first (except the field names),
   * then row by row the row labels and the cells. Labels repeated in merged headers count once.
   */
  findPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, search: TextSearch): FindResult {
    const rx = compileSearch(search);
    if (!rx) {
      return { hits: [] };
    }
    if (isSearchError(rx)) {
      return { hits: [], error: rx.error };
    }
    const p = this.pivotData({ ...q, pageSize: 1, colPageSize: 1 });
    const key = JSON.stringify(['pivot', search, q.filter ?? '', q.columnFilters ?? [], p.rowDims, p.colDims, p.valueColumns, !!this.uelRank, q.format ?? null]);
    return this.cachedFind(key, () => {
      const show = this.formatter(q.format);
      const hits: Hit[] = [];
      const labelLevels = p.fieldLevel ? p.levels.length - 1 : p.levels.length;
      for (let level = 0; level < labelLevels; level++) {
        const prefix = (c: number) => p.columns[c].labels.slice(0, level + 1).join('\u0000');
        p.columns.forEach((col, c) => {
          if ((c === 0 || prefix(c) !== prefix(c - 1)) && rx.test(col.labels[level] ?? '')) {
            hits.push({ r: level, c, kind: 'col' });
          }
        });
      }
      p.rows.forEach((row, r) => {
        const prev = r > 0 ? p.rows[r - 1] : undefined;
        let same = !!prev;
        row.labels.forEach((l, k) => {
          same = same && prev!.labels[k] === l;
          if (!same && rx.test(l)) {
            hits.push({ r, c: k, kind: 'row' });
          }
        });
        const cols: number[] = [];
        for (const colKey of row.cells.keys()) {
          for (const v of p.valueColumns) {
            const c = p.columnPos.get(colKey + '\u0001' + v);
            const value = c !== undefined ? this.cell(row.cells, p.columns[c]) : '';
            if (c !== undefined && value !== '' && rx.test(show(v, value))) {
              cols.push(c);
            }
          }
        }
        cols.sort((a, b) => a - b).forEach((c) => hits.push({ r, c }));
      });
      return { hits };
    });
  }

  /**
   * The selected cells of the list view: rows are positions in the filtered and sorted
   * rows, columns are positions among the shown columns. With `all`, every row and
   * column, headed by the column names. Set elements without text are shown as "Y" unless `displayTexts` is false.
   */
  gridList(q: TableQuery, sel: CellSelection, displayTexts = true): Grid {
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const index = this.indexFor(q);
    const [r0, r1] = sel.all ? [0, index.length - 1] : clampRange(sel.rows, index.length);
    const [c0, c1] = sel.all ? [0, columnIndex.length - 1] : clampRange(sel.cols, columnIndex.length);
    const cols = columnIndex.slice(c0, c1 + 1);
    const rows: GridCell[][] = [];
    if (sel.all) {
      rows.push(cols.map((c) => ({ v: this.table.columns[c].name, header: true })));
    }
    for (let r = r0; r <= r1; r++) {
      const cells = this.table.rows[index[r]].cells;
      rows.push(cols.map((c) => ({ v: displayTexts ? this.textOf(c, cells[c] ?? '') : (cells[c] ?? ''), value: this.table.columns[c].kind === 'value' })));
    }
    return { rows, headerRows: sel.all ? 1 : 0, headerCols: 0, cells: Math.max(0, r1 - r0 + 1) * cols.length };
  }

  /**
   * The selected cells of the table view: rows and columns are positions in the pivot
   * table. With `labels`, the row labels and column headers of the selection are
   * included (and the names of the dimensions in the corner).
   */
  gridPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, sel: CellSelection, labels: boolean): Grid {
    const p = this.pivotData({ ...q, pageSize: 1, colPageSize: 1 });
    const [r0, r1] = sel.all ? [0, p.rows.length - 1] : clampRange(sel.rows, p.rows.length);
    const [c0, c1] = sel.all ? [0, p.columns.length - 1] : clampRange(sel.cols, p.columns.length);
    const cols = p.columns.slice(c0, c1 + 1);
    const rows: GridCell[][] = [];
    if (labels) {
      p.levels.forEach((name, level) => {
        // Like the view: row dimension names on the last header row, the level's name above them.
        const last = level === p.levels.length - 1;
        const corner = p.rowDims.map((d, k) => (last ? this.table.columns[d].name : k === p.rowDims.length - 1 ? name : ''));
        rows.push([...corner, ...cols.map((c) => c.labels[level] ?? '')].map((v) => ({ v, header: true })));
      });
    }
    for (let r = r0; r <= r1; r++) {
      const row = p.rows[r];
      const cells = cols.map((c) => ({ v: this.cell(row.cells, c), value: this.table.columns[c.value].kind === 'value' }));
      rows.push(labels ? [...row.labels.map((v) => ({ v, header: true })), ...cells] : cells);
    }
    return { rows, headerRows: labels ? p.levels.length : 0, headerCols: labels ? p.rowDims.length : 0, cells: Math.max(0, r1 - r0 + 1) * cols.length };
  }

  /** The selected cells of the list view as text (see gridList). */
  copyList(q: TableQuery, sel: CellSelection, opts: CopyOptions): CopyResult {
    return gridText(this.gridList(q, sel), opts);
  }

  /** The selected cells of the table view as text (see gridPivot). */
  copyPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, sel: CellSelection, opts: CopyOptions): CopyResult {
    return gridText(this.gridPivot(q, sel, opts.labels), opts);
  }

  /** All filtered rows as tab separated text, headed by the column names. */
  toTsv(q: TableQuery): string {
    return this.copyList(q, { all: true }, { separator: '\t', labels: true }).text;
  }

  /** The complete pivot table as tab separated text. */
  pivotTsv(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>): string {
    return this.copyPivot(q, { all: true }, { separator: '\t', labels: true }).text;
  }
}

/** A rectangle of cells (inclusive ranges), or everything. */
export interface CellSelection {
  all?: boolean;
  rows?: [number, number];
  cols?: [number, number];
}

export interface CopyOptions {
  separator: '\t' | ',';
  /** Table view: include row labels and column headers. */
  labels: boolean;
  /** Replaces the decimal point of numbers (default "."). */
  decimalSeparator?: string;
}

export interface CopyResult {
  text: string;
  cells: number;
}

/** A cell of a grid: its value as written by gdxdump; `value` for numbers, `header` for labels and names. */
export interface GridCell {
  v: string;
  value?: boolean;
  header?: boolean;
}

/** The cells of (a part of) a view, with the number of header rows and label columns. */
export interface Grid {
  rows: GridCell[][];
  headerRows: number;
  headerCols: number;
  /** Number of data cells. */
  cells: number;
}

/** A grid as tab or comma separated text. */
export function gridText(grid: Grid, opts: CopyOptions): CopyResult {
  const out = new CopyWriter(opts);
  for (const row of grid.rows) {
    out.line(row.map((c) => (c.value ? out.value(c.v, 'value') : c.v)));
  }
  return out.result(grid.cells);
}

function clampRange(range: [number, number] | undefined, n: number): [number, number] {
  if (!range || n === 0) {
    return [0, -1];
  }
  const a = Math.max(0, Math.min(range[0], range[1]));
  const b = Math.min(n - 1, Math.max(range[0], range[1]));
  return [a, b];
}

/** Builds tab or comma separated text: quotes fields for CSV, adjusts decimal separators. */
class CopyWriter {
  private readonly lines: string[] = [];
  constructor(private readonly opts: CopyOptions) {}

  value(v: string, kind: ColumnKind): string {
    const dec = this.opts.decimalSeparator;
    return dec && dec !== '.' && kind === 'value' && /^[-+]?(\d|\.\d)/.test(v) ? v.replace('.', dec) : v;
  }

  private field(v: string): string {
    if (this.opts.separator === '\t') {
      return v.replace(/[\t\r\n]+/g, ' ');
    }
    return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  }

  line(fields: string[]) {
    this.lines.push(fields.map((f) => this.field(f)).join(this.opts.separator));
  }

  result(cells: number): CopyResult {
    return { text: this.lines.length ? this.lines.join('\n') + '\n' : '', cells };
  }
}

interface PivotData {
  rowDims: number[];
  colDims: number[];
  valueColumns: number[];
  levels: string[];
  /** True if the last level holds the field names (Level, Marginal, ...). */
  fieldLevel: boolean;
  rows: { labels: string[]; cells: Map<string, number> }[];
  columns: { key: string; labels: string[]; value: number }[];
  /** Column position by column key and value column. */
  columnPos: Map<string, number>;
  filteredCount: number;
}

/**
 * Table for the records of one symbol as dumped by gdxdump. With the symbol's type (and
 * subtype), the default values of variable and equation fields are known.
 */
export function symbolTable(data: SymbolData, symbol?: { type: string; subtype?: string }): Table {
  return {
    columns: data.columns.map((name, i) => ({
      name,
      kind: i < data.keyCount ? 'key' : name === 'Text' ? 'text' : 'value',
    })),
    rows: data.rows.map((cells) => ({ cells })),
    defaults: symbol && (symbol.type === 'Var' || symbol.type === 'Equ') ? fieldDefaults(symbol.type, symbol.subtype, data.columns, data.rows) : undefined,
    // Only sets (and aliases) have a Text column.
    setTexts: data.columns.includes('Text'),
  };
}

const STATUS_LABEL = { changed: 'changed', only1: 'only in file 1', only2: 'only in file 2' } as const;

function delta(a: string | undefined, b: string | undefined): string {
  const x = Number(a);
  const y = Number(b);
  if (a === undefined || b === undefined || a === '' || b === '' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return '';
  }
  // Exact; the number format of the view decides how many digits are shown.
  return String(y - x);
}

/**
 * Table for one symbol of a gdxdiff result: the keys, the status and, per value
 * column that differs, the values of both files (plus their difference for numbers).
 */
export function diffTable(diff: SymbolDiff): Table {
  const shown = diff.valueColumns
    .map((name, i) => ({ name, i }))
    .filter(
      ({ i }) =>
        i === 0 ||
        diff.records.some((r) => r.status === 'changed' && (r.values1?.[i] ?? '') !== (r.values2?.[i] ?? '')),
    );
  const columns: Column[] = [
    ...diff.keyColumns.map((name): Column => ({ name, kind: 'key' })),
    { name: 'Status', kind: 'status' },
  ];
  for (const { name } of shown) {
    const kind = name === 'Text' ? 'text' : 'value';
    columns.push({ name: `${name} (file 1)`, kind, side: 1 }, { name: `${name} (file 2)`, kind, side: 2 });
    if (kind === 'value') {
      columns.push({ name: `Δ ${name}`, kind: 'value' });
    }
  }
  const rows = diff.records.map((r): Row => {
    const cells = [...r.keys, STATUS_LABEL[r.status]];
    const marks: number[] = [];
    for (const { name, i } of shown) {
      const v1 = r.values1?.[i];
      const v2 = r.values2?.[i];
      if (r.status === 'changed' && (v1 ?? '') !== (v2 ?? '')) {
        marks.push(cells.length, cells.length + 1);
      }
      cells.push(v1 ?? '', v2 ?? '');
      if (name !== 'Text') {
        cells.push(r.status === 'changed' ? delta(v1, v2) : '');
      }
    }
    return { cells, marks, cls: `st-${r.status}` };
  });
  return { columns, rows };
}
