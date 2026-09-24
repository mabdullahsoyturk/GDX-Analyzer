import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dumpUri } from './dump';
import { DiffSummary, GdxSymbol, parseDiffOutput, parseDomainInfo, parseSymbols } from './parse';
import { GdxService, describeTools, errorMessage } from './service';
import { TableView, cachedView, diffColumnTable } from './table';
import { CopyRequest, ImageMessage, SelectionRequest, SelectionTracker, WebviewQuery, answerColumnValues, answerQuery, copyToClipboard, pageSize, saveChartImage } from './tableHost';
import { DiffOptions } from './tools';
import { PROTOCOL, webviewHtml } from './webview';

export interface DiffEntry {
  name: string;
  status: string;
  type?: string;
  dim?: number;
  text?: string;
  /** Number of records in the difference file; undefined if gdxdiff wrote no data for it. */
  diffRecords?: number;
  inBoth: boolean;
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'query'; name: string; query: WebviewQuery }
  | { type: 'columnValues'; name: string; column: number }
  | CopyRequest
  | SelectionRequest
  | ImageMessage
  | { type: 'action'; action: 'textDiff'; name?: string }
  | { type: 'action'; action: 'rerun' | 'swap' | 'openDiffFile' | 'saveDiffFile' | 'open1' | 'open2' | 'cancel' | 'resetOptions' }
  | { type: 'options'; options: DiffOptions };

export function diffOptionsFromSettings(): DiffOptions {
  const cfg = vscode.workspace.getConfiguration('gdxAnalyzer.diff');
  return {
    eps: cfg.get<number>('eps', 0),
    relEps: cfg.get<number>('relEps', 0),
    field: cfg.get<string>('field', 'All'),
    compareDomains: cfg.get<boolean>('compareDomains', false),
    compareDefaults: cfg.get<boolean>('compareDefaults', false),
    ignoreOrder: cfg.get<boolean>('ignoreOrder', false),
    ignoreSetText: cfg.get<boolean>('ignoreSetText', false),
  };
}

/** Removes difference files of earlier sessions. */
export async function cleanupDiffStorage(storage: vscode.Uri) {
  const dir = path.join(storage.fsPath, 'diffs');
  const cutoff = Date.now() - 24 * 3600 * 1000;
  try {
    for (const name of await fs.promises.readdir(dir)) {
      const p = path.join(dir, name);
      const stat = await fs.promises.stat(p);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(p, { recursive: true, force: true });
      }
    }
  } catch {
    // Nothing to clean up.
  }
}

export class DiffPanel implements vscode.Disposable {
  private static readonly panels = new Set<DiffPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workDir: string;
  private readonly diffFile: string;
  private views = new Map<string, Promise<TableView>>();
  private symbols1: GdxSymbol[] = [];
  private symbols2: GdxSymbol[] = [];
  private diffSymbols: GdxSymbol[] = [];
  private generation = 0;
  /** Options of this comparison: the settings until changed in the panel. */
  private options?: DiffOptions;
  private abort?: AbortController;
  private readonly selection: SelectionTracker;

  static show(extensionUri: vscode.Uri, storage: vscode.Uri, service: GdxService, file1: string, file2: string) {
    for (const p of DiffPanel.panels) {
      if (p.file1 === file1 && p.file2 === file2) {
        p.panel.reveal();
        p.run();
        return;
      }
    }
    DiffPanel.panels.add(new DiffPanel(extensionUri, storage, service, file1, file2));
  }

  private constructor(
    extensionUri: vscode.Uri,
    storage: vscode.Uri,
    private readonly service: GdxService,
    private file1: string,
    private file2: string,
  ) {
    this.workDir = path.join(storage.fsPath, 'diffs', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.diffFile = path.join(this.workDir, 'diff.gdx');
    this.panel = vscode.window.createWebviewPanel('gdxAnalyzer.diff', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, 'diff.js', this.title());
    this.selection = new SelectionTracker(service.selectionStatus, this.panel);
    this.disposables.push(
      this.selection,
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Pages are formatted by the extension: ask the webview for the current page again.
        if (e.affectsConfiguration('gdxAnalyzer.numberFormat') || e.affectsConfiguration('gdxAnalyzer.squeezeDefaults') || e.affectsConfiguration('gdxAnalyzer.maxRowsPerPage') || e.affectsConfiguration('gdxAnalyzer.maxColumnsPerPage')) {
          this.panel.webview.postMessage({ type: 'requery' });
        }
        if (e.affectsConfiguration('gdxAnalyzer.encoding')) {
          // The labels are read again with the new encoding.
          this.views = new Map();
          this.panel.webview.postMessage({ type: 'requery' });
        }
      }),
    );
  }

  dispose() {
    this.abort?.abort();
    DiffPanel.panels.delete(this);
    this.disposables.forEach((d) => d.dispose());
    fs.promises.rm(this.workDir, { recursive: true, force: true }).catch(() => {});
  }

  private title() {
    return `${path.basename(this.file1)} ↔ ${path.basename(this.file2)}`;
  }

  private post(message: unknown) {
    this.panel.webview.postMessage(message);
  }

  async run() {
    const gen = ++this.generation;
    this.views = new Map();
    this.selection.reset();
    this.panel.title = this.title();
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const options = this.options ?? diffOptionsFromSettings();
    this.post({ type: 'running', file1: this.file1, file2: this.file2, options });
    try {
      const tools = this.service.tools();
      await fs.promises.mkdir(this.workDir, { recursive: true });
      await fs.promises.rm(this.diffFile, { force: true });
      const [result, symbols1, symbols2] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'gdxdiff' },
        () =>
          Promise.all([
            tools.diff(this.file1, this.file2, this.diffFile, options, { signal: abort.signal }),
            tools.dump(this.file1, { symbols: true }).then(parseSymbols),
            tools.dump(this.file2, { symbols: true }).then(parseSymbols),
          ]),
      );
      const summary = parseDiffOutput(result.stdout);
      const diffSymbols =
        result.exitCode === 1 && fs.existsSync(this.diffFile) ? parseSymbols(await tools.dump(this.diffFile, { symbols: true })) : [];
      if (gen !== this.generation) {
        return;
      }
      this.symbols1 = symbols1;
      this.symbols2 = symbols2;
      this.diffSymbols = diffSymbols;
      this.post({
        type: 'result',
        protocol: PROTOCOL,
        file1: this.file1,
        file2: this.file2,
        tools: describeTools(tools.tools),
        identical: summary.identical || result.exitCode === 0,
        entries: this.entries(summary),
        messages: summary.messages,
        options,
        customOptions: !!this.options,
        pageSize: pageSize(),
      });
    } catch (err) {
      if (abort.signal.aborted) {
        if (gen === this.generation) {
          this.post({ type: 'error', message: 'The comparison was cancelled.', cancelled: true });
        }
      } else if (gen === this.generation) {
        this.service.log(`Error comparing ${this.file1} and ${this.file2}: ${errorMessage(err)}`);
        this.post({ type: 'error', message: errorMessage(err) });
      }
    }
  }

  private entries(summary: DiffSummary): DiffEntry[] {
    const find = (list: GdxSymbol[], name: string) => list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    return summary.entries.map((e) => {
      const s1 = find(this.symbols1, e.symbol);
      const s2 = find(this.symbols2, e.symbol);
      const s = s1 ?? s2;
      return {
        name: e.symbol,
        status: e.status,
        type: s?.type,
        dim: s?.dim,
        text: s?.text,
        diffRecords: find(this.diffSymbols, e.symbol)?.records,
        inBoth: !!s1 && !!s2,
      };
    });
  }

  private view(name: string): Promise<TableView> {
    const diffSymbol = this.diffSymbols.find((s) => s.name === name);
    if (!diffSymbol) {
      return Promise.reject(new Error(`gdxdiff wrote no records for ${name}.`));
    }
    // Only the most recently used symbols stay in memory.
    return cachedView(this.views, name, () => {
      // Use the domain names of the compared files for the key columns.
      const original = this.symbols1.find((s) => s.name.toLowerCase() === name.toLowerCase());
      const view = this.domainOf(name, original?.dim ?? diffSymbol.dim - 1)
        // DiffOnly adds the field as a dimension before the dif1/dif2/ins1/ins2 label.
        .then((domain) =>
          // Streamed into compact columns: a comparison may have millions of differences.
          this.service.loadSymbolColumns(this.diffFile, { ...diffSymbol, domain: [...domain, ...(diffSymbol.dim - domain.length === 2 ? ['Field'] : []), '*'] }),
        )
        .then((data) => new TableView(diffColumnTable(data)));
      view.catch(() => this.views.delete(name));
      return view;
    });
  }

  private domainCache?: Promise<Map<string, string[]>>;

  private async domainOf(name: string, dim: number): Promise<string[]> {
    if (!this.domainCache) {
      this.domainCache = this.service
        .tools()
        .dump(this.file1, { domainInfo: true })
        .then((t) => new Map([...parseDomainInfo(t)].map(([k, v]) => [k, v.domain])))
        .catch(() => new Map());
    }
    const domain = (await this.domainCache).get(name.toLowerCase());
    return domain && domain.length === dim ? domain : Array(dim).fill('*');
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        return this.run();
      case 'options':
        this.options = m.options;
        return this.run();
      case 'query': {
        const gen = this.generation;
        try {
          const view = await this.view(m.name);
          if (gen === this.generation) {
            // The difference view has a list and a chart view, but no table view.
            const query = m.query.view === 'chart' ? m.query : { ...m.query, view: 'list' as const };
            this.post({ type: 'page', name: m.name, page: answerQuery(view, query) });
          }
        } catch (err) {
          if (gen === this.generation) {
            this.post({ type: 'symbolError', name: m.name, message: errorMessage(err) });
          }
        }
        return;
      }
      case 'columnValues': {
        const gen = this.generation;
        try {
          const view = await this.view(m.name);
          if (gen === this.generation) {
            this.post({ type: 'columnValues', name: m.name, ...answerColumnValues(view, m.column) });
          }
        } catch (err) {
          if (gen === this.generation) {
            this.post({ type: 'symbolError', name: m.name, message: errorMessage(err) });
          }
        }
        return;
      }
      case 'action':
        switch (m.action) {
          case 'rerun':
            return this.run();
          case 'cancel':
            this.abort?.abort();
            return;
          case 'resetOptions':
            this.options = undefined;
            return this.run();
          case 'swap':
            [this.file1, this.file2] = [this.file2, this.file1];
            this.domainCache = undefined;
            return this.run();
          case 'open1':
            return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(this.file1), 'gdxAnalyzer.viewer');
          case 'open2':
            return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(this.file2), 'gdxAnalyzer.viewer');
          case 'openDiffFile':
            return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(this.diffFile), 'gdxAnalyzer.viewer');
          case 'saveDiffFile': {
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(path.dirname(this.file1), 'diff.gdx')),
              filters: { 'GDX files': ['gdx'] },
            });
            if (target) {
              try {
                await fs.promises.copyFile(this.diffFile, target.fsPath);
              } catch (err) {
                this.service.showError('Saving the difference file failed', err);
              }
            }
            return;
          }
          case 'textDiff': {
            const left = dumpUri(this.file1, m.name);
            const right = dumpUri(this.file2, m.name);
            const what = m.name ? `${m.name}: ` : '';
            return vscode.commands.executeCommand(
              'vscode.diff',
              left,
              right,
              `${what}${path.basename(this.file1)} ↔ ${path.basename(this.file2)} (gdxdump)`,
            );
          }
        }
        return;
      case 'image': {
        const name = (f: string) => path.basename(f).replace(/\.gdx$/i, '');
        return saveChartImage(m, path.join(path.dirname(this.file1), `${name(this.file1)}_vs_${name(this.file2)}_${m.name}`), (err) => this.service.showError('Saving the chart image failed', err));
      }
      case 'selection':
        // The difference view has no table view.
        return this.selection.update({ ...m, query: { ...m.query, view: 'list' } }, () => this.view(m.name));
      case 'copy':
        try {
          // The difference view has no table view.
          await copyToClipboard(await this.view(m.name), { ...m, query: { ...m.query, view: 'list' } });
        } catch (err) {
          this.service.showError(`Copying ${m.name} failed`, err);
        }
        return;
    }
  }
}
