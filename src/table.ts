/**
 * Host-side table model: rows stay in the extension host and the webview only
 * receives the page it displays, so symbols with millions of records stay usable
 * (labels are compared by index and numbers as numbers, not as text).
 * Supports a text filter, column filters, sorting, hidden value columns and a
 * pivoted "table view" with some dimensions as rows and the others as columns.
 */
import { ColumnStore, ColumnStoreBuilder, LabelColumn, Labels, NumberColumn, Sp, StoredColumn, specialCode } from './columns';
import { fieldDefaults } from './defaults';
import { NumberFormat, formatNumber } from './format';
import type { GdxSymbol, SymbolColumns, SymbolData, SymbolDiff } from './parse';
import { TextSearch, canMatchNumbers, compileSearch, isSearchError } from './search';

export type ColumnKind = 'key' | 'value' | 'text' | 'status';

export interface Column {
  name: string;
  kind: ColumnKind;
  /** For difference tables: which file the column's values come from. */
  side?: 1 | 2;
  /** For difference tables: the column holds differences (file 2 − file 1). */
  delta?: boolean;
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

/**
 * The cells of a table: rows of strings (small tables such as differences) or, for
 * symbols with many records, compact columns (see columns.ts).
 */
export interface Table {
  columns: Column[];
  rows?: Row[];
  store?: ColumnStore;
  /** Default value per column (variables and equations), for squeezing fields with default values only. */
  defaults?: (string | undefined)[];
  /** The Text column holds set element texts: an element without text is shown as "Y" (like GAMS Studio). */
  setTexts?: boolean;
  /** With a store: the cells to highlight and the CSS class of a row (like Row.marks and Row.cls). */
  rowMarks?: (row: number) => number[] | undefined;
  rowClass?: (row: number) => string | undefined;
}

export type SpecialValue = 'eps' | 'na' | 'pinf' | 'minf' | 'undf';

/** Shows only the rows whose cell in `column` is (or, with `exclude`, is not) one of `labels`. */
export interface LabelFilter {
  type: 'labels';
  column: number;
  labels: string[];
  exclude?: boolean;
  /** Compare the labels case-insensitively (as GAMS does). */
  ignoreCase?: boolean;
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
  /** The first row to return (instead of `page`), e.g. for a window of a continuously scrolled view. */
  offset?: number;
  pageSize: number;
}

/** The first row of a window: `offset` if given, else the start of `page`; clamped to the rows. */
function windowStart(q: { page?: number; offset?: number }, pageSize: number, rowCount: number): number {
  const last = Math.max(0, rowCount - 1);
  if (q.offset !== undefined && Number.isFinite(q.offset)) return Math.min(Math.max(0, Math.floor(q.offset)), last);
  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
  return Math.min(Math.max(0, q.page ?? 0), pageCount - 1) * pageSize;
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
  /** The first pivot row to return (instead of `page`). */
  offset?: number;
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

/** Statistics of one column over the rows of a selection (see TableView.stats). */
export interface ColumnStats {
  column: number;
  name: string;
  kind: ColumnKind;
  /** Key, text and status columns: the number of distinct labels, and the first ones (in order of appearance). */
  distinct?: number;
  labels?: string[];
  /** Value columns: the numbers (without special values). */
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  zeros?: number;
  /** Value columns: the number of each special value (only those that occur). */
  specials?: Partial<Record<'Eps' | 'NA' | '+Inf' | '-Inf' | 'Undf' | 'empty' | 'text', number>>;
}

export type ChartType = 'bar' | 'line' | 'heatmap';

/** What a chart shows: labels of `x` along the category axis, one series per label of `series`, the numbers of `value`. */
export interface ChartSpec {
  type?: ChartType;
  x?: number;
  /**
   * A key column other than `x`: one series per label; -1 for a single series; FIELD_SERIES
   * for one series per column of `fields` (e.g. the values of both files of a comparison).
   */
  series?: number;
  value?: number;
  /** With series FIELD_SERIES: the value columns shown as series. */
  fields?: number[];
}

/** ChartSpec.series: the value columns of ChartSpec.fields are the series. */
export const FIELD_SERIES = -2;

export interface ChartQuery extends RowSelection {
  chart?: ChartSpec;
}

/** Most categories of a bar or line chart and most rows/columns of a heatmap. */
export const MAX_CHART_CATEGORIES = 500;
/** Most series of a bar or line chart (the categorical palette); the others are summed as "Other". */
export const MAX_CHART_SERIES = 8;

export interface ChartData extends Paging {
  kind: 'chart';
  allColumns: Column[];
  /** The spec in effect (validated, with defaults). */
  chart: Required<ChartSpec>;
  /** A single series of differences: bars are colored by their sign. */
  signColors: boolean;
  /** Category labels (GDX order). */
  categories: string[];
  /** Per series: its name, its palette slot (-1 for "Other") and a value per category (null: no number). */
  series: { name: string; slot: number; values: (number | null)[] }[];
  /** Key columns whose labels are summed (not on an axis). */
  summed: number[];
  /** Categories (and heatmap rows) left out beyond MAX_CHART_CATEGORIES. */
  omittedCategories: number;
  omittedSeries: number;
  /** Values that are not charted: NA, +Inf, -Inf and Undf. */
  skipped: Partial<Record<SpecialValue, number>>;
  /** Number of Eps values (charted as 0). */
  eps: number;
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

const MAX_COLUMN_VALUES = 100000;

/** Special values of RangeFilter.hideSpecials by code. */
const HIDE_CODE: Record<SpecialValue, Sp> = { eps: Sp.Eps, na: Sp.NA, pinf: Sp.PInf, minf: Sp.MInf, undf: Sp.Undf };

/**
 * Uniform access to the cells of a table (compact columns of a symbol, or rows of
 * strings), with per-column label indexes and numbers computed once when needed.
 */
class Cells {
  readonly length: number;
  private readonly store?: ColumnStore;
  private readonly rows: Row[];
  private readonly table: Table;
  private readonly labelCols: ({ ids: Int32Array; labels: string[] } | undefined)[] = [];
  private readonly numberCols: ({ values: Float64Array; special: Uint8Array } | undefined)[] = [];

  constructor(table: Table) {
    this.table = table;
    this.store = table.store;
    this.rows = table.rows ?? [];
    this.length = this.store ? this.store.length : this.rows.length;
  }

  get(r: number, c: number): string {
    return this.store ? this.store.get(r, c) : (this.rows[r].cells[c] ?? '');
  }

  /** The label index of every row, and the labels (interned in order of appearance). */
  labels(c: number): { ids: Int32Array; labels: string[] } {
    let col = this.labelCols[c];
    if (!col) {
      const stored = this.store?.columns[c];
      if (stored?.type === 'label') {
        col = { ids: stored.ids, labels: stored.labels.list };
      } else {
        const labels = new Labels();
        const ids = new Int32Array(this.length);
        for (let r = 0; r < this.length; r++) {
          ids[r] = labels.intern(this.get(r, c));
        }
        col = { ids, labels: labels.list };
      }
      this.labelCols[c] = col;
    }
    return col;
  }

  /** The number and special value code of every row. */
  numbers(c: number): { values: Float64Array; special: Uint8Array } {
    let col = this.numberCols[c];
    if (!col) {
      const stored = this.store?.columns[c];
      if (stored?.type === 'number') {
        col = { values: stored.values, special: stored.special };
      } else {
        const values = new Float64Array(this.length);
        const special = new Uint8Array(this.length);
        for (let r = 0; r < this.length; r++) {
          const v = this.get(r, c);
          const sp = specialCode(v);
          if (sp !== Sp.None) {
            special[r] = sp;
          } else {
            const x = Number(v);
            if (Number.isNaN(x)) {
              special[r] = Sp.Text;
            } else {
              values[r] = x;
            }
          }
        }
        col = { values, special };
      }
      this.numberCols[c] = col;
    }
    return col;
  }

  marks(r: number): number[] | undefined {
    return this.table.rowMarks ? this.table.rowMarks(r) : this.rows[r]?.marks;
  }

  cls(r: number): string | undefined {
    return this.table.rowClass ? this.table.rowClass(r) : this.rows[r]?.cls;
  }
}

/** Sort categories: -Inf, numbers (with Eps as 0), +Inf, NA, Undf, empty, text. */
const SORT_CATEGORY: Record<number, number> = { [Sp.MInf]: 0, [Sp.None]: 1, [Sp.Eps]: 1, [Sp.PInf]: 2, [Sp.NA]: 3, [Sp.Undf]: 4, [Sp.Empty]: 5, [Sp.Text]: 6 };

export class TableView {
  private lastKey?: string;
  private lastIndex: Int32Array = new Int32Array(0);
  private lastPivotKey?: string;
  private lastPivot?: PivotData;
  private readonly firstSeen = new Map<number, Int32Array>();
  private readonly collation = new Map<number, Int32Array>();
  private uelRank?: Map<string, number>;
  private readonly uelRanks = new Map<number, Int32Array>();
  private readonly cells: Cells;

  constructor(readonly table: Table) {
    this.cells = new Cells(table);
  }

  /** Number of records. */
  get length(): number {
    return this.cells.length;
  }

  /** Orders labels like the GDX file does (its unique element list); otherwise by first appearance. */
  setUelOrder(uels: string[]) {
    this.uelRank = new Map(uels.map((u, i) => [u, i]));
    this.uelRanks.clear();
    this.lastPivotKey = undefined;
  }

  get keyColumns(): number[] {
    return this.table.columns.flatMap((c, i) => (c.kind === 'key' ? [i] : []));
  }

  /** Rank of each label index of a column: GDX order for key columns if known, else order of first appearance. */
  private ranks(column: number): Int32Array {
    const { ids, labels } = this.cells.labels(column);
    const uel = this.uelRank;
    if (uel && this.table.columns[column]?.kind === 'key') {
      let r = this.uelRanks.get(column);
      if (!r) {
        r = new Int32Array(labels.length);
        labels.forEach((l, id) => (r![id] = uel.get(l) ?? 0x7fffffff));
        this.uelRanks.set(column, r);
      }
      return r;
    }
    let seen = this.firstSeen.get(column);
    if (!seen) {
      seen = new Int32Array(labels.length).fill(-1);
      let next = 0;
      for (let i = 0; i < ids.length; i++) {
        if (seen[ids[i]] < 0) {
          seen[ids[i]] = next++;
        }
      }
      this.firstSeen.set(column, seen);
    }
    return seen;
  }

  /** Rank of each label index of a column in alphabetical (natural) order. */
  private collationRanks(column: number): Int32Array {
    let r = this.collation.get(column);
    if (!r) {
      const { labels } = this.cells.labels(column);
      const order = labels.map((_, i) => i).sort((a, b) => collator.compare(labels[a], labels[b]));
      r = new Int32Array(labels.length);
      order.forEach((id, k) => (r![id] = k));
      this.collation.set(column, r);
    }
    return r;
  }

  private isLabelColumn(c: number): boolean {
    return this.table.columns[c]?.kind !== 'value';
  }

  /** A row test for the filters and the text search (undefined: all rows match). */
  private matcher(selection: RowSelection): ((row: number) => boolean) | undefined {
    const tests: ((row: number) => boolean)[] = [];
    const n = this.table.columns.length;
    for (const f of selection.columnFilters ?? []) {
      if (f.column < 0 || f.column >= n) {
        continue; // e.g. a saved filter for a symbol whose dimension changed
      }
      if (f.type === 'labels') {
        const { ids, labels } = this.cells.labels(f.column);
        const fold = f.ignoreCase ? (l: string) => l.toLowerCase() : (l: string) => l;
        const set = new Set(f.labels.map(fold));
        const ok = new Uint8Array(labels.length);
        labels.forEach((l, id) => (ok[id] = set.has(fold(l)) !== !!f.exclude ? 1 : 0));
        tests.push((r) => ok[ids[r]] === 1);
      } else {
        const { values, special } = this.cells.numbers(f.column);
        const hidden = new Set((f.hideSpecials ?? []).map((s) => HIDE_CODE[s]));
        const ranged = f.min !== undefined || f.max !== undefined;
        const lo = f.min ?? -Infinity;
        const hi = f.max ?? Infinity;
        const exclude = !!f.exclude;
        tests.push((r) => {
          const sp = special[r];
          if (sp !== Sp.None && sp !== Sp.Empty && sp !== Sp.Text) {
            return !hidden.has(sp);
          }
          if (!ranged) {
            return true;
          }
          if (sp !== Sp.None) {
            return exclude; // empty cells never lie within a range
          }
          const x = values[r];
          const inside = x >= lo && x <= hi;
          return exclude ? !inside : inside;
        });
      }
    }
    const rx = compileSearch(selection.filter);
    if (rx instanceof RegExp) {
      const show = this.formatter(selection.format);
      const numbers = canMatchNumbers(selection.filter);
      // Label columns: each distinct label is tested once; value columns only if the search can match a number.
      const perColumn = this.table.columns.flatMap((_, c) => {
        if (this.isLabelColumn(c)) {
          const { ids, labels } = this.cells.labels(c);
          const hit = new Uint8Array(labels.length);
          labels.forEach((l, id) => (hit[id] = rx.test(this.textOf(c, l)) ? 1 : 0));
          return [(r: number) => hit[ids[r]] === 1];
        }
        return numbers ? [(r: number) => rx.test(show(c, this.cells.get(r, c)))] : [];
      });
      tests.push((r) => perColumn.some((t) => t(r)));
    }
    if (!tests.length) {
      return undefined;
    }
    return tests.length === 1 ? tests[0] : (r) => tests.every((t) => t(r));
  }

  /** Indexes of the rows matching the filters, in display order (cached for paging). */
  private indexFor(q: RowSelection & { sortColumn?: number; sortDescending?: boolean }): Int32Array {
    const searching = compileSearch(q.filter) !== undefined;
    const key = JSON.stringify([q.filter ?? '', q.columnFilters ?? [], q.sortColumn, !!q.sortDescending, searching ? q.format : null]);
    if (key === this.lastKey) {
      return this.lastIndex;
    }
    const n = this.cells.length;
    let index: Int32Array;
    const matches = this.matcher(q);
    if (matches) {
      const all = new Int32Array(n);
      let m = 0;
      for (let r = 0; r < n; r++) {
        if (matches(r)) all[m++] = r;
      }
      index = all.slice(0, m);
    } else {
      index = new Int32Array(n);
      for (let r = 0; r < n; r++) index[r] = r;
    }
    const col = q.sortColumn;
    if (col !== undefined && col >= 0 && col < this.table.columns.length) {
      const dir = q.sortDescending ? -1 : 1;
      if (this.table.columns[col].kind === 'value') {
        const { values, special } = this.cells.numbers(col);
        const cat = new Uint8Array(n);
        const key = new Float64Array(n);
        for (let r = 0; r < n; r++) {
          const sp = special[r];
          cat[r] = SORT_CATEGORY[sp];
          key[r] = sp === Sp.None ? values[r] : 0;
        }
        const text = (r: number) => this.cells.get(r, col);
        // Stable: equal values keep the original (GDX) order.
        index.sort((a, b) => {
          const d = cat[a] - cat[b] || key[a] - key[b] || (cat[a] === 6 ? collator.compare(text(a), text(b)) : 0);
          return dir * d || a - b;
        });
      } else {
        const { ids } = this.cells.labels(col);
        const rank = this.collationRanks(col);
        index.sort((a, b) => dir * (rank[ids[a]] - rank[ids[b]]) || a - b);
      }
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
      const n = this.cells.length;
      this.squeezeCache = defaults.flatMap((d, c) => {
        if (d === undefined) {
          return [];
        }
        const sp = specialCode(d);
        const x = Number(d);
        const { values, special } = this.cells.numbers(c);
        for (let r = 0; r < n; r++) {
          if (special[r] !== sp || (sp === Sp.None && values[r] !== x)) {
            return [];
          }
        }
        return [c];
      });
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
    const offset = windowStart(q, pageSize, index.length);
    const page = Math.floor(offset / pageSize);
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const show = this.formatter(q.format);
    const project = (r: number): Row => {
      const marks = this.cells.marks(r)?.flatMap((m) => {
        const pos = columnIndex.indexOf(m);
        return pos >= 0 ? [pos] : [];
      });
      const exact = columnIndex.map((c) => this.cells.get(r, c));
      const cells = columnIndex.map((c, k) => show(c, exact[k]));
      const row: Row = { cells, marks, cls: this.cells.cls(r) };
      // Exact values only matter for numbers the format changed.
      if (columnIndex.some((c, k) => this.table.columns[c].kind === 'value' && cells[k] !== exact[k])) {
        row.exact = exact;
      }
      return row;
    };
    return {
      kind: 'list',
      allColumns: this.table.columns,
      columnIndex,
      rows: Array.from(index.subarray(offset, offset + pageSize), project),
      offset,
      page,
      pageCount,
      filteredCount: index.length,
      totalCount: this.cells.length,
    };
  }

  /** Statistics of every column over the rows matching the selection; `maxLabels` limits ColumnStats.labels. */
  stats(selection: RowSelection, maxLabels = 10): { rows: number; columns: ColumnStats[] } {
    const index = this.indexFor(selection);
    const columns = this.table.columns.map((col, c): ColumnStats => {
      if (col.kind !== 'value') {
        const { ids, labels } = this.cells.labels(c);
        const seen = new Uint8Array(labels.length);
        const first: string[] = [];
        let distinct = 0;
        for (const r of index) {
          if (!seen[ids[r]]) {
            seen[ids[r]] = 1;
            distinct++;
            if (first.length < maxLabels) first.push(labels[ids[r]]);
          }
        }
        return { column: c, name: col.name, kind: col.kind, distinct, labels: first };
      }
      const { values, special } = this.cells.numbers(c);
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let zeros = 0;
      const bySpecial = new Uint32Array(8);
      for (const r of index) {
        const sp = special[r];
        if (sp !== Sp.None) {
          bySpecial[sp]++;
          continue;
        }
        const x = values[r];
        count++;
        sum += x;
        if (x < min) min = x;
        if (x > max) max = x;
        if (x === 0) zeros++;
      }
      const specials: ColumnStats['specials'] = {};
      const names: [Sp, keyof NonNullable<ColumnStats['specials']>][] = [
        [Sp.Eps, 'Eps'],
        [Sp.NA, 'NA'],
        [Sp.PInf, '+Inf'],
        [Sp.MInf, '-Inf'],
        [Sp.Undf, 'Undf'],
        [Sp.Empty, 'empty'],
        [Sp.Text, 'text'],
      ];
      for (const [sp, name] of names) if (bySpecial[sp]) specials[name] = bySpecial[sp];
      return { column: c, name: col.name, kind: col.kind, count, sum, min: count ? min : undefined, max: count ? max : undefined, zeros, specials };
    });
    return { rows: index.length, columns };
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
    const { ids, labels } = this.cells.labels(column);
    const rank = this.ranks(column);
    // Only labels that occur (compact columns may intern labels no row uses).
    const present = new Uint8Array(labels.length);
    for (let r = 0; r < ids.length; r++) present[ids[r]] = 1;
    const order = labels.map((_, id) => id).filter((id) => present[id]).sort((a, b) => rank[a] - rank[b]);
    const values = order.slice(0, MAX_COLUMN_VALUES).map((id) => labels[id]);
    return { column, values, truncated: order.length > MAX_COLUMN_VALUES };
  }

  /**
   * Chart data of the rows matching the selection: the numbers of a value column by the labels
   * of one key column (categories) and optionally another (series); the other key columns are
   * summed. Labels are in GDX order. Bar and line charts have at most MAX_CHART_SERIES series
   * (the rest are summed as "Other"); a heatmap has one row per series label.
   */
  chart(q: ChartQuery): ChartData {
    const keys = this.keyColumns;
    const values = this.table.columns.flatMap((c, i) => (c.kind === 'value' ? [i] : []));
    const spec = q.chart ?? {};
    const type: ChartType = spec.type === 'line' || spec.type === 'heatmap' ? spec.type : 'bar';
    const x = keys.includes(spec.x as number) ? (spec.x as number) : keys[keys.length - 1];
    const fields = (spec.fields ?? []).filter((f) => values.includes(f));
    let series =
      keys.includes(spec.series as number) && spec.series !== x
        ? (spec.series as number)
        : spec.series === -1 || (spec.series === FIELD_SERIES && fields.length && type !== 'heatmap')
          ? (spec.series as number)
          : undefined;
    if (series === undefined) series = keys.length >= 2 ? keys.find((k) => k !== x)! : -1;
    if (type === 'heatmap' && series < 0 && keys.length >= 2) series = keys.find((k) => k !== x)!;
    const bySeries = series === FIELD_SERIES;
    // Comparisons: the differences by default.
    const value = values.includes(spec.value as number) ? (spec.value as number) : bySeries ? fields[0] : (values.find((c) => this.table.columns[c].delta) ?? values[0]);
    const index = this.indexFor(q);
    const base = {
      kind: 'chart' as const,
      allColumns: this.table.columns,
      chart: { type, x, series, value, fields: bySeries ? fields : [] },
      signColors: !bySeries && series === -1 && !!this.table.columns[value]?.delta,
      summed: keys.filter((k) => k !== x && (bySeries || k !== series)),
      offset: 0,
      page: 0,
      pageCount: 1,
      filteredCount: index.length,
      totalCount: this.cells.length,
    };
    if (x === undefined || value === undefined) {
      return { ...base, categories: [], series: [], omittedCategories: 0, omittedSeries: 0, skipped: {}, eps: 0 };
    }

    // Categories and series labels that occur, in GDX order.
    const occurring = (col: number) => {
      const { ids, labels } = this.cells.labels(col);
      const seen = new Uint8Array(labels.length);
      for (const r of index) seen[ids[r]] = 1;
      const rank = this.ranks(col);
      return labels.map((_, id) => id).filter((id) => seen[id]).sort((a, b) => rank[a] - rank[b]);
    };
    const xs = occurring(x);
    const shownX = xs.slice(0, MAX_CHART_CATEGORIES);
    const xPos = new Int32Array(this.cells.labels(x).labels.length).fill(-1);
    shownX.forEach((id, i) => (xPos[id] = i));

    let seriesIds: number[] = [];
    let seriesPos: Int32Array | undefined;
    let omittedSeries = 0;
    let other = false;
    if (bySeries) {
      return { ...base, ...this.fieldSeries(index, x, xs, shownX, xPos, fields) };
    }
    if (series >= 0) {
      const ss = occurring(series);
      const cap = type === 'heatmap' ? MAX_CHART_CATEGORIES : MAX_CHART_SERIES;
      seriesPos = new Int32Array(this.cells.labels(series).labels.length).fill(-1);
      if (ss.length > cap) {
        seriesIds = ss.slice(0, type === 'heatmap' ? cap : cap - 1);
        omittedSeries = ss.length - seriesIds.length;
        other = type !== 'heatmap';
        if (other) ss.slice(seriesIds.length).forEach((id) => (seriesPos![id] = seriesIds.length));
      } else {
        seriesIds = ss;
      }
      seriesIds.forEach((id, i) => (seriesPos![id] = i));
    }
    const nSeries = series >= 0 ? seriesIds.length + (other ? 1 : 0) : 1;
    const sums = Array.from({ length: nSeries }, () => new Float64Array(shownX.length));
    const has = Array.from({ length: nSeries }, () => new Uint8Array(shownX.length));
    const skipped: Partial<Record<SpecialValue, number>> = {};
    let eps = 0;
    const xIds = this.cells.labels(x).ids;
    const sIds = series >= 0 ? this.cells.labels(series).ids : undefined;
    const num = this.cells.numbers(value);
    for (const r of index) {
      const c = xPos[xIds[r]];
      const sPos = sIds ? seriesPos![sIds[r]] : 0;
      if (c < 0 || sPos < 0) continue;
      const sp = num.special[r];
      if (sp === Sp.None || sp === Sp.Eps) {
        if (sp === Sp.None) sums[sPos][c] += num.values[r];
        else eps++;
        has[sPos][c] = 1;
      } else if (SPECIAL_OF_CODE[sp as Sp]) {
        const name = SPECIAL_OF_CODE[sp as Sp]!;
        skipped[name] = (skipped[name] ?? 0) + 1;
      }
    }
    // Palette slots follow the label, not its position among the shown series, when the column has few labels.
    const seriesLabels = series >= 0 ? this.cells.labels(series).labels : [];
    const allSeries = series >= 0 && type !== 'heatmap' ? this.occurringLabels(series) : undefined;
    const stable = allSeries && allSeries.length <= MAX_CHART_SERIES ? new Map(allSeries.map((id, i) => [id, i])) : undefined;
    const out = Array.from({ length: nSeries }, (_, i) => ({
      name: series < 0 ? this.table.columns[value].name : i < seriesIds.length ? seriesLabels[seriesIds[i]] : `Other (${omittedSeries})`,
      slot: series < 0 ? 0 : i < seriesIds.length ? (stable?.get(seriesIds[i]) ?? i) : -1,
      values: Array.from(sums[i], (v, c) => (has[i][c] ? v : null)),
    }));
    return {
      ...base,
      categories: shownX.map((id) => this.cells.labels(x).labels[id]),
      series: out,
      omittedCategories: xs.length - shownX.length,
      omittedSeries: type === 'heatmap' ? omittedSeries : 0,
      skipped,
      eps,
    };
  }

  /** Chart series from value columns (one per column), by the labels of `x`. */
  private fieldSeries(index: Int32Array, x: number, xs: number[], shownX: number[], xPos: Int32Array, fields: number[]) {
    const xIds = this.cells.labels(x).ids;
    const skipped: Partial<Record<SpecialValue, number>> = {};
    let eps = 0;
    const series = fields.map((f, slot) => {
      const num = this.cells.numbers(f);
      const sums = new Float64Array(shownX.length);
      const has = new Uint8Array(shownX.length);
      for (const r of index) {
        const c = xPos[xIds[r]];
        if (c < 0) continue;
        const sp = num.special[r];
        if (sp === Sp.None || sp === Sp.Eps) {
          if (sp === Sp.None) sums[c] += num.values[r];
          else eps++;
          has[c] = 1;
        } else if (SPECIAL_OF_CODE[sp as Sp]) {
          const name = SPECIAL_OF_CODE[sp as Sp]!;
          skipped[name] = (skipped[name] ?? 0) + 1;
        }
      }
      return { name: this.table.columns[f].name, slot, values: Array.from(sums, (v, c) => (has[c] ? v : null)) };
    });
    return {
      categories: shownX.map((id) => this.cells.labels(x).labels[id]),
      series,
      omittedCategories: xs.length - shownX.length,
      omittedSeries: 0,
      skipped,
      eps,
    };
  }

  /** The labels of a key column that occur in any record, in GDX order. */
  occurringLabels(column: number): number[] {
    const { ids, labels } = this.cells.labels(column);
    const seen = new Uint8Array(labels.length);
    for (let r = 0; r < ids.length; r++) seen[ids[r]] = 1;
    const rank = this.ranks(column);
    return labels.map((_, id) => id).filter((id) => seen[id]).sort((a, b) => rank[a] - rank[b]);
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

  /**
   * Groups the records by the labels of some dimensions: the group of every record
   * (in the order of the records) and a representative record per group, with the
   * groups sorted by the GDX order of their labels.
   */
  private group(records: Int32Array, dims: number[]): { groupOf: Int32Array; reps: Int32Array } {
    const m = records.length;
    const groupOf = new Int32Array(m);
    if (!dims.length) {
      return { groupOf, reps: Int32Array.of(m ? records[0] : 0).subarray(0, m ? 1 : 0) };
    }
    const cols = dims.map((d) => this.cells.labels(d));
    const ranks = dims.map((d) => this.ranks(d));
    // A number per label combination while it is exact, else a string.
    const counts = cols.map((c) => c.labels.length);
    const numeric = counts.reduce((a, b) => a * Math.max(1, b), 1) < Number.MAX_SAFE_INTEGER;
    const keyOf = numeric
      ? (r: number) => {
          let k = 0;
          for (let d = 0; d < cols.length; d++) k = k * counts[d] + cols[d].ids[r];
          return k;
        }
      : (r: number) => {
          let k = '';
          for (let d = 0; d < cols.length; d++) k += cols[d].ids[r] + ',';
          return k;
        };
    const groups = new Map<number | string, number>();
    const firstRecord: number[] = [];
    for (let i = 0; i < m; i++) {
      const r = records[i];
      const k = keyOf(r);
      let g = groups.get(k);
      if (g === undefined) {
        g = firstRecord.length;
        groups.set(k, g);
        firstRecord.push(r);
      }
      groupOf[i] = g;
    }
    // Sort the groups by the ranks of their labels, dimension by dimension.
    const order = firstRecord.map((_, g) => g);
    order.sort((a, b) => {
      const ra = firstRecord[a];
      const rb = firstRecord[b];
      for (let d = 0; d < cols.length; d++) {
        const x = ranks[d][cols[d].ids[ra]] - ranks[d][cols[d].ids[rb]];
        if (x !== 0) return x;
      }
      return 0;
    });
    const position = new Int32Array(order.length);
    order.forEach((g, pos) => (position[g] = pos));
    for (let i = 0; i < m; i++) groupOf[i] = position[groupOf[i]];
    const reps = new Int32Array(order.length);
    order.forEach((g, pos) => (reps[pos] = firstRecord[g]));
    return { groupOf, reps };
  }

  private pivotData(q: PivotQuery): PivotData {
    const { rowDims, colDims } = this.pivotDims(q.rowDims, q.colDims);
    const valueColumns = this.visibleColumns(q.hidden, q.squeeze, q.order).filter((i) => this.isValueColumn(i));
    const key = JSON.stringify([q.filter ?? '', q.columnFilters ?? [], rowDims, colDims, valueColumns, !!this.uelRank, compileSearch(q.filter) ? q.format : null]);
    if (key === this.lastPivotKey && this.lastPivot) {
      return this.lastPivot;
    }
    const records = this.indexFor({ filter: q.filter, columnFilters: q.columnFilters, format: q.format });
    const rows = this.group(records, rowDims);
    const cols = this.group(records, colDims);
    // The records of each pivot row (CSR layout), with their column group.
    const rowCount = rows.reps.length;
    const rowStart = new Int32Array(rowCount + 1);
    for (let i = 0; i < records.length; i++) rowStart[rows.groupOf[i] + 1]++;
    for (let r = 0; r < rowCount; r++) rowStart[r + 1] += rowStart[r];
    const fill = rowStart.slice(0, rowCount);
    const rowRecords = new Int32Array(records.length);
    const rowRecordGroup = new Int32Array(records.length);
    for (let i = 0; i < records.length; i++) {
      const at = fill[rows.groupOf[i]]++;
      rowRecords[at] = records[i];
      rowRecordGroup[at] = cols.groupOf[i];
    }
    // With several value columns (variables, equations) or no column dimension, the fields form the last level.
    const fieldLevel = this.table.columns.filter((_, i) => this.isValueColumn(i)).length > 1 || colDims.length === 0;
    const levels = [...colDims.map((d) => this.table.columns[d].name), ...(fieldLevel ? ['Field'] : [])];
    this.lastPivotKey = key;
    this.lastPivot = {
      rowDims,
      colDims,
      valueColumns,
      levels,
      fieldLevel,
      rowReps: rows.reps,
      colReps: cols.reps,
      rowStart,
      rowRecords,
      rowRecordGroup,
      columnCount: cols.reps.length * valueColumns.length,
      filteredCount: records.length,
    };
    return this.lastPivot;
  }

  /** Labels of a pivot row. */
  private rowLabels(p: PivotData, r: number): string[] {
    const rec = p.rowReps[r];
    return p.rowDims.map((d) => this.cells.get(rec, d));
  }

  /** Labels of a pivot column at each level. */
  private columnLabels(p: PivotData, c: number): string[] {
    const nv = p.valueColumns.length;
    const rec = p.colReps[Math.floor(c / nv)];
    const labels = p.colDims.map((d) => this.cells.get(rec, d));
    return p.fieldLevel ? [...labels, this.table.columns[p.valueColumns[c % nv]].name] : labels;
  }

  /** The record of each column group in a pivot row. */
  private rowCellRecords(p: PivotData, r: number): Map<number, number> {
    const m = new Map<number, number>();
    for (let k = p.rowStart[r]; k < p.rowStart[r + 1]; k++) m.set(p.rowRecordGroup[k], p.rowRecords[k]);
    return m;
  }

  /** The cell of a pivot column in a row ('' if there is no record). */
  private cell(p: PivotData, records: Map<number, number>, c: number): string {
    const nv = p.valueColumns.length;
    const rec = records.get(Math.floor(c / nv));
    if (rec === undefined) {
      return '';
    }
    const col = p.valueColumns[c % nv];
    // Like GAMS Studio: a set element without explanatory text is shown as "Y".
    return this.textOf(col, this.cells.get(rec, col));
  }

  pivot(q: PivotQuery): PivotPage {
    const p = this.pivotData(q);
    const show = this.formatter(q.format);
    const rowCount = p.rowReps.length;
    const pageSize = Math.max(1, q.pageSize);
    const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
    const offset = windowStart(q, pageSize, rowCount);
    const page = Math.floor(offset / pageSize);
    const colPageSize = Math.max(1, q.colPageSize);
    const colPageCount = Math.max(1, Math.ceil(p.columnCount / colPageSize));
    const colPage = Math.min(Math.max(0, q.colPage ?? 0), colPageCount - 1);
    const colOffset = colPage * colPageSize;
    const cols: number[] = [];
    for (let c = colOffset; c < Math.min(p.columnCount, colOffset + colPageSize); c++) cols.push(c);
    const nv = p.valueColumns.length;
    const rows: PivotPage['rows'] = [];
    for (let r = offset; r < Math.min(rowCount, offset + pageSize); r++) {
      const records = this.rowCellRecords(p, r);
      const exact = cols.map((c) => this.cell(p, records, c));
      // An empty cell is a missing record (cell() already shows set elements without text as Y).
      const cells = cols.map((c, k) => (exact[k] === '' ? '' : show(p.valueColumns[c % nv], exact[k])));
      const labels = this.rowLabels(p, r);
      rows.push(cells.some((c, k) => c !== exact[k]) ? { labels, cells, exact } : { labels, cells });
    }
    return {
      kind: 'pivot',
      allColumns: this.table.columns,
      rowDims: p.rowDims,
      colDims: p.colDims,
      valueColumns: p.valueColumns,
      levels: p.levels,
      headers: cols.map((c) => this.columnLabels(p, c)),
      cellKinds: cols.map((c) => this.table.columns[p.valueColumns[c % nv]].kind),
      rows,
      offset,
      page,
      pageCount,
      filteredCount: p.filteredCount,
      totalCount: this.cells.length,
      rowCount,
      colOffset,
      colPage,
      colPageCount,
      colCount: p.columnCount,
    };
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

  /** A test per label index of a column (each distinct label is tested once). */
  private labelHits(column: number, rx: RegExp, display: boolean): Uint8Array {
    const { labels } = this.cells.labels(column);
    const hit = new Uint8Array(labels.length);
    labels.forEach((l, id) => (hit[id] = rx.test(display ? this.textOf(column, l) : l) ? 1 : 0));
    return hit;
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
      const numbers = canMatchNumbers(search);
      const none = () => false;
      const tests = columnIndex.map((c) => {
        if (this.isLabelColumn(c)) {
          const { ids } = this.cells.labels(c);
          const hit = this.labelHits(c, rx, true);
          return (r: number) => hit[ids[r]] === 1;
        }
        return numbers ? (r: number) => rx.test(show(c, this.cells.get(r, c))) : none;
      });
      const hits: Hit[] = [];
      for (let k = 0; k < index.length; k++) {
        const r = index[k];
        for (let c = 0; c < tests.length; c++) {
          if (tests[c](r)) hits.push({ r: k, c });
        }
      }
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
      const nv = p.valueColumns.length;
      // Column headers: a label merged over several columns counts once.
      p.colDims.forEach((d, level) => {
        const { ids } = this.cells.labels(d);
        const hit = this.labelHits(d, rx, false);
        const dimsUpTo = p.colDims.slice(0, level + 1).map((x) => this.cells.labels(x).ids);
        for (let c = 0; c < p.columnCount; c++) {
          const rec = p.colReps[Math.floor(c / nv)];
          if (c > 0) {
            const prev = p.colReps[Math.floor((c - 1) / nv)];
            if (dimsUpTo.every((dimIds) => dimIds[rec] === dimIds[prev])) continue;
          }
          if (hit[ids[rec]]) hits.push({ r: level, c, kind: 'col' });
        }
      });
      const rowHits = p.rowDims.map((d) => ({ ids: this.cells.labels(d).ids, hit: this.labelHits(d, rx, false) }));
      const numbers = canMatchNumbers(search);
      for (let r = 0; r < p.rowReps.length; r++) {
        const rec = p.rowReps[r];
        const prev = r > 0 ? p.rowReps[r - 1] : -1;
        let same = prev >= 0;
        rowHits.forEach(({ ids, hit }, k) => {
          same = same && ids[rec] === ids[prev];
          if (!same && hit[ids[rec]]) hits.push({ r, c: k, kind: 'row' });
        });
        const found: number[] = [];
        for (let k = p.rowStart[r]; k < p.rowStart[r + 1]; k++) {
          const record = p.rowRecords[k];
          const group = p.rowRecordGroup[k];
          p.valueColumns.forEach((v, vi) => {
            if (!numbers && this.table.columns[v].kind === 'value') return;
            const value = this.textOf(v, this.cells.get(record, v));
            if (value !== '' && rx.test(show(v, value))) found.push(group * nv + vi);
          });
        }
        found.sort((a, b) => a - b).forEach((c) => hits.push({ r, c }));
      }
      return { hits };
    });
  }

  /**
   * The selected cells of the list view: rows are positions in the filtered and sorted
   * rows, columns are positions among the shown columns. With `all`, every row and
   * column, headed by the column names. Set elements without text are shown as "Y" unless `displayTexts` is false.
   */
  gridList(q: TableQuery, sel: CellSelection, displayTexts = true, limits?: GridLimits): Grid {
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const index = this.indexFor(q);
    const [r0, r1] = sel.all ? [0, index.length - 1] : clampRange(sel.rows, index.length);
    const [c0, c1] = sel.all ? [0, columnIndex.length - 1] : clampRange(sel.cols, columnIndex.length);
    const cols = columnIndex.slice(c0, c1 + 1);
    checkLimits(Math.max(0, r1 - r0 + 1) + (sel.all ? 1 : 0), cols.length, limits);
    const rows: GridCell[][] = [];
    if (sel.all) {
      rows.push(cols.map((c) => ({ v: this.table.columns[c].name, header: true })));
    }
    for (let r = r0; r <= r1; r++) {
      const rec = index[r];
      rows.push(
        cols.map((c) => {
          const v = this.cells.get(rec, c);
          return { v: displayTexts ? this.textOf(c, v) : v, value: this.table.columns[c].kind === 'value' };
        }),
      );
    }
    return { rows, headerRows: sel.all ? 1 : 0, headerCols: 0, cells: Math.max(0, r1 - r0 + 1) * cols.length };
  }

  /**
   * The selected cells of the table view: rows and columns are positions in the pivot
   * table. With `labels`, the row labels and column headers of the selection are
   * included (and the names of the dimensions in the corner).
   */
  gridPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, sel: CellSelection, labels: boolean, limits?: GridLimits): Grid {
    const p = this.pivotData({ ...q, pageSize: 1, colPageSize: 1 });
    const [r0, r1] = sel.all ? [0, p.rowReps.length - 1] : clampRange(sel.rows, p.rowReps.length);
    const [c0, c1] = sel.all ? [0, p.columnCount - 1] : clampRange(sel.cols, p.columnCount);
    checkLimits(Math.max(0, r1 - r0 + 1) + (labels ? p.levels.length : 0), Math.max(0, c1 - c0 + 1) + (labels ? p.rowDims.length : 0), limits);
    const cols: number[] = [];
    for (let c = c0; c <= c1; c++) cols.push(c);
    const nv = p.valueColumns.length;
    const rows: GridCell[][] = [];
    if (labels) {
      const headers = cols.map((c) => this.columnLabels(p, c));
      p.levels.forEach((name, level) => {
        // Like the view: row dimension names on the last header row, the level's name above them.
        const last = level === p.levels.length - 1;
        const corner = p.rowDims.map((d, k) => (last ? this.table.columns[d].name : k === p.rowDims.length - 1 ? name : ''));
        rows.push([...corner, ...headers.map((hd) => hd[level] ?? '')].map((v) => ({ v, header: true })));
      });
    }
    for (let r = r0; r <= r1; r++) {
      const records = this.rowCellRecords(p, r);
      const cells = cols.map((c) => ({ v: this.cell(p, records, c), value: this.table.columns[p.valueColumns[c % nv]].kind === 'value' }));
      rows.push(labels ? [...this.rowLabels(p, r).map((v) => ({ v, header: true })), ...cells] : cells);
    }
    return { rows, headerRows: labels ? p.levels.length : 0, headerCols: labels ? p.rowDims.length : 0, cells: Math.max(0, r1 - r0 + 1) * cols.length };
  }

  /** Statistics of the numbers among the selected cells of the list view (positions as in gridList). */
  selectionStatsList(q: TableQuery, sel: CellSelection): SelectionStats {
    const columnIndex = this.visibleColumns(q.hidden, q.squeeze, q.order);
    const index = this.indexFor(q);
    const [r0, r1] = sel.all ? [0, index.length - 1] : clampRange(sel.rows, index.length);
    const [c0, c1] = sel.all ? [0, columnIndex.length - 1] : clampRange(sel.cols, columnIndex.length);
    const stats = new StatsAccumulator();
    for (const c of columnIndex.slice(c0, c1 + 1)) {
      const numeric = this.table.columns[c].kind === 'value' ? this.cells.numbers(c) : undefined;
      for (let r = r0; r <= r1; r++) {
        if (numeric) stats.add(numeric.special[index[r]], numeric.values[index[r]]);
        else stats.label(this.cells.get(index[r], c));
      }
    }
    return stats.result();
  }

  /** Statistics of the numbers among the selected cells of the table view (positions as in gridPivot, without labels). */
  selectionStatsPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, sel: CellSelection): SelectionStats {
    const p = this.pivotData({ ...q, pageSize: 1, colPageSize: 1 });
    const [r0, r1] = sel.all ? [0, p.rowReps.length - 1] : clampRange(sel.rows, p.rowReps.length);
    const [c0, c1] = sel.all ? [0, p.columnCount - 1] : clampRange(sel.cols, p.columnCount);
    const nv = p.valueColumns.length;
    const numeric = p.valueColumns.map((c) => (this.table.columns[c].kind === 'value' ? this.cells.numbers(c) : undefined));
    const stats = new StatsAccumulator();
    for (let r = r0; r <= r1; r++) {
      const records = this.rowCellRecords(p, r);
      for (let c = c0; c <= c1; c++) {
        const rec = records.get(Math.floor(c / nv));
        const n = numeric[c % nv];
        if (rec === undefined) stats.add(Sp.Empty, 0);
        else if (n) stats.add(n.special[rec], n.values[rec]);
        else stats.label(this.textOf(p.valueColumns[c % nv], this.cells.get(rec, p.valueColumns[c % nv])));
      }
    }
    return stats.result();
  }

  /** The selected cells of the list view as text (see gridList). */
  copyList(q: TableQuery, sel: CellSelection, opts: CopyOptions): CopyResult {
    return gridText(this.gridList(q, sel, true, opts.limits), opts);
  }

  /** The selected cells of the table view as text (see gridPivot). */
  copyPivot(q: Omit<PivotQuery, 'page' | 'pageSize' | 'colPage' | 'colPageSize'>, sel: CellSelection, opts: CopyOptions): CopyResult {
    return gridText(this.gridPivot(q, sel, opts.labels, opts.limits), opts);
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

/** Statistics of selected cells, like a spreadsheet's status bar. */
export interface SelectionStats {
  /** Selected cells, including empty ones. */
  cells: number;
  /** Cells with a number (special values are not numbers). */
  numbers: number;
  sum: number;
  min?: number;
  max?: number;
  /** Cells with a special value (only those that occur). */
  specials: Partial<Record<SpecialValue, number>>;
  /** Cells that are neither numbers, special values nor empty (labels, texts). */
  texts: number;
}

const SPECIAL_OF_CODE: Partial<Record<Sp, SpecialValue>> = { [Sp.Eps]: 'eps', [Sp.NA]: 'na', [Sp.PInf]: 'pinf', [Sp.MInf]: 'minf', [Sp.Undf]: 'undf' };

class StatsAccumulator {
  private cells = 0;
  private numbers = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;
  private texts = 0;
  private readonly specials: Partial<Record<SpecialValue, number>> = {};

  add(sp: Sp, x: number) {
    this.cells++;
    if (sp === Sp.None) {
      this.numbers++;
      this.sum += x;
      if (x < this.min) this.min = x;
      if (x > this.max) this.max = x;
    } else if (sp === Sp.Text) {
      this.texts++;
    } else if (sp !== Sp.Empty) {
      const name = SPECIAL_OF_CODE[sp]!;
      this.specials[name] = (this.specials[name] ?? 0) + 1;
    }
  }

  label(v: string) {
    this.cells++;
    if (v !== '') this.texts++;
  }

  result(): SelectionStats {
    const { cells, numbers, sum, texts, specials } = this;
    return numbers ? { cells, numbers, sum, min: this.min, max: this.max, specials, texts } : { cells, numbers, sum: 0, specials, texts };
  }
}

/** Limits of a grid (checked before it is built, so that huge selections fail early). */
export interface GridLimits {
  maxCells?: number;
  maxRows?: number;
  maxCols?: number;
  /** Describes the grid in error messages, e.g. "Copying" or "demand". */
  what?: string;
}

/** A grid that exceeds its limits. */
export class GridTooLargeError extends Error {}

function checkLimits(rows: number, cols: number, limits: GridLimits | undefined) {
  if (!limits) {
    return;
  }
  const f = (n: number) => n.toLocaleString('en-US');
  const what = limits.what ?? 'The selection';
  if (limits.maxRows !== undefined && rows > limits.maxRows) {
    throw new GridTooLargeError(`${what} has ${f(rows)} rows; at most ${f(limits.maxRows)} are possible.`);
  }
  if (limits.maxCols !== undefined && cols > limits.maxCols) {
    throw new GridTooLargeError(`${what} has ${f(cols)} columns; at most ${f(limits.maxCols)} are possible.`);
  }
  if (limits.maxCells !== undefined && rows * cols > limits.maxCells) {
    throw new GridTooLargeError(`${what} has ${f(rows * cols)} cells; at most ${f(limits.maxCells)} are possible.`);
  }
}

export interface CopyOptions {
  /** Refuse selections beyond these limits. */
  limits?: GridLimits;
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
  /** A record of each pivot row and each column group (for their labels), in display order. */
  rowReps: Int32Array;
  colReps: Int32Array;
  /** The records of pivot row r are rowRecords[rowStart[r] .. rowStart[r + 1]), with their column group. */
  rowStart: Int32Array;
  rowRecords: Int32Array;
  rowRecordGroup: Int32Array;
  /** Number of pivot columns: column groups times shown value columns. */
  columnCount: number;
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

/**
 * Table for the records of one symbol in compact columns (see columns.ts), e.g. as
 * streamed from gdxdump; `columns` are the column names, the first `keyCount` are keys.
 */
export function columnTable(columns: string[], keyCount: number, store: ColumnStore, symbol?: { type: string; subtype?: string }): Table {
  return {
    columns: columns.map((name, i) => ({
      name,
      kind: i < keyCount ? 'key' : name === 'Text' ? 'text' : 'value',
    })),
    store,
    defaults:
      symbol && (symbol.type === 'Var' || symbol.type === 'Equ')
        ? fieldDefaults(symbol.type, symbol.subtype, columns, { length: store.length, get: (r, c) => store.get(r, c) })
        : undefined,
    setTexts: columns.includes('Text'),
  };
}

/** Name of the pseudo-symbol listing the unique elements (like GAMS Studio's "Universe"). */
export const UNIVERSE = '*';

/** The universe as the first entry of the symbol list: a one-dimensional set of all labels. */
export function universeSymbol(version: [string, string][]): GdxSymbol & { universe: true } {
  const count = Number(version.find(([k]) => /^unique elements$/i.test(k))?.[1]);
  return {
    name: UNIVERSE,
    dim: 1,
    type: 'Set',
    records: Number.isFinite(count) ? count : 0,
    text: 'Universe: all unique elements in GDX order',
    domain: ['*'],
    entry: 0,
    universe: true,
  };
}

/** The unique elements with their numbers in the GDX file (UEL numbers, from 1). */
export function universeTable(uels: string[]): Table {
  const builder = new ColumnStoreBuilder(['label', 'number'], uels.length);
  uels.forEach((label, i) => {
    builder.set(0, label);
    builder.set(1, String(i + 1));
    builder.endRow();
  });
  return columnTable(['Label', 'UEL #'], 1, builder.build());
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
      columns.push({ name: `Δ ${name}`, kind: 'value', delta: true });
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

const STATUS_NAMES = ['changed', 'only1', 'only2'] as const;

/**
 * Like diffTable, for a symbol of a gdxdiff difference file in compact columns (as
 * streamed from gdxdump): the keys, the status and, per value column that differs, the
 * values of both files (plus their difference for numbers). gdxdiff writes the records
 * sorted by their indices with the dif1/dif2/ins1/ins2 label last, so the two rows of a
 * changed record follow each other.
 */
export function diffColumnTable(data: SymbolColumns): Table {
  const store = data.store;
  const n = store.length;
  const keyCount = data.keyCount - 1;
  const keyCols = store.columns.slice(0, keyCount) as LabelColumn[];
  const tagCol = store.columns[keyCount] as LabelColumn;
  const tagCode = tagCol.labels.list.map((t) => ['dif1', 'dif2', 'ins1', 'ins2'].indexOf(t.toLowerCase()));
  const valueNames = data.columns.slice(data.keyCount);
  const valueCols = store.columns.slice(data.keyCount);

  // Pair the rows: record -> row in file 1 / file 2 (-1: none), and the status.
  const row1 = new Int32Array(n).fill(-1);
  const row2 = new Int32Array(n).fill(-1);
  const keyRow = new Int32Array(n);
  const status = new Uint8Array(n);
  let m = 0;
  for (let r = 0; r < n; r++) {
    const prev = m > 0 ? keyRow[m - 1] : -1;
    const same = prev >= 0 && keyCols.every((c) => c.ids[r] === c.ids[prev]);
    const rec = same ? m - 1 : m++;
    if (!same) {
      keyRow[rec] = r;
    }
    const tag = tagCode[tagCol.ids[r]];
    if (tag === 0) row1[rec] = r;
    else if (tag === 1) row2[rec] = r;
    else if (tag === 2) (row1[rec] = r), (status[rec] = 1);
    else if (tag === 3) (row2[rec] = r), (status[rec] = 2);
  }

  const differs = (col: StoredColumn, a: number, b: number): boolean => {
    if (a < 0 || b < 0) return a !== b;
    if (col.type === 'label') return col.ids[a] !== col.ids[b];
    return col.special[a] !== col.special[b] || (col.special[a] === Sp.None && col.values[a] !== col.values[b]);
  };
  const shown = valueCols.map((c, i) => ({ c, i })).filter(({ c, i }) => {
    if (i === 0) return true;
    for (let rec = 0; rec < m; rec++) {
      if (status[rec] === 0 && differs(c, row1[rec], row2[rec])) return true;
    }
    return false;
  });

  const columns: Column[] = [
    ...data.columns.slice(0, keyCount).map((name): Column => ({ name, kind: 'key' })),
    { name: 'Status', kind: 'status' },
  ];
  const stored: StoredColumn[] = keyCols.map((c) => {
    const ids = new Int32Array(m);
    for (let rec = 0; rec < m; rec++) ids[rec] = c.ids[keyRow[rec]];
    return { type: 'label', ids, labels: c.labels } as LabelColumn;
  });
  const statusLabels = new Labels();
  (['changed', 'only in file 1', 'only in file 2'] as const).forEach((l) => statusLabels.intern(l));
  stored.push({ type: 'label', ids: Int32Array.from(status.subarray(0, m)), labels: statusLabels });

  const pick = (col: StoredColumn, rows: Int32Array): StoredColumn => {
    if (col.type === 'label') {
      const empty = col.labels.intern('');
      const ids = new Int32Array(m);
      for (let rec = 0; rec < m; rec++) ids[rec] = rows[rec] >= 0 ? col.ids[rows[rec]] : empty;
      return { type: 'label', ids, labels: col.labels };
    }
    const values = new Float64Array(m);
    const special = new Uint8Array(m).fill(Sp.Empty);
    for (let rec = 0; rec < m; rec++) {
      const r = rows[rec];
      if (r >= 0) {
        values[rec] = col.values[r];
        special[rec] = col.special[r];
      }
    }
    return { type: 'number', values, special };
  };
  /** Pairs of highlighted columns (file 1, file 2) and the source column, per shown value column. */
  const markPairs: { pos: number; col: StoredColumn }[] = [];
  for (const { c, i } of shown) {
    const name = valueNames[i];
    const kind = name === 'Text' ? 'text' : 'value';
    markPairs.push({ pos: columns.length, col: c });
    columns.push({ name: `${name} (file 1)`, kind, side: 1 }, { name: `${name} (file 2)`, kind, side: 2 });
    const v1 = pick(c, row1);
    const v2 = pick(c, row2);
    stored.push(v1, v2);
    if (kind === 'value' && v1.type === 'number' && v2.type === 'number') {
      columns.push({ name: `Δ ${name}`, kind: 'value', delta: true });
      const values = new Float64Array(m);
      const special = new Uint8Array(m).fill(Sp.Empty);
      for (let rec = 0; rec < m; rec++) {
        // Exact; the number format of the view decides how many digits are shown.
        if (status[rec] === 0 && v1.special[rec] === Sp.None && v2.special[rec] === Sp.None && Number.isFinite(v1.values[rec]) && Number.isFinite(v2.values[rec])) {
          values[rec] = v2.values[rec] - v1.values[rec];
          special[rec] = Sp.None;
        }
      }
      stored.push({ type: 'number', values, special } as NumberColumn);
    }
  }
  return {
    columns,
    store: new ColumnStore(m, stored),
    rowMarks: (rec) => {
      if (status[rec] !== 0) return [];
      const marks: number[] = [];
      for (const { pos, col } of markPairs) {
        if (differs(col, row1[rec], row2[rec])) marks.push(pos, pos + 1);
      }
      return marks;
    },
    rowClass: (rec) => `st-${STATUS_NAMES[status[rec]]}`,
  };
}

/** Most symbols whose records a viewer or comparison keeps in memory (the most recently used ones). */
export const MAX_CACHED_VIEWS = 4;

/** Looks up a cached view and marks it as recently used; evicts the least recently used ones. */
export function cachedView<T>(cache: Map<string, T>, name: string, load: () => T): T {
  let v = cache.get(name);
  if (v === undefined) {
    v = load();
  } else {
    cache.delete(name);
  }
  cache.set(name, v);
  while (cache.size > MAX_CACHED_VIEWS) {
    cache.delete(cache.keys().next().value as string);
  }
  return v;
}
