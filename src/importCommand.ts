/**
 * GDX: Create GDX from CSV/Excel…: asks how the columns of a CSV file or an Excel sheet make a
 * symbol (see gdxImport.ts) and writes it as a GDX file.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { ImportError, cellValue, isIdentifier, parseCsv, tableToGdx } from './gdxImport';
import { textDecoder } from './encoding';
import { readXlsx } from './xlsxRead';

/** Files that can be read as tables. */
export const TABLE_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'xlsm'];

/** Up to three different values of a column, as a preview. */
function sample(rows: string[][], c: number): string {
  const seen: string[] = [];
  for (const row of rows) {
    const v = (row[c] ?? '').trim();
    if (v && !seen.includes(v)) seen.push(v);
    if (seen.length > 3) break;
  }
  return seen.length > 3 ? `${seen.slice(0, 3).join(', ')}, …` : seen.join(', ');
}

/** A GAMS name made from a file or sheet name. */
function symbolName(s: string): string {
  const n = s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return (n || 'data').slice(0, 63);
}

/** Text of a CSV file: UTF-8, or Windows-1252 (Latin-1) if it is not valid UTF-8. */
function decode(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return textDecoder('windows-1252').decode(buf);
  }
}

/** How labels are written: as the setting gdxAnalyzer.encoding reads them back. */
function labelEncoding(): 'utf-8' | 'latin1' {
  const e = vscode.workspace.getConfiguration('gdxAnalyzer').get<string>('encoding', 'utf-8').trim().toLowerCase();
  return ['latin1', 'latin-1', 'iso-8859-1', 'iso8859-1', 'windows-1252', 'cp1252'].includes(e) ? 'latin1' : 'utf-8';
}

export async function createGdxFromTable(arg?: unknown): Promise<void> {
  let source = arg instanceof vscode.Uri ? arg : undefined;
  if (!source) {
    const picked = await vscode.window.showOpenDialog({ title: 'Create GDX from CSV/Excel', canSelectMany: false, filters: { 'CSV files and Excel workbooks': TABLE_EXTENSIONS } });
    source = picked?.[0];
  }
  if (!source) {
    return;
  }
  // The name of the file (for its extension and messages), whatever its file system.
  const file = path.posix.basename(source.path);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const buf = Buffer.from(await vscode.workspace.fs.readFile(source));
  const excel = /\.xls[xm]$/i.test(file);
  let table: string[][];
  let decimalComma = false;
  let name = base;
  if (excel) {
    const book = readXlsx(buf);
    if (!book.sheets.length) throw new Error('The workbook has no sheets.');
    let sheet = book.sheets[0];
    if (book.sheets.length > 1) {
      const pick = await vscode.window.showQuickPick(book.sheets, { title: `Sheet of ${path.basename(file)}` });
      if (!pick) return;
      sheet = pick;
      name = sheet;
    }
    table = book.rows(sheet);
  } else {
    const csv = parseCsv(decode(buf), /\.tsv$/i.test(file) ? '\t' : undefined);
    table = csv.rows;
    // Semicolon separated files usually have a decimal comma.
    decimalComma = csv.separator === ';';
  }
  if (!table.length) throw new Error(`${path.basename(file)} has no data.`);
  const width = Math.max(...table.map((r) => r.length));

  // The column names: the first row, or numbers.
  const first = table[0].map((v) => v.trim());
  const preview = (row: string[]) => row.slice(0, 6).join(', ') + (row.length > 6 ? ', …' : '');
  const header = await vscode.window.showQuickPick(
    [
      { label: 'The first row holds the column names', detail: preview(first), named: true },
      { label: 'The first row is data', detail: 'The columns are named 1, 2, 3, …', named: false },
    ],
    { title: 'Column Names' },
  );
  if (!header) return;
  const names = Array.from({ length: width }, (_, c) => (header.named ? first[c] || `${c + 1}` : `${c + 1}`));
  const rows = header.named ? table.slice(1) : table;

  // The columns with labels: by default all but the last (as csv2gdx).
  const columnItems = names.map((n, c) => ({ label: n, description: sample(rows, c), column: c, picked: c < width - 1 || width === 1 }));
  const index = await vscode.window.showQuickPick(columnItems, {
    title: 'Columns with Labels (the dimensions of the symbol)',
    placeHolder: 'The other columns hold the values (several: an extra dimension named after them)',
    canPickMany: true,
  });
  if (!index) return;
  const indexColumns = index.map((i) => i.column).sort((a, b) => a - b);
  const others = names.map((_, c) => c).filter((c) => !indexColumns.includes(c));

  // A parameter of the other columns, or a set (with the element texts of a single other column).
  let type: 'parameter' | 'set' = 'set';
  let valueColumns: number[] = [];
  if (others.length) {
    const numeric = others.every((c) => rows.every((r) => (r[c] ?? '').trim() === '' || cellValue(r[c], decimalComma) !== undefined));
    const otherNames = others.map((c) => names[c]).join(', ');
    const parameter = { label: 'Parameter', detail: others.length > 1 ? `Values of ${otherNames}, whose names become the labels of the last dimension` : `Values of ${otherNames}`, symbolType: 'parameter' as const };
    const set = { label: 'Set', detail: others.length === 1 ? `Element texts from ${otherNames}` : `Without element texts (${otherNames} left out)`, symbolType: 'set' as const };
    const choice = await vscode.window.showQuickPick(numeric ? [parameter, set] : [set, parameter], { title: 'Symbol Type' });
    if (!choice) return;
    type = choice.symbolType;
    valueColumns = type === 'parameter' || others.length === 1 ? others : [];
  }

  const symbol = await vscode.window.showInputBox({
    title: 'Name of the Symbol',
    value: symbolName(name),
    validateInput: (v) => (isIdentifier(v.trim()) ? undefined : 'A letter, then letters, digits or _, at most 63 characters'),
  });
  if (!symbol) return;

  let result: ReturnType<typeof tableToGdx>;
  try {
    result = tableToGdx({
      name: symbol.trim(),
      header: names,
      rows,
      firstRow: header.named ? 2 : 1,
      indexColumns,
      valueColumns,
      type,
      decimalComma,
      encoding: labelEncoding(),
    });
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    // Errors in the table: the rows to fix (several lines).
    vscode.window.showErrorMessage(`${path.basename(file)} cannot be written as GDX`, { modal: true, detail: err.message });
    return;
  }
  const target = await vscode.window.showSaveDialog({
    title: 'Save GDX File',
    defaultUri: vscode.Uri.joinPath(source, '..', `${base}.gdx`),
    filters: { 'GDX files': ['gdx'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, result.data);
  const what = `${type === 'set' ? 'Set' : 'Parameter'} ${symbol.trim()} with ${result.records.toLocaleString()} record${result.records === 1 ? '' : 's'}`;
  const skipped = result.skipped ? ` (${result.skipped.toLocaleString()} empty cell${result.skipped === 1 ? '' : 's'} left out)` : '';
  const choice = await vscode.window.showInformationMessage(`Created ${path.posix.basename(target.path)}: ${what}${skipped}.`, 'Open');
  if (choice) {
    await vscode.commands.executeCommand('vscode.openWith', target, 'gdxAnalyzer.viewer');
  }
}

