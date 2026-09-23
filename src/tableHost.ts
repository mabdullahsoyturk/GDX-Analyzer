import * as vscode from 'vscode';
import { NumberFormat, NumberStyle, normalizeFormat } from './format';
import { CopyRequest, QueryAnswer, WebviewQuery, answerQuery as answer, copyText } from './query';
import { ColumnValues, TableView } from './table';

export type { CopyRequest, WebviewQuery } from './query';

export function pageSize(): number {
  return Math.max(50, vscode.workspace.getConfiguration('gdx').get<number>('maxRowsPerPage', 500));
}

export function colPageSize(): number {
  return Math.max(10, vscode.workspace.getConfiguration('gdx').get<number>('maxColumnsPerPage', 100));
}

/** The default number format from the settings gdx.numberFormat.*. */
export function defaultFormat(): NumberFormat {
  const cfg = vscode.workspace.getConfiguration('gdx.numberFormat');
  return normalizeFormat({
    style: cfg.get<NumberStyle>('style', 'g'),
    precision: cfg.get<boolean>('fullPrecision', false) ? 'full' : cfg.get<number>('precision', 6),
    squeeze: cfg.get<boolean>('squeezeTrailingZeros', true),
  });
}

/** Setting gdx.squeezeDefaults. */
export function squeezeDefaults(): boolean {
  return vscode.workspace.getConfiguration('gdx').get<boolean>('squeezeDefaults', false);
}

/** A page of the list or table view, with the page sizes and number format from the settings. */
export function answerQuery(view: TableView, q: WebviewQuery): QueryAnswer {
  return answer(view, q, { pageSize: pageSize(), colPageSize: colPageSize(), defaultFormat: defaultFormat(), squeezeDefaults: squeezeDefaults() });
}

export function answerColumnValues(view: TableView, column: number): ColumnValues {
  return view.columnValues(column);
}

/** The decimal separator for copied numbers (setting gdx.copy.decimalSeparator). */
export function copyDecimalSeparator(): string {
  const cfg = vscode.workspace.getConfiguration('gdx.copy');
  switch (cfg.get<string>('decimalSeparator', 'period')) {
    case 'system':
      return new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
    case 'custom':
      return cfg.get<string>('customDecimalSeparator', ',') || '.';
    default:
      return '.';
  }
}

/** Copies cells of the current view to the clipboard, with exact values; returns the number of cells. */
export async function copyToClipboard(view: TableView, req: CopyRequest): Promise<number> {
  const result = copyText(view, req, defaultFormat(), copyDecimalSeparator(), squeezeDefaults());
  await vscode.env.clipboard.writeText(result.text);
  vscode.window.setStatusBarMessage(`Copied ${result.cells.toLocaleString()} cell${result.cells === 1 ? '' : 's'} of ${req.name}`, 3000);
  return result.cells;
}
