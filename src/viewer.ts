import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GdxSymbol } from './parse';
import { GdxFileInfo, GdxService, errorMessage } from './service';
import { TableView, UNIVERSE, cachedView, columnTable, universeSymbol, universeTable } from './table';
import { CopyRequest, ImageMessage, SelectionRequest, SelectionTracker, WebviewQuery, answerColumnValues, answerQuery, copyToClipboard, defaultFormat, pageSize, saveChartImage, squeezeDefaults } from './tableHost';
import { ExportItem, ExportOptions, SymbolViewState, buildSheets, connectInstructions } from './export';
import { ViewStateStore } from './viewState';
import { writeXlsx } from './xlsx';
import { PROTOCOL, webviewHtml } from './webview';
import { CodeLanguage, symbolCode } from './codegen';
import { SolutionReport, showReport, solutionReport } from './solutionReport';

class GdxDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose() {}
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'saveState'; state: unknown }
  | { type: 'export'; mode: 'excel' | 'connect'; names: string[]; options: ExportOptions; states: Record<string, SymbolViewState> }
  | { type: 'query'; name: string; query: WebviewQuery }
  | { type: 'columnValues'; name: string; column: number }
  | { type: 'code'; name: string; language: CodeLanguage; target: 'clipboard' | 'editor'; state?: SymbolViewState }
  | { type: 'report'; refresh?: boolean }
  | CopyRequest
  | SelectionRequest
  | ImageMessage
  | { type: 'action'; action: 'dumpSymbol' | 'exportCsv'; name: string }
  | { type: 'action'; action: 'refresh' | 'dumpAll' | 'compare' | 'settings' | 'showLog' };

/** One open GDX viewer tab. */
class ViewerSession implements vscode.Disposable {
  private info?: GdxFileInfo;
  private readonly views = new Map<string, Promise<TableView>>();
  /** Unique elements in GDX order; loaded when first needed (table view, label filters). */
  private uels?: Promise<string[]>;
  private readonly ordered = new WeakSet<TableView>();
  private generation = 0;
  private reloadTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly selection: SelectionTracker;
  selectedSymbol?: string;
  private loaded!: Promise<void>;
  private markLoaded!: () => void;
  /** The webview has been sent the file (it is discarded while the tab is hidden and loads the file again). */
  private webviewHasFile = false;
  private pendingSymbol?: string;
  /** Show the solution report once the webview shows the file. */
  private pendingReport = false;
  /** The solution report of the file as read (computed when first asked for). */
  private report?: Promise<SolutionReport>;
  private reportAbort?: AbortController;

  constructor(
    private readonly service: GdxService,
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly states: ViewStateStore,
    /** The file of another file system (e.g. git:) whose temporary copy `uri` is. */
    readonly copyOf?: vscode.Uri,
  ) {
    this.loaded = new Promise((resolve) => (this.markLoaded = resolve));
    this.selection = new SelectionTracker(service.selectionStatus, panel);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)),
    );
    this.disposables.push(
      this.selection,
      watcher,
      watcher.onDidChange(() => this.scheduleReload()),
      watcher.onDidCreate(() => this.scheduleReload()),
      watcher.onDidDelete(() => this.post({ type: 'fileError', message: 'The file has been deleted.' })),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      panel.onDidChangeViewState(() => {
        if (!panel.visible) this.webviewHasFile = false;
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Pages are formatted by the extension: ask the webview for the current page again.
        if (e.affectsConfiguration('gdxAnalyzer.numberFormat') || e.affectsConfiguration('gdxAnalyzer.squeezeDefaults') || e.affectsConfiguration('gdxAnalyzer.maxRowsPerPage') || e.affectsConfiguration('gdxAnalyzer.maxColumnsPerPage')) {
          panel.webview.postMessage({ type: 'requery' });
        }
        if (e.affectsConfiguration('gdxAnalyzer.encoding') || e.affectsConfiguration('gdxAnalyzer.reader')) {
          this.load();
        }
      }),
    );
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    this.reportAbort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  /** Resolves once the file has been read the first time: true if it could be read (the webview shows it). */
  whenLoaded(): Promise<boolean> {
    return this.loaded.then(() => !!this.info);
  }

  /** Whether the view of the file is remembered (not for temporary copies, whose paths change). */
  private remembered(): boolean {
    return rememberViews() && !this.copyOf;
  }

  /** The default path of a file saved from the viewer: next to the GDX file, for a copy in the workspace. */
  private savePath(name: string): string {
    const dir = this.copyOf ? (vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir()) : path.dirname(this.uri.fsPath);
    return path.join(dir, name);
  }

  /**
   * Shows the viewer tab at a symbol (matched case-insensitively, like GAMS names);
   * returns false if the file has no such symbol.
   */
  showSymbol(name: string): boolean {
    this.reveal();
    const wanted = name.toLowerCase();
    const symbol = name === UNIVERSE ? { name } : this.symbols.find((s) => s.name.toLowerCase() === wanted);
    if (symbol) {
      this.pendingSymbol = symbol.name;
      this.pendingReport = false;
      this.sendPending();
    }
    return !!symbol;
  }

  /** Shows the viewer tab with the solution report of the file. */
  showReport() {
    this.reveal();
    this.pendingReport = true;
    this.pendingSymbol = undefined;
    this.sendPending();
  }

  /** Selects the symbol asked for by showSymbol, or opens the report, once the webview shows the file. */
  private sendPending() {
    if (!this.webviewHasFile) {
      return;
    }
    if (this.pendingSymbol) {
      this.post({ type: 'selectSymbol', name: this.pendingSymbol });
      this.pendingSymbol = undefined;
    }
    if (this.pendingReport) {
      this.post({ type: 'showReport' });
      this.pendingReport = false;
    }
  }

  /** Sends the solution report of all variables and equations (see solutionReport.ts), with progress while it is computed. */
  private async sendReport(refresh?: boolean) {
    const info = this.info;
    if (!info) {
      return;
    }
    const gen = this.generation;
    if (refresh || !this.report) {
      this.reportAbort?.abort();
      const abort = (this.reportAbort = new AbortController());
      // In a promise: finding the tools may fail, which the report then shows.
      const report = Promise.resolve().then(() =>
        solutionReport(this.service.source(), this.uri.fsPath, info.symbols, {
          signal: abort.signal,
          // Symbols the viewer has in memory are not read again.
          cached: (symbol) => this.views.get(symbol.name),
          onProgress: (done, total) => !abort.signal.aborted && this.post({ type: 'reportProgress', done, total }),
        }),
      );
      report.catch(() => this.report === report && (this.report = undefined));
      this.report = report;
    }
    // Answers of reports that were replaced (by a refresh or a reload of the file) are dropped.
    const pending = this.report;
    try {
      const report = await pending;
      if (gen === this.generation && pending === this.report) {
        this.post({ type: 'report', report: showReport(report, defaultFormat()) });
      }
    } catch (err) {
      if (gen === this.generation && pending === this.report) {
        this.service.log(`Error in the solution report of ${this.uri.fsPath}: ${errorMessage(err)}`);
        this.post({ type: 'reportError', message: errorMessage(err) });
      }
    }
  }

  reveal() {
    this.panel.reveal();
  }

  /** Opens the export dialog of the webview. */
  openExport() {
    this.panel.reveal();
    this.post({ type: 'openExport' });
  }

  /** Writes the symbols to an Excel file, or the GAMS Connect instructions that do so. */
  private async export(mode: 'excel' | 'connect', names: string[], options: ExportOptions, states: Record<string, SymbolViewState>) {
    if (mode === 'connect' && this.copyOf) {
      vscode.window.showWarningMessage(`The GAMS Connect instructions would read a temporary copy of ${this.copyOf.toString(true)}: save the GDX file on disk first.`);
      return;
    }
    const base = this.savePath(path.basename(this.uri.fsPath)).replace(/\.gdx$/i, '');
    const target = await vscode.window.showSaveDialog({
      title: mode === 'excel' ? 'Export to Excel' : 'Save GAMS Connect Instructions',
      defaultUri: vscode.Uri.file(mode === 'excel' ? base + '.xlsx' : base + '_export.yaml'),
      filters: mode === 'excel' ? { 'Excel workbooks': ['xlsx'] } : { 'GAMS Connect instructions': ['yaml', 'yml'] },
    });
    if (!target) {
      return;
    }
    try {
      const items: ExportItem[] = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${names.length} symbol${names.length === 1 ? '' : 's'}` },
        async (progress) => {
          const result: ExportItem[] = [];
          for (const name of names) {
            const symbol = this.symbol(name);
            if (!symbol) {
              continue;
            }
            progress.report({ message: name, increment: 100 / names.length });
            // Labels in GDX order, as in the table view.
            result.push({ symbol, view: await this.orderedView(name), state: states[name] });
          }
          return result;
        },
      );
      const defaults = { format: defaultFormat(), squeezeDefaults: squeezeDefaults() };
      if (mode === 'excel') {
        await fs.promises.writeFile(target.fsPath, writeXlsx(buildSheets(items, options, defaults)));
        const choice = await vscode.window.showInformationMessage(`Exported ${items.length} symbol${items.length === 1 ? '' : 's'} to ${path.basename(target.fsPath)}.`, 'Open');
        if (choice) {
          await vscode.env.openExternal(target);
        }
      } else {
        const xlsx = target.fsPath.replace(/(_export)?\.ya?ml$/i, '') + '.xlsx';
        await fs.promises.writeFile(target.fsPath, connectInstructions(this.uri.fsPath, xlsx, items, options, defaults), 'utf8');
        await vscode.window.showTextDocument(target);
      }
    } catch (err) {
      this.service.showError('Exporting failed', err);
    }
  }

  /** Python code that reads a symbol with its view (see codegen.ts), to the clipboard or a new editor. */
  private async copyCode(name: string, language: CodeLanguage, target: 'clipboard' | 'editor', state?: SymbolViewState) {
    const symbol = this.symbol(name);
    if (!symbol) {
      return;
    }
    if (this.copyOf) {
      vscode.window.showWarningMessage(`The code would read a temporary copy of ${this.copyOf.toString(true)}: save the GDX file on disk first.`);
      return;
    }
    try {
      const code = symbolCode({ language, file: this.uri.fsPath, symbol, view: await this.orderedView(name), state, squeezeDefaults: squeezeDefaults() });
      if (target === 'editor') {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'python', content: code }));
      } else {
        await vscode.env.clipboard.writeText(code);
        vscode.window.setStatusBarMessage(`Copied ${language === 'gamspy' ? 'GAMSPy' : 'GAMS Transfer'} code for ${name}`, 3000);
      }
    } catch (err) {
      this.service.showError(`Writing the code for ${name} failed`, err);
    }
  }

  /** Forgets the saved view and resets the open one. */
  resetState() {
    this.post({ type: 'resetState' });
  }

  private post(message: unknown) {
    this.panel.webview.postMessage(message);
  }

  /** GAMS writes GDX files incrementally, so wait until the writes settle. */
  private scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.load(), 500);
  }

  symbol(name: string): GdxSymbol | undefined {
    return this.info?.symbols.find((s) => s.name === name);
  }

  get symbols(): GdxSymbol[] {
    return this.info?.symbols ?? [];
  }

  async load() {
    const gen = ++this.generation;
    this.views.clear();
    this.uels = undefined;
    this.reportAbort?.abort();
    this.report = undefined;
    this.selection.reset();
    try {
      const info = await this.service.loadFile(this.uri.fsPath);
      if (gen !== this.generation) {
        return;
      }
      this.info = info;
      this.post({
        type: 'file',
        protocol: PROTOCOL,
        // The view saved when the file was last open (applied by the webview once).
        savedState: this.remembered() ? this.states.get(this.uri.fsPath) : undefined,
        fileName: path.basename(this.uri.fsPath),
        filePath: this.copyOf ? this.copyOf.toString(true) : this.uri.fsPath,
        tools: this.service.describeReader(),
        version: info.version,
        symbols: [universeSymbol(info.version), ...info.symbols],
        pageSize: pageSize(),
      });
      // A hidden webview does not receive it: it asks again ('ready') when shown.
      this.webviewHasFile = this.panel.visible;
      this.sendPending();
    } catch (err) {
      if (gen === this.generation) {
        this.info = undefined;
        this.service.log(`Error reading ${this.uri.fsPath}: ${errorMessage(err)}`);
        this.post({ type: 'fileError', message: errorMessage(err) });
      }
    } finally {
      if (gen === this.generation) this.markLoaded();
    }
  }

  private view(name: string): Promise<TableView> {
    if (name === UNIVERSE && this.info) {
      return cachedView(this.views, name, () => {
        const view = this.loadUels().then((uels) => new TableView(universeTable(uels)));
        view.catch(() => this.views.delete(name));
        return view;
      });
    }
    const symbol = this.symbol(name);
    if (!symbol) {
      return Promise.reject(new Error(`Unknown symbol ${name}`));
    }
    // Only the most recently used symbols stay in memory.
    return cachedView(this.views, name, () => {
      // Streamed into compact columns, so that symbols with millions of records fit into memory.
      const view = this.service
        .loadSymbolColumns(this.uri.fsPath, symbol)
        .then((data) => new TableView(columnTable(data.columns, data.keyCount, data.store, symbol)));
      view.catch(() => this.views.delete(name));
      return view;
    });
  }

  /** The unique elements of the file in GDX order. */
  private loadUels(): Promise<string[]> {
    if (!this.uels) {
      this.uels = this.service.loadUels(this.uri.fsPath);
      this.uels.catch(() => (this.uels = undefined));
    }
    return this.uels;
  }

  /** The view of a symbol with its labels in GDX order. */
  private async orderedView(name: string): Promise<TableView> {
    const view = await this.view(name);
    if (!this.ordered.has(view)) {
      try {
        view.setUelOrder(await this.loadUels());
        this.ordered.add(view);
      } catch (err) {
        // Fall back to the order in which labels appear.
        this.service.log(`Reading the unique elements of ${this.uri.fsPath} failed: ${errorMessage(err)}`);
      }
    }
    return view;
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        return this.load();
      case 'export':
        return this.export(m.mode, m.names, m.options, m.states);
      case 'saveState':
        if (this.remembered()) {
          await this.states.set(this.uri.fsPath, m.state);
        }
        return;
      case 'query': {
        this.selectedSymbol = m.name;
        const gen = this.generation;
        try {
          // The table view and charts show labels in GDX order.
          const view = m.query.view === 'table' || m.query.view === 'chart' ? await this.orderedView(m.name) : await this.view(m.name);
          if (gen === this.generation) {
            this.post({ type: 'page', name: m.name, page: answerQuery(view, m.query) });
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
          const view = await this.orderedView(m.name);
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
          case 'refresh':
            return this.load();
          case 'dumpAll':
            return vscode.commands.executeCommand('gdxAnalyzer.dump', this.uri);
          case 'compare':
            return vscode.commands.executeCommand('gdxAnalyzer.compare', this.uri);
          case 'settings':
            return vscode.commands.executeCommand('workbench.action.openSettings', 'gdxAnalyzer.');
          case 'showLog':
            return this.service.output.show();
          case 'dumpSymbol':
            return vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', this.uri, m.name);
          case 'exportCsv':
            return vscode.commands.executeCommand('gdxAnalyzer.exportCsv', this.uri, m.name);
        }
        return;
      case 'selection':
        return this.selection.update(m, () => this.orderedView(m.name));
      case 'code':
        return this.copyCode(m.name, m.language, m.target, m.state);
      case 'report':
        return this.sendReport(m.refresh);
      case 'image':
        return saveChartImage(m, `${this.savePath(path.basename(this.uri.fsPath)).replace(/\.gdx$/i, '')}_${m.name}`, (err) => this.service.showError('Saving the chart image failed', err));
      case 'copy':
        try {
          await copyToClipboard(await this.orderedView(m.name), m);
        } catch (err) {
          this.service.showError(`Copying ${m.name} failed`, err);
        }
        return;
    }
  }
}

/** Setting gdxAnalyzer.rememberViewState. */
function rememberViews(): boolean {
  return vscode.workspace.getConfiguration('gdxAnalyzer').get<boolean>('rememberViewState', true);
}

export class GdxViewerProvider implements vscode.CustomReadonlyEditorProvider<GdxDocument> {
  static readonly viewType = 'gdxAnalyzer.viewer';
  private readonly sessions = new Set<{ session: ViewerSession; panel: vscode.WebviewPanel }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: GdxService,
    readonly states: ViewStateStore,
    /** Where files of other file systems (e.g. git: in diff editors) are copied to, to be read by gdxdump. */
    private readonly storage: vscode.Uri,
  ) {}

  openCustomDocument(uri: vscode.Uri): GdxDocument {
    return new GdxDocument(uri);
  }

  async resolveCustomEditor(document: GdxDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    let uri = document.uri;
    let copy: string | undefined;
    if (uri.scheme !== 'file') {
      // gdxdump reads files from disk: view a copy (e.g. of a Git revision in a diff editor).
      try {
        copy = path.join(this.storage.fsPath, 'copies', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const file = path.join(copy, path.posix.basename(uri.path) || 'file.gdx');
        await fs.promises.mkdir(copy, { recursive: true });
        await fs.promises.writeFile(file, await vscode.workspace.fs.readFile(uri));
        uri = vscode.Uri.file(file);
      } catch (err) {
        const text = `Reading ${document.uri.toString(true)} failed: ${errorMessage(err)}`.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
        panel.webview.html = `<body><p>${text}</p></body>`;
        return;
      }
    }
    const session = new ViewerSession(this.service, uri, panel, this.states, copy ? document.uri : undefined);
    const entry = { session, panel };
    this.sessions.add(entry);
    panel.onDidDispose(() => {
      session.dispose();
      this.sessions.delete(entry);
      if (copy) fs.promises.rm(copy, { recursive: true, force: true }).catch(() => {});
    });
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'viewer.js', path.basename(uri.fsPath));
  }

  /** The session of the active viewer tab, if any. */
  active(): ViewerSession | undefined {
    for (const { session, panel } of this.sessions) {
      if (panel.active) {
        return session;
      }
    }
    return undefined;
  }

  sessionFor(uri: vscode.Uri): ViewerSession | undefined {
    for (const { session } of this.sessions) {
      if (session.uri.toString() === uri.toString()) {
        return session;
      }
    }
    return undefined;
  }
}
