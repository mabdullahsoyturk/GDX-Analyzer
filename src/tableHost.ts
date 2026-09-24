import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NumberFormat, NumberStyle, normalizeFormat } from './format';
import { CopyRequest, QueryAnswer, SelectionRequest, ShownStats, WebviewQuery, answerQuery as answer, copyText, selectionStats } from './query';
import { ColumnValues, TableView } from './table';

export type { CopyRequest, SelectionRequest, WebviewQuery } from './query';

export function pageSize(): number {
  return Math.max(50, vscode.workspace.getConfiguration('gdxAnalyzer').get<number>('maxRowsPerPage', 500));
}

export function colPageSize(): number {
  return Math.max(10, vscode.workspace.getConfiguration('gdxAnalyzer').get<number>('maxColumnsPerPage', 100));
}

/** The default number format from the settings gdxAnalyzer.numberFormat.*. */
export function defaultFormat(): NumberFormat {
  const cfg = vscode.workspace.getConfiguration('gdxAnalyzer.numberFormat');
  return normalizeFormat({
    style: cfg.get<NumberStyle>('style', 'g'),
    precision: cfg.get<boolean>('fullPrecision', false) ? 'full' : cfg.get<number>('precision', 6),
    squeeze: cfg.get<boolean>('squeezeTrailingZeros', true),
  });
}

/** Setting gdxAnalyzer.squeezeDefaults. */
export function squeezeDefaults(): boolean {
  return vscode.workspace.getConfiguration('gdxAnalyzer').get<boolean>('squeezeDefaults', false);
}

/** A page of the list or table view, with the page sizes and number format from the settings. */
export function answerQuery(view: TableView, q: WebviewQuery): QueryAnswer {
  return answer(view, q, { pageSize: pageSize(), colPageSize: colPageSize(), defaultFormat: defaultFormat(), squeezeDefaults: squeezeDefaults() });
}

export function answerColumnValues(view: TableView, column: number): ColumnValues {
  return view.columnValues(column);
}

/** The decimal separator for copied numbers (setting gdxAnalyzer.copy.decimalSeparator). */
export function copyDecimalSeparator(): string {
  const cfg = vscode.workspace.getConfiguration('gdxAnalyzer.copy');
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

/**
 * Shows a webview's cell selection statistics in the status bar while its panel is active:
 * the statistics are computed on the host (exact values, across pages) and re-shown when
 * the panel becomes active again.
 */
export class SelectionTracker implements vscode.Disposable {
  private last?: ShownStats;
  /** The last request, to compute the statistics again when the number format settings change. */
  private lastRequest?: { req: SelectionRequest; view: () => Promise<TableView> };
  private generation = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly status: { show(owner: object, stats: ShownStats | undefined): void; clear(owner: object): void },
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.disposables.push(
      panel.onDidChangeViewState(() => {
        if (!panel.visible && !panel.options.retainContextWhenHidden) {
          // The webview (and its selection) is discarded while hidden.
          this.reset();
        } else if (panel.active) {
          this.status.show(this, this.last);
        } else {
          this.status.clear(this);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (this.lastRequest && (e.affectsConfiguration('gdxAnalyzer.numberFormat') || e.affectsConfiguration('gdxAnalyzer.squeezeDefaults'))) {
          this.update(this.lastRequest.req, this.lastRequest.view);
        }
      }),
    );
  }

  dispose() {
    this.status.clear(this);
    this.disposables.forEach((d) => d.dispose());
  }

  /** Forgets the selection (e.g. when the file is read again). */
  reset() {
    this.generation++;
    this.last = undefined;
    this.lastRequest = undefined;
    this.status.clear(this);
  }

  async update(req: SelectionRequest, view: () => Promise<TableView>) {
    const gen = ++this.generation;
    this.lastRequest = req.selection ? { req, view } : undefined;
    let stats: ShownStats | undefined;
    if (req.selection) {
      try {
        const selection = req.selection;
        stats = selectionStats(await view(), { ...req, selection }, defaultFormat(), squeezeDefaults());
      } catch {
        stats = undefined; // e.g. the symbol could not be read: nothing to show
      }
    }
    if (gen !== this.generation) {
      return;
    }
    this.last = stats;
    if (this.panel.active) {
      this.status.show(this, stats);
    }
  }
}

/** A chart image made by a webview (PNG as base64, SVG as text), or a report on copying one. */
export type ImageMessage =
  | { type: 'image'; name: string; format: 'png' | 'svg'; data: string }
  | { type: 'image'; name: string; format: 'notice'; text: string; error?: boolean };

/** Saves a chart image where the user chooses (`base`: the suggested path without extension). */
export async function saveChartImage(m: ImageMessage, base: string, onError: (err: unknown) => void) {
  if (m.format === 'notice') {
    if (m.error) vscode.window.showErrorMessage(m.text);
    else vscode.window.setStatusBarMessage(m.text, 3000);
    return;
  }
  const dir = path.dirname(base);
  const target = await vscode.window.showSaveDialog({
    title: 'Save Chart Image',
    defaultUri: vscode.Uri.file(path.join(dir, `${path.basename(base).replace(/[^\w.-]/g, '_')}.${m.format}`)),
    filters: m.format === 'png' ? { 'PNG images': ['png'] } : { 'SVG images': ['svg'] },
  });
  if (!target) {
    return;
  }
  try {
    await fs.promises.writeFile(target.fsPath, m.format === 'png' ? Buffer.from(m.data, 'base64') : m.data);
    const choice = await vscode.window.showInformationMessage(`Saved the chart of ${m.name} as ${path.basename(target.fsPath)}.`, 'Open');
    if (choice) {
      await vscode.env.openExternal(target);
    }
  } catch (err) {
    onError(err);
  }
}
