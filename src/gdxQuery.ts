/**
 * Read-only GDX queries for AI agents, served by the MCP server (mcp.ts): list the
 * symbols of a file, read and summarize the records of a symbol, and compare two files.
 * Results are compact text (CSV) with exact values.
 *
 * No dependency on `vscode`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GdxFileInfo, loadFileInfo, loadSymbolColumns } from './gdxFile';
import { GdxSymbol, parseDiffOutput, parseDomainInfo, parseUelTable } from './parse';
import { ColumnFilter, ColumnStats, TableView, UNIVERSE, cachedView, columnTable, diffColumnTable, universeSymbol, universeTable } from './table';
import { DiffOptions, GdxTools } from './tools';

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Records returned by one call unless `limit` says otherwise, and the most allowed. */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 5000;

const FILE = { type: 'string', description: 'Path of the GDX file (absolute, or relative to the working directory).' };
const SYMBOL = { type: 'string', description: 'Symbol name (case-insensitive). "*" is the universe: all unique elements (labels) in GDX order with their UEL numbers.' };
const FILTERS = {
  type: 'object',
  description:
    'Filters by column name (a dimension such as "i", its 1-based position such as "1", or a field such as "Level"/"L"). ' +
    'Dimensions: a list of labels to keep (case-insensitive), or {"notIn": [...]}. ' +
    'Values: {"min": x, "max": y}, inclusive, either may be omitted; add "exclude": true to keep the values outside the range ' +
    '(e.g. {"min": 0, "max": 0, "exclude": true} for non-zero values). Special values (Eps, NA, +Inf, -Inf, Undf) pass range filters unless {"hideSpecials": true}.',
  additionalProperties: {
    anyOf: [
      { type: 'array', items: { type: 'string' } },
      {
        type: 'object',
        properties: {
          in: { type: 'array', items: { type: 'string' } },
          notIn: { type: 'array', items: { type: 'string' } },
          min: { type: 'number' },
          max: { type: 'number' },
          exclude: { type: 'boolean' },
          hideSpecials: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
  },
};
const SEARCH = { type: 'string', description: 'Keep only records with a cell containing this text (case-insensitive; * and ? are wildcards).' };
const LIMIT = { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Records per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).` };
const PAGE = { type: 'integer', minimum: 0, description: 'Page number, from 0 (default 0).' };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'gdx_list_symbols',
    title: 'List GDX symbols',
    description:
      'Lists the symbols of a GAMS GDX file: name, type (e.g. Positive Variable, Singleton Set), dimension, domain, number of records and explanatory text, ' +
      'plus file information (producer, number of unique elements). Start here before reading records.',
    inputSchema: {
      type: 'object',
      properties: {
        file: FILE,
        name: { type: 'string', description: 'Only symbols whose name matches (case-insensitive; * and ? are wildcards).' },
        type: { type: 'string', enum: ['Set', 'Alias', 'Parameter', 'Variable', 'Equation'], description: 'Only symbols of this type.' },
      },
      required: ['file'],
      additionalProperties: false,
    },
  },
  {
    name: 'gdx_read_symbol',
    title: 'Read GDX symbol records',
    description:
      'Reads the records of a symbol of a GDX file as CSV with exact values, with optional filters, text search and sorting, one page at a time. ' +
      'Variables and equations have the fields Level, Marginal, Lower, Upper and Scale; by default fields that have their default value in every record are left out. ' +
      'Sets have a Text column with the element texts. Special values are written as Eps, NA, +Inf, -Inf and Undf.',
    inputSchema: {
      type: 'object',
      properties: {
        file: FILE,
        symbol: SYMBOL,
        filters: FILTERS,
        search: SEARCH,
        sortBy: { type: 'string', description: 'Column to sort by (default: the order of the GDX file).' },
        descending: { type: 'boolean', description: 'Sort in descending order.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Value columns to include, e.g. ["Level", "Marginal"] (default: all, see squeezeDefaults).' },
        squeezeDefaults: { type: 'boolean', description: 'Leave out variable/equation fields that have their default value in every record (default true).' },
        limit: LIMIT,
        page: PAGE,
      },
      required: ['file', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'gdx_symbol_stats',
    title: 'Summarize GDX symbol',
    description:
      'Summarizes the records of a symbol of a GDX file, optionally filtered: per dimension the number of distinct labels (and the first ones), ' +
      'per value column the count, sum, mean, min, max, number of zeros and counts of special values. Use it to check results without reading every record.',
    inputSchema: {
      type: 'object',
      properties: { file: FILE, symbol: SYMBOL, filters: FILTERS, search: SEARCH },
      required: ['file', 'symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'gdx_compare',
    title: 'Compare GDX files',
    description:
      'Compares two GDX files with gdxdiff. Without a symbol: lists the symbols that differ and how. With a symbol: its differing records as CSV, ' +
      'with the status (changed, only in file 1, only in file 2), the values of both files and their difference (Δ).',
    inputSchema: {
      type: 'object',
      properties: {
        file1: { ...FILE, description: 'Path of the first (reference) GDX file.' },
        file2: { ...FILE, description: 'Path of the second GDX file.' },
        symbol: { type: 'string', description: 'Show the differing records of this symbol.' },
        eps: { type: 'number', minimum: 0, description: 'Absolute tolerance for numbers.' },
        relEps: { type: 'number', minimum: 0, description: 'Relative tolerance for numbers.' },
        field: { type: 'string', enum: ['All', 'L', 'M', 'Lo', 'Up', 'Prior', 'Scale'], description: 'Compare only this field of variables and equations (default All).' },
        ignoreSetText: { type: 'boolean', description: 'Ignore the explanatory texts of set elements.' },
        compareDefaults: { type: 'boolean', description: 'Report default values (e.g. 0 for parameters) found in only one file as differences.' },
        filters: FILTERS,
        limit: LIMIT,
        page: PAGE,
      },
      required: ['file1', 'file2'],
      additionalProperties: false,
    },
  },
];

/** An error in the arguments of a tool call (reported to the agent as a tool error). */
export class QueryError extends Error {}

const TYPE_NAMES: Record<string, string> = { Set: 'Set', Par: 'Parameter', Var: 'Variable', Equ: 'Equation', Alias: 'Alias' };
const SUBTYPE_NAMES: Record<string, string> = { sos1: 'SOS1', sos2: 'SOS2', semicont: 'SemiCont', semiint: 'SemiInt' };
const FIELD_ALIASES: Record<string, string> = { l: 'level', m: 'marginal', lo: 'lower', up: 'upper', val: 'value' };

/** Type of a symbol as GAMS writes it, e.g. "Positive Variable". */
export function typeLabel(s: GdxSymbol): string {
  const base = TYPE_NAMES[s.type] ?? s.type;
  if (!s.subtype) return base;
  return `${SUBTYPE_NAMES[s.subtype] ?? s.subtype.charAt(0).toUpperCase() + s.subtype.slice(1)} ${base}`;
}

function signature(s: GdxSymbol): string {
  return s.dim && s.name !== UNIVERSE ? `${s.name}(${s.domain.join(',')})` : s.name;
}

function csvField(v: string): string {
  return /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(',');
}

function number(x: number | undefined): string {
  return x === undefined ? '' : x === 0 ? '0' : String(x);
}

function plural(n: number, what: string): string {
  return `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;
}

type FilterArg = string[] | { in?: string[]; notIn?: string[]; min?: number; max?: number; exclude?: boolean; hideSpecials?: boolean };

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: Promise<T>;
}

/** Answers the tool calls; keeps the most recently used files and symbols in memory. */
export class GdxQueries {
  private readonly files = new Map<string, Cached<GdxFileInfo>>();
  private readonly uels = new Map<string, Cached<string[]>>();
  private readonly views = new Map<string, Promise<TableView>>();
  private readonly diffs = new Map<string, Promise<{ diffFile: string; stdout: string; exitCode: number }>>();
  private workDir?: string;
  private diffCount = 0;

  constructor(
    private readonly tools: () => GdxTools,
    private readonly cwd = process.cwd(),
  ) {}

  /** Removes the difference files. */
  dispose() {
    if (this.workDir) {
      fs.rmSync(this.workDir, { recursive: true, force: true });
      this.workDir = undefined;
    }
  }

  /** Runs a tool; throws QueryError (or a tool error) with a message for the agent. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    switch (name) {
      case 'gdx_list_symbols':
        return this.listSymbols(args);
      case 'gdx_read_symbol':
        return this.readSymbol(args);
      case 'gdx_symbol_stats':
        return this.symbolStats(args);
      case 'gdx_compare':
        return this.compare(args);
    }
    throw new QueryError(`Unknown tool ${name}.`);
  }

  private file(arg: unknown, what = 'file'): { file: string; stat: fs.Stats } {
    if (typeof arg !== 'string' || !arg.trim()) {
      throw new QueryError(`The argument "${what}" (a GDX file path) is required.`);
    }
    const expanded = arg.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    const file = path.resolve(this.cwd, expanded);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new QueryError(`File not found: ${file}`);
    }
    if (!stat.isFile()) {
      throw new QueryError(`Not a file: ${file}`);
    }
    return { file, stat };
  }

  /** A cached value for a file, read again when the file changes. */
  private cached<T>(cache: Map<string, Cached<T>>, file: string, stat: fs.Stats, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      cache.delete(file);
      cache.set(file, hit);
      return hit.value;
    }
    const value = load();
    value.catch(() => cache.get(file)?.value === value && cache.delete(file));
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    while (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return value;
  }

  private info(file: string, stat: fs.Stats): Promise<GdxFileInfo> {
    return this.cached(this.files, file, stat, () => loadFileInfo(this.tools(), file));
  }

  private async symbol(file: string, stat: fs.Stats, name: unknown): Promise<GdxSymbol> {
    if (typeof name !== 'string' || !name.trim()) {
      throw new QueryError('The argument "symbol" is required.');
    }
    const info = await this.info(file, stat);
    if (name.trim() === UNIVERSE) {
      return universeSymbol(info.version);
    }
    const s = info.symbols.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!s) {
      throw new QueryError(`${path.basename(file)} has no symbol "${name}". Use gdx_list_symbols to see its ${plural(info.symbols.length, 'symbol')}.`);
    }
    return s;
  }

  private view(file: string, stat: fs.Stats, symbol: GdxSymbol): Promise<TableView> {
    const key = `${file}\0${stat.mtimeMs}\0${stat.size}\0${symbol.name}`;
    return cachedView(this.views, key, () => {
      const view =
        symbol.name === UNIVERSE
          ? this.cached(this.uels, file, stat, () => this.tools().dump(file, { uelTable: 'uels', noData: true }).then(parseUelTable)).then(
              (uels) => new TableView(universeTable(uels)),
            )
          : loadSymbolColumns(this.tools(), file, symbol).then(
              // Agents get set elements without text as empty cells (not "Y" as in the viewer).
              (data) => new TableView({ ...columnTable(data.columns, data.keyCount, data.store, symbol), setTexts: false }),
            );
      view.catch(() => this.views.get(key) === view && this.views.delete(key));
      return view;
    });
  }

  /** The column for a name: a column name, a 1-based dimension position or a field abbreviation (case-insensitive). */
  private column(view: TableView, name: string): number {
    const columns = view.table.columns;
    const wanted = name.trim().toLowerCase();
    const alias = FIELD_ALIASES[wanted];
    let c = columns.findIndex((col) => col.name.toLowerCase() === wanted || (alias !== undefined && col.name.toLowerCase() === alias));
    if (c < 0 && /^\d+$/.test(wanted)) {
      const keys = view.keyColumns;
      c = keys[Number(wanted) - 1] ?? -1;
    }
    if (c < 0) {
      throw new QueryError(`Unknown column "${name}". The columns are: ${columns.map((col) => col.name).join(', ')}.`);
    }
    return c;
  }

  private filters(view: TableView, arg: unknown): ColumnFilter[] {
    if (arg === undefined || arg === null) return [];
    if (typeof arg !== 'object' || Array.isArray(arg)) {
      throw new QueryError('"filters" must be an object mapping column names to filters.');
    }
    return Object.entries(arg as Record<string, FilterArg>).map(([name, f]): ColumnFilter => {
      const column = this.column(view, name);
      const isValue = view.table.columns[column].kind === 'value';
      if (Array.isArray(f) || (f && (f.in || f.notIn))) {
        if (isValue) {
          throw new QueryError(`"${name}" holds numbers: filter it with {"min": ..., "max": ...}.`);
        }
        const labels = Array.isArray(f) ? f : (f.in ?? f.notIn ?? []);
        return { type: 'labels', column, labels: labels.map(String), exclude: !Array.isArray(f) && !f.in, ignoreCase: true };
      }
      if (!f || typeof f !== 'object') {
        throw new QueryError(`Invalid filter for "${name}".`);
      }
      if (!isValue) {
        throw new QueryError(`"${name}" holds labels: filter it with a list of labels.`);
      }
      return {
        type: 'range',
        column,
        min: typeof f.min === 'number' ? f.min : undefined,
        max: typeof f.max === 'number' ? f.max : undefined,
        exclude: !!f.exclude,
        hideSpecials: f.hideSpecials ? ['eps', 'na', 'pinf', 'minf', 'undf'] : undefined,
      };
    });
  }

  private paging(args: Record<string, unknown>): { limit: number; page: number } {
    const limit = typeof args.limit === 'number' ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit))) : DEFAULT_LIMIT;
    const page = typeof args.page === 'number' ? Math.max(0, Math.floor(args.page)) : 0;
    return { limit, page };
  }

  private search(arg: unknown): string | undefined {
    return typeof arg === 'string' && arg.trim() ? arg : undefined;
  }

  private async listSymbols(args: Record<string, unknown>): Promise<string> {
    const { file, stat } = this.file(args.file);
    const info = await this.info(file, stat);
    const version = new Map(info.version);
    let symbols = info.symbols;
    if (typeof args.name === 'string' && args.name.trim()) {
      const rx = new RegExp(`^${args.name.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      symbols = symbols.filter((s) => rx.test(s.name));
    }
    if (typeof args.type === 'string' && args.type) {
      const t = args.type.toLowerCase();
      symbols = symbols.filter((s) => (TYPE_NAMES[s.type] ?? s.type).toLowerCase() === t);
    }
    const lines = [
      `File: ${file}`,
      `${plural(info.symbols.length, 'symbol')}, ${version.get('Unique Elements') ?? '?'} unique elements; producer: ${version.get('Producer') ?? 'unknown'}`,
    ];
    if (symbols.length !== info.symbols.length) {
      lines.push(`Matching: ${symbols.length}`);
    }
    lines.push(csvLine(['name', 'type', 'dim', 'domain', 'records', 'text']));
    for (const s of symbols) {
      lines.push(csvLine([s.name, typeLabel(s), String(s.dim), s.dim ? s.domain.join(',') : '', s.type === 'Alias' ? '' : String(s.records), s.text]));
    }
    return lines.join('\n');
  }

  private describe(s: GdxSymbol): string {
    return `${signature(s)}: ${typeLabel(s)}${s.text ? ` "${s.text}"` : ''}`;
  }

  private async readSymbol(args: Record<string, unknown>): Promise<string> {
    const { file, stat } = this.file(args.file);
    const symbol = await this.symbol(file, stat, args.symbol);
    const view = await this.view(file, stat, symbol);
    const { limit, page } = this.paging(args);
    const columns = view.table.columns;
    let hidden: number[] = [];
    if (Array.isArray(args.fields) && args.fields.length) {
      const keep = new Set(args.fields.map((f) => this.column(view, String(f))));
      hidden = columns.flatMap((c, i) => (c.kind !== 'key' && !keep.has(i) ? [i] : []));
    }
    const squeeze = args.squeezeDefaults !== false && !(Array.isArray(args.fields) && args.fields.length);
    const result = view.query({
      filter: this.search(args.search),
      columnFilters: this.filters(view, args.filters),
      sortColumn: typeof args.sortBy === 'string' ? this.column(view, args.sortBy) : undefined,
      sortDescending: !!args.descending,
      hidden,
      squeeze,
      page,
      pageSize: limit,
    });
    const lines = [`${this.describe(symbol)}`, this.range(result.offset, result.rows.length, result.filteredCount, result.totalCount)];
    const squeezed = squeeze ? view.squeezableColumns().filter((c) => !result.columnIndex.includes(c)) : [];
    if (squeezed.length) {
      const defaults = view.table.defaults ?? [];
      lines.push(`Left out (default value in every record): ${squeezed.map((c) => `${columns[c].name}=${defaults[c]}`).join(', ')}`);
    }
    lines.push(csvLine(result.columnIndex.map((c) => columns[c].name)));
    for (const row of result.rows) {
      lines.push(csvLine(row.cells));
    }
    if (result.offset + result.rows.length < result.filteredCount) {
      lines.push(`(more: page=${result.page + 1})`);
    }
    return lines.join('\n');
  }

  private range(offset: number, shown: number, filtered: number, total: number, what = 'record'): string {
    const of = filtered === total ? plural(total, what) : `${plural(filtered, `matching ${what}`)} (${total.toLocaleString('en-US')} in total)`;
    return shown ? `Rows ${offset + 1}-${offset + shown} of ${of}` : `No rows shown of ${of}`;
  }

  private async symbolStats(args: Record<string, unknown>): Promise<string> {
    const { file, stat } = this.file(args.file);
    const symbol = await this.symbol(file, stat, args.symbol);
    const view = await this.view(file, stat, symbol);
    const stats = view.stats({ filter: this.search(args.search), columnFilters: this.filters(view, args.filters) });
    const lines = [this.describe(symbol), `${plural(stats.rows, 'record')}${stats.rows === view.length ? '' : ` match (${view.length.toLocaleString('en-US')} in total)`}`];
    const labels = stats.columns.filter((c) => c.kind !== 'value');
    const values = stats.columns.filter((c) => c.kind === 'value');
    if (labels.length) {
      lines.push('', csvLine(['column', 'distinct labels', 'first labels']));
      for (const c of labels) {
        const more = (c.distinct ?? 0) > (c.labels?.length ?? 0) ? ' ...' : '';
        lines.push(csvLine([c.name, String(c.distinct), (c.labels ?? []).join(' | ') + more]));
      }
    }
    if (values.length) {
      lines.push('', csvLine(['column', 'numbers', 'sum', 'mean', 'min', 'max', 'zeros', 'special values']));
      for (const c of values) {
        lines.push(csvLine([c.name, String(c.count), c.count ? number(c.sum) : '', c.count ? number((c.sum ?? 0) / c.count) : '', number(c.min), number(c.max), String(c.zeros), specialsText(c)]));
      }
    }
    return lines.join('\n');
  }

  private async compare(args: Record<string, unknown>): Promise<string> {
    const a = this.file(args.file1, 'file1');
    const b = this.file(args.file2, 'file2');
    const options: DiffOptions = {
      eps: typeof args.eps === 'number' ? args.eps : undefined,
      relEps: typeof args.relEps === 'number' ? args.relEps : undefined,
      field: typeof args.field === 'string' ? args.field : undefined,
      ignoreSetText: !!args.ignoreSetText,
      compareDefaults: !!args.compareDefaults,
    };
    const tools = this.tools();
    const key = JSON.stringify([a.file, a.stat.mtimeMs, a.stat.size, b.file, b.stat.mtimeMs, b.stat.size, options]);
    let run = this.diffs.get(key);
    if (!run) {
      this.workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-query-'));
      const diffFile = path.join(this.workDir, `diff${++this.diffCount}.gdx`);
      run = tools.diff(a.file, b.file, diffFile, options).then((r) => ({ diffFile, stdout: r.stdout, exitCode: r.exitCode }));
      run.catch(() => this.diffs.delete(key));
      this.diffs.set(key, run);
      while (this.diffs.size > 4) {
        const oldest = this.diffs.keys().next().value as string;
        this.diffs.get(oldest)?.then((d) => fs.rmSync(d.diffFile, { force: true }), () => {});
        this.diffs.delete(oldest);
      }
    }
    const diff = await run;
    const summary = parseDiffOutput(diff.stdout);
    const header = `Compared ${a.file} (file 1) with ${b.file} (file 2)`;
    if (summary.identical || diff.exitCode === 0) {
      return `${header}: no differences.`;
    }
    const [info1, info2] = await Promise.all([this.info(a.file, a.stat), this.info(b.file, b.stat)]);
    const find = (list: GdxSymbol[], name: string) => list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (typeof args.symbol !== 'string' || !args.symbol.trim()) {
      const lines = [`${header}: ${plural(summary.entries.length, 'symbol')} differ.`, csvLine(['symbol', 'type', 'dim', 'status'])];
      for (const e of summary.entries) {
        const s = find(info1.symbols, e.symbol) ?? find(info2.symbols, e.symbol);
        lines.push(csvLine([e.symbol, s ? typeLabel(s) : '', s ? String(s.dim) : '', e.status]));
      }
      lines.push(...summary.messages.map((m) => `Note: ${m}`));
      lines.push('Call gdx_compare with "symbol" for the differing records of a symbol.');
      return lines.join('\n');
    }
    const name = args.symbol.trim();
    const entry = summary.entries.find((e) => e.symbol.toLowerCase() === name.toLowerCase());
    if (!entry) {
      const known = find(info1.symbols, name) ?? find(info2.symbols, name);
      return known ? `${header}: ${known.name} does not differ.` : `${header}: neither file has a symbol "${name}".`;
    }
    const diffStat = fs.statSync(diff.diffFile);
    const diffSymbol = find(await this.cached(this.files, diff.diffFile, diffStat, () => loadFileInfo(tools, diff.diffFile)).then((i) => i.symbols), name);
    if (!diffSymbol) {
      return `${header}: ${entry.symbol}: ${entry.status} (gdxdiff reports no records for it).`;
    }
    const original = find(info1.symbols, name) ?? find(info2.symbols, name);
    const dim = original?.dim ?? diffSymbol.dim - 1;
    const domains = new Map([...parseDomainInfo(await tools.dump(a.file, { domainInfo: true }))].map(([k, v]) => [k, v.domain]));
    const known = domains.get(name.toLowerCase());
    const domain = known && known.length === dim ? known : Array<string>(dim).fill('*');
    const viewKey = `${diff.diffFile}\0${diffStat.mtimeMs}\0${diffSymbol.name}`;
    const view = await cachedView(this.views, viewKey, () => {
      const v = loadSymbolColumns(tools, diff.diffFile, { ...diffSymbol, domain: [...domain, ...(diffSymbol.dim - domain.length === 2 ? ['Field'] : []), '*'] }).then(
        (data) => new TableView(diffColumnTable(data)),
      );
      v.catch(() => this.views.get(viewKey) === v && this.views.delete(viewKey));
      return v;
    });
    const { limit, page } = this.paging(args);
    const result = view.query({ columnFilters: this.filters(view, args.filters), page, pageSize: limit });
    const lines = [
      `${header}`,
      `${original ? this.describe(original) : entry.symbol}: ${entry.status}`,
      this.range(result.offset, result.rows.length, result.filteredCount, result.totalCount, 'differing record'),
      csvLine(result.columnIndex.map((c) => view.table.columns[c].name)),
      ...result.rows.map((r) => csvLine(r.cells)),
    ];
    if (result.offset + result.rows.length < result.filteredCount) {
      lines.push(`(more: page=${result.page + 1})`);
    }
    return lines.join('\n');
  }
}

function specialsText(c: ColumnStats): string {
  return Object.entries(c.specials ?? {})
    .map(([k, n]) => `${k}: ${n}`)
    .join('; ');
}
