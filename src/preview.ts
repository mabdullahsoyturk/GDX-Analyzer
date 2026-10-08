/**
 * Hover previews of GDX files and symbols in GAMS and Python source (see hovers.ts), as
 * Markdown: a symbol's declaration, its first records, a summary of its values and, for
 * variables and equations, its solution status; or the symbols of a file.
 *
 * No dependency on `vscode`.
 */
import { numberText } from './columns';
import { NumberFormat, formatNumber } from './format';
import type { GdxFileInfo } from './gdxFile';
import { typeLabel } from './parse';
import type { GdxSymbol } from './parse';
import { ColumnStats, SolutionFilter, TableView, UNIVERSE } from './table';

/** Records shown in a preview (hovers are at most about 250 pixels high, then they scroll). */
export const PREVIEW_ROWS = 5;
/** Value columns shown in a preview (the first ones not squeezed). */
export const PREVIEW_VALUE_COLUMNS = 4;
/** Symbols with more records are previewed without their records (reading them would delay the hover). */
export const MAX_PREVIEW_RECORDS = 200_000;

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, what: string) => `${count(n)} ${what}${n === 1 ? '' : 's'}`;

/** Escapes the characters Markdown would interpret in labels, texts and numbers (also | in tables). */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_[\]<>|~#]/g, '\\$&');
}

function signature(s: GdxSymbol): string {
  return s.dim && s.name !== UNIVERSE ? `${s.name}(${s.domain.join(',')})` : s.name;
}

const SOLUTION_LABELS: Record<SolutionFilter, string> = {
  infeasible: 'outside bounds',
  marginal: 'non-zero marginal',
  atLower: 'at lower bound',
  atUpper: 'at upper bound',
  nonDefault: 'non-default',
};

/**
 * The preview of a symbol of the GDX file `fileName`; `view` holds its records (undefined:
 * not read, e.g. too many). Numbers are shown in `format`; `actions` (Markdown links) end the first line.
 */
export function symbolPreview(symbol: GdxSymbol, fileName: string, view: TableView | undefined, format: NumberFormat, actions?: string): string {
  const records = view ? view.length : symbol.records;
  const head = [`**${escapeMarkdown(signature(symbol))}**`, symbol.name === UNIVERSE ? 'Universe' : typeLabel(symbol)];
  if (symbol.type !== 'Alias') head.push(plural(records, symbol.name === UNIVERSE ? 'label' : 'record'));
  head.push(`\`${fileName.replace(/`/g, "'")}\``);
  if (actions) head.push(actions);
  const parts = [head.join(' · ')];
  if (symbol.text) parts.push(escapeMarkdown(symbol.text));
  if (!view) {
    if (symbol.records > MAX_PREVIEW_RECORDS) parts.push(`Too many records to preview here: open the symbol in GDX Analyzer.`);
    return parts.join('\n\n');
  }
  if (!view.length) {
    return parts.join('\n\n');
  }
  const columns = view.table.columns;
  const show = (v: string) => escapeMarkdown(formatNumber(v, format));
  const stats = view.stats({});
  // Set element texts only if any element has one.
  const emptyTexts = stats.columns.filter((c) => c.kind === 'text' && c.distinct === 1 && c.labels?.[0] === '').map((c) => c.column);
  // Before the records (hovers scroll): records outside their bounds first, they make a solution infeasible.
  const order: SolutionFilter[] = ['infeasible', 'marginal', 'atLower', 'atUpper'];
  const solution = order.flatMap((filter) => view.solutionFilters().filter((f) => f.filter === filter));
  if (solution.length) {
    parts.push(
      'Solution: ' +
        solution.map(({ filter, count: n }) => (filter === 'infeasible' && n ? `**${plural(n, 'record')} ${SOLUTION_LABELS[filter]}**` : `${count(n)} ${SOLUTION_LABELS[filter]}`)).join(' · '),
    );
  }
  const page = view.query({ squeeze: true, pageSize: PREVIEW_ROWS, format });
  const keys = page.columnIndex.filter((c) => columns[c].kind === 'key');
  const values = page.columnIndex.filter((c) => columns[c].kind !== 'key' && !emptyTexts.includes(c));
  const shownValues = values.slice(0, PREVIEW_VALUE_COLUMNS);
  const shown = [...keys, ...shownValues];
  const cell = (row: { cells: string[] }, c: number) => escapeMarkdown(row.cells[page.columnIndex.indexOf(c)] ?? '');
  if (!keys.length) {
    // A scalar: its fields on one line.
    parts.push(shownValues.map((c) => `${escapeMarkdown(columns[c].name)} = ${cell(page.rows[0], c)}`).join(' · '));
  } else {
    const align = (c: number) => (columns[c].kind === 'value' ? '--:' : ':--');
    const table = [
      `| ${shown.map((c) => escapeMarkdown(columns[c].name)).join(' | ')} |`,
      `|${shown.map(align).join('|')}|`,
      ...page.rows.map((row) => `| ${shown.map((c) => cell(row, c)).join(' | ')} |`),
    ];
    parts.push(table.join('\n'));
    if (view.length > page.rows.length) parts.push(`First ${count(page.rows.length)} of ${plural(view.length, 'record')}`);
  }
  if (values.length > shownValues.length) {
    parts.push(`Not shown: ${values.slice(shownValues.length).map((c) => escapeMarkdown(columns[c].name)).join(', ')}`);
  }
  // The values of all records (the table shows only the first ones).
  if (keys.length && view.length > page.rows.length) {
    const summary = stats.columns.filter((c) => shownValues.includes(c.column) && c.kind === 'value').map((c) => valueSummary(c, show));
    if (summary.length) parts.push(summary.join('  \n'));
  }
  const squeezed = view.squeezableColumns().filter((c) => !page.columnIndex.includes(c));
  if (squeezed.length) {
    const defaults = view.table.defaults ?? [];
    parts.push(`Default in every record: ${squeezed.map((c) => `${escapeMarkdown(columns[c].name)} = ${escapeMarkdown(defaults[c] ?? '')}`).join(', ')}`);
  }
  return parts.join('\n\n');
}

/** min, max and sum of the numbers of a value column, and its special values. */
function valueSummary(c: ColumnStats, show: (v: string) => string): string {
  const parts: string[] = [];
  if (c.count) {
    parts.push(`min ${show(numberText(c.min!))}`, `max ${show(numberText(c.max!))}`, `sum ${show(numberText(c.sum!))}`);
  }
  for (const [name, n] of Object.entries(c.specials ?? {})) {
    if (name !== 'empty' && name !== 'text') parts.push(`${count(n)} ${name}`);
  }
  return `${escapeMarkdown(c.name)}: ${parts.join(' · ') || 'no numbers'}`;
}

const TYPE_NAMES: [GdxSymbol['type'], string, string][] = [
  ['Set', 'set', 'sets'],
  ['Alias', 'alias', 'aliases'],
  ['Par', 'parameter', 'parameters'],
  ['Var', 'variable', 'variables'],
  ['Equ', 'equation', 'equations'],
];

/** The preview of a GDX file: its symbols by type, and who wrote it. */
export function filePreview(fileName: string, info: GdxFileInfo): string {
  const version = new Map(info.version.map(([k, v]) => [k.toLowerCase(), v]));
  const byType = TYPE_NAMES.flatMap(([type, one, many]) => {
    const n = info.symbols.filter((s) => s.type === type).length;
    return n ? [`${count(n)} ${n === 1 ? one : many}`] : [];
  });
  const parts = [`**${escapeMarkdown(fileName)}** · ${plural(info.symbols.length, 'symbol')}${byType.length ? `: ${byType.join(', ')}` : ''}`];
  const facts = [
    version.get('unique elements') !== undefined ? `${count(Number(version.get('unique elements')!.replace(/,/g, '')))} unique elements` : '',
    version.get('producer') ? `written by ${escapeMarkdown(version.get('producer')!)}` : '',
  ].filter(Boolean);
  if (facts.length) parts.push(facts.join(' · '));
  return parts.join('\n\n');
}
