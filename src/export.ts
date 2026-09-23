/**
 * Export of symbols to Excel, laid out like the viewer shows them (list or table view,
 * filters, fields), and the equivalent GAMS Connect instructions (GDXReader, Filter,
 * Projection, ExcelWriter) for GAMS Studio-like reproducibility.
 */
import { NumberFormat, normalizeFormat } from './format';
import type { GdxSymbol } from './parse';
import { TextSearch } from './search';
import { ColumnFilter, SpecialValue, TableView, specialOf } from './table';
import { Sheet, SheetCell, sheetNames } from './xlsx';

/** The per-symbol view state of the webview (see media/table.js). */
export interface SymbolViewState {
  view?: 'list' | 'table';
  columnFilters?: ColumnFilter[];
  search?: TextSearch & { filterRows?: boolean };
  sortColumn?: number;
  sortDescending?: boolean;
  hidden?: number[];
  order?: number[];
  squeeze?: boolean;
  rowDims?: number[];
  colDims?: number[];
  format?: Partial<NumberFormat>;
}

export interface ExportOptions {
  /** Apply the column filters (and the "filter rows" search) of each symbol. */
  applyFilters: boolean;
  /** Include fields hidden in the viewer (by the user or by squeezing defaults). */
  includeHidden: boolean;
  /** Replacement of special values; text that is a number is written as a number. */
  specials: Record<SpecialValue, string>;
}

/** Like GAMS Connect's ExcelWriter writes special values by default. */
export const DEFAULT_SPECIALS: Record<SpecialValue, string> = { eps: 'EPS', na: 'NA', pinf: 'INF', minf: '-INF', undf: 'UNDEF' };

export interface ExportItem {
  symbol: GdxSymbol;
  view: TableView;
  state?: SymbolViewState;
}

export interface ExportDefaults {
  format: NumberFormat;
  squeezeDefaults: boolean;
}

function isPivot(item: ExportItem): boolean {
  return item.state?.view === 'table' && item.symbol.dim >= 2;
}

/** The query of a symbol's view for the export. */
function exportQuery(item: ExportItem, options: ExportOptions, defaults: ExportDefaults) {
  const st = item.state ?? {};
  const search = st.search?.text && st.search.filterRows ? st.search : undefined;
  return {
    columnFilters: options.applyFilters ? (st.columnFilters ?? []) : [],
    filter: options.applyFilters ? search : undefined,
    // Rows are matched against the displayed values, as in the viewer.
    format: st.format ? normalizeFormat(st.format, defaults.format) : defaults.format,
    sortColumn: st.sortColumn,
    sortDescending: st.sortDescending,
    hidden: options.includeHidden ? [] : (st.hidden ?? []),
    order: st.order,
    squeeze: options.includeHidden ? false : (st.squeeze ?? defaults.squeezeDefaults),
    rowDims: st.rowDims,
    colDims: st.colDims,
    pageSize: 1,
  };
}

function sheetValue(v: string, special: Record<SpecialValue, string>): number | string {
  const sv = specialOf(v);
  if (sv) {
    const text = special[sv] ?? DEFAULT_SPECIALS[sv];
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : v;
}

/** One sheet per symbol, laid out like its view, with exact values. */
export function buildSheets(items: ExportItem[], options: ExportOptions, defaults: ExportDefaults): Sheet[] {
  return items.map((item) => {
    const q = exportQuery(item, options, defaults);
    // Like GAMS Connect: set elements without text are empty in the list layout and Y in the table layout.
    const grid = isPivot(item) ? item.view.gridPivot(q, { all: true }, true) : item.view.gridList(q, { all: true }, false);
    const rows: SheetCell[][] = grid.rows.map((row) =>
      row.map((c): SheetCell => (c.header ? { v: c.v, bold: true } : c.value ? { v: sheetValue(c.v, options.specials) } : { v: c.v })),
    );
    return { name: item.symbol.name, rows, freezeRows: grid.headerRows, freezeCols: grid.headerCols };
  });
}

const SUFFIX: Record<string, string> = { Level: 'l', Marginal: 'm', Lower: 'lo', Upper: 'up', Scale: 'scale' };
const ATTRIBUTE: Record<string, string> = { Value: 'value', Level: 'level', Marginal: 'marginal', Lower: 'lower', Upper: 'upper', Scale: 'scale' };
const CONNECT_SPECIAL: Record<SpecialValue, string> = { eps: 'EPS', na: 'NA', pinf: 'INF', minf: '-INF', undf: 'UNDEF' };

const q = (v: unknown) => JSON.stringify(v);

/** A value filter rule for a range filter (Python/pandas syntax). */
function rangeRule(min?: number, max?: number, exclude?: boolean): string | undefined {
  const parts = [min !== undefined ? `(x >= ${min})` : '', max !== undefined ? `(x <= ${max})` : ''].filter(Boolean);
  if (!parts.length) {
    return undefined;
  }
  const inside = parts.join(' & ');
  return exclude ? `~(${inside})` : inside;
}

/**
 * GAMS Connect instructions that write the same sheets as buildSheets (run them with
 * `gamsconnect <file>`). What Connect cannot express is noted as a comment.
 */
export function connectInstructions(gdxFile: string, xlsxFile: string, items: ExportItem[], options: ExportOptions, defaults: ExportDefaults): string {
  const lines: string[] = [
    '# GAMS Connect instructions written by the GDX Viewer for VS Code.',
    `# Run them with: gamsconnect "<this file>"`,
  ];
  const writerSymbols: string[] = [];
  const agents: string[] = [];
  const read = items.filter((i) => i.symbol.type !== 'Alias');
  const names = sheetNames(read.map((i) => i.symbol.name));
  for (const item of items.filter((i) => i.symbol.type === 'Alias')) {
    lines.push(`# ${item.symbol.name}: aliases are not written by the ExcelWriter.`);
  }
  read.forEach((item, k) => {
    const s = item.symbol;
    const st = item.state ?? {};
    const query = exportQuery(item, options, defaults);
    const cols = item.view.table.columns;
    const keys = cols.flatMap((c, i) => (c.kind === 'key' ? [i] : []));
    const idx = keys.map((_, i) => `d${i + 1}`);
    let current = s.name;
    const notes: string[] = [];

    // Filters (on the original symbol; dimensions are 1-based).
    if (options.applyFilters) {
      const labelFilters: string[] = [];
      const valueFilters: string[] = [];
      for (const f of st.columnFilters ?? []) {
        const col = cols[f.column];
        if (!col) {
          continue;
        }
        if (f.type === 'labels') {
          if (col.kind !== 'key') {
            notes.push(`the filter on ${col.name} (texts) is not applied`);
            continue;
          }
          labelFilters.push(`      - dimension: ${keys.indexOf(f.column) + 1}\n        ${f.exclude ? 'reject' : 'keep'}: ${q(f.labels)}`);
        } else {
          const rule = rangeRule(f.min, f.max, f.exclude);
          const reject = (f.hideSpecials ?? []).map((x) => CONNECT_SPECIAL[x]);
          if (!rule && !reject.length) {
            continue;
          }
          valueFilters.push(
            `      - attribute: ${ATTRIBUTE[col.name] ?? 'all'}` + (rule ? `\n        rule: ${q(rule)}` : '') + (reject.length ? `\n        rejectSpecialValues: ${q(reject)}` : ''),
          );
          if (rule) {
            notes.push('Connect compares special values in ranges numerically (the viewer shows them unless unchecked)');
          }
        }
      }
      if (st.search?.text && st.search.filterRows) {
        notes.push(`the text search ${q(st.search.text)} is not applied`);
      }
      if (labelFilters.length || valueFilters.length) {
        const name = `${s.name}_filtered`;
        agents.push(
          `- Filter:\n    name: ${s.name}\n    newName: ${name}` +
            (labelFilters.length ? `\n    labelFilters:\n${labelFilters.join('\n')}` : '') +
            (valueFilters.length ? `\n    valueFilters:\n${valueFilters.join('\n')}` : ''),
        );
        current = name;
      }
    }
    if (!isPivot(item) && st.sortColumn !== undefined) {
      notes.push('the sort order of the viewer is not applied');
    }

    // Variables and equations: the shown fields as a parameter (several fields add a field index at the end).
    const pivot = isPivot(item);
    const shownOrder = item.view.orderedColumns(query.order);
    // List view: the key columns in the order shown.
    let order = shownOrder.filter((c) => keys.includes(c)).map((d) => idx[keys.indexOf(d)]);
    let columnDimension = 0;
    if (pivot) {
      const dims = item.view.pivotDims(query.rowDims, query.colDims);
      order = [...dims.rowDims, ...dims.colDims].map((d) => idx[keys.indexOf(d)]);
      columnDimension = dims.colDims.length;
    }
    const reordered = order.join(',') !== idx.join(',');
    const target = `${s.name}_view`;
    if (s.type === 'Var' || s.type === 'Equ') {
      const hidden = new Set([...query.hidden, ...(query.squeeze ? item.view.squeezableColumns() : [])]);
      // The fields in the order shown.
      const inOrder = shownOrder.map((i) => ({ c: cols[i], i }));
      let fields = inOrder.filter(({ c, i }) => SUFFIX[c.name] && !hidden.has(i));
      if (!fields.length) {
        fields = inOrder.filter(({ c }) => SUFFIX[c.name]);
      }
      const suffix = fields.length === 1 ? SUFFIX[fields[0].c.name] : `[${fields.map((f) => SUFFIX[f.c.name]).join(',')}]`;
      agents.push(`- Projection:\n    name: ${current}.${suffix}(${idx.join(',')})\n    newName: ${target}(${order.join(',')})`);
      current = target;
      if (fields.length > 1) {
        // The fields are an extra (last) index: columns in the list view, the last column level in the table view.
        columnDimension += 1;
      }
    } else if (reordered) {
      agents.push(`- Projection:\n    name: ${current}(${idx.join(',')})\n    newName: ${target}(${order.join(',')})`);
      current = target;
    }
    for (const n of notes) {
      lines.push(`# ${s.name}: ${n}.`);
    }
    const sheet = /[^A-Za-z0-9_]/.test(names[k]) ? `'${names[k].replace(/'/g, "''")}'` : names[k];
    // Always explicit: ExcelWriter's default (infer) would put the last dimension of any symbol into columns.
    writerSymbols.push(`      - name: ${current}\n        range: ${q(`${sheet}!A1`)}\n        columnDimension: ${columnDimension}`);
  });

  const substitutions = (Object.keys(CONNECT_SPECIAL) as SpecialValue[])
    .filter((sv) => (options.specials[sv] ?? DEFAULT_SPECIALS[sv]) !== DEFAULT_SPECIALS[sv])
    .map((sv) => {
      const text = options.specials[sv];
      const n = Number(text);
      return `${q(CONNECT_SPECIAL[sv])}: ${text.trim() !== '' && Number.isFinite(n) ? n : q(text)}`;
    });

  lines.push(`- GDXReader:\n    file: ${q(gdxFile.replace(/\\/g, '/'))}\n    symbols:\n${read.map((i) => `      - name: ${i.symbol.name}`).join('\n')}`);
  lines.push(...agents);
  lines.push(
    `- ExcelWriter:\n    file: ${q(xlsxFile.replace(/\\/g, '/'))}` +
      (substitutions.length ? `\n    valueSubstitutions: {${substitutions.join(', ')}}` : '') +
      `\n    symbols:\n${writerSymbols.join('\n')}`,
  );
  return lines.join('\n') + '\n';
}
