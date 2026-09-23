import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GdxSymbol, parseUelTable } from './parse';
import { GdxFileInfo, GdxService, describeTools, errorMessage } from './service';
import { TableView, cachedView, columnTable } from './table';
import { CopyRequest, WebviewQuery, answerColumnValues, answerQuery, copyToClipboard, defaultFormat, pageSize, squeezeDefaults } from './tableHost';
import { ExportItem, ExportOptions, SymbolViewState, buildSheets, connectInstructions } from './export';
import { ViewStateStore } from './viewState';
import { writeXlsx } from './xlsx';
import { PROTOCOL, webviewHtml } from './webview';

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
  | CopyRequest
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
  selectedSymbol?: string;
  private loaded!: Promise<void>;
  private markLoaded!: () => void;

  constructor(
    private readonly service: GdxService,
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly states: ViewStateStore,
  ) {
    this.loaded = new Promise((resolve) => (this.markLoaded = resolve));
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)),
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.scheduleReload()),
      watcher.onDidCreate(() => this.scheduleReload()),
      watcher.onDidDelete(() => this.post({ type: 'fileError', message: 'The file has been deleted.' })),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        // Pages are formatted by the extension: ask the webview for the current page again.
        if (e.affectsConfiguration('gdx.numberFormat') || e.affectsConfiguration('gdx.squeezeDefaults') || e.affectsConfiguration('gdx.maxRowsPerPage') || e.affectsConfiguration('gdx.maxColumnsPerPage')) {
          panel.webview.postMessage({ type: 'requery' });
        }
      }),
    );
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  /** Resolves once the file has been read (and the webview shows it). */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /** Opens the export dialog of the webview. */
  openExport() {
    this.panel.reveal();
    this.post({ type: 'openExport' });
  }

  /** Writes the symbols to an Excel file, or the GAMS Connect instructions that do so. */
  private async export(mode: 'excel' | 'connect', names: string[], options: ExportOptions, states: Record<string, SymbolViewState>) {
    const base = this.uri.fsPath.replace(/\.gdx$/i, '');
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
    try {
      const tools = this.service.tools();
      const info = await this.service.loadFile(this.uri.fsPath);
      if (gen !== this.generation) {
        return;
      }
      this.info = info;
      this.markLoaded();
      this.post({
        type: 'file',
        protocol: PROTOCOL,
        // The view saved when the file was last open (applied by the webview once).
        savedState: rememberViews() ? this.states.get(this.uri.fsPath) : undefined,
        fileName: path.basename(this.uri.fsPath),
        filePath: this.uri.fsPath,
        tools: describeTools(tools.tools),
        version: info.version,
        symbols: info.symbols,
        pageSize: pageSize(),
      });
    } catch (err) {
      if (gen === this.generation) {
        this.info = undefined;
        this.service.log(`Error reading ${this.uri.fsPath}: ${errorMessage(err)}`);
        this.post({ type: 'fileError', message: errorMessage(err) });
      }
    }
  }

  private view(name: string): Promise<TableView> {
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

  /** The view of a symbol with its labels in GDX order. */
  private async orderedView(name: string): Promise<TableView> {
    const view = await this.view(name);
    if (!this.ordered.has(view)) {
      if (!this.uels) {
        this.uels = this.service
          .tools()
          .dump(this.uri.fsPath, { uelTable: 'uels', noData: true })
          .then(parseUelTable);
        this.uels.catch(() => (this.uels = undefined));
      }
      try {
        view.setUelOrder(await this.uels);
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
        if (rememberViews()) {
          await this.states.set(this.uri.fsPath, m.state);
        }
        return;
      case 'query': {
        this.selectedSymbol = m.name;
        const gen = this.generation;
        try {
          const view = m.query.view === 'table' ? await this.orderedView(m.name) : await this.view(m.name);
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
            return vscode.commands.executeCommand('gdx.dump', this.uri);
          case 'compare':
            return vscode.commands.executeCommand('gdx.compare', this.uri);
          case 'settings':
            return vscode.commands.executeCommand('workbench.action.openSettings', 'gdx.');
          case 'showLog':
            return this.service.output.show();
          case 'dumpSymbol':
            return vscode.commands.executeCommand('gdx.dumpSymbol', this.uri, m.name);
          case 'exportCsv':
            return vscode.commands.executeCommand('gdx.exportCsv', this.uri, m.name);
        }
        return;
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

/** Setting gdx.rememberViewState. */
function rememberViews(): boolean {
  return vscode.workspace.getConfiguration('gdx').get<boolean>('rememberViewState', true);
}

export class GdxViewerProvider implements vscode.CustomReadonlyEditorProvider<GdxDocument> {
  static readonly viewType = 'gdx.viewer';
  private readonly sessions = new Set<{ session: ViewerSession; panel: vscode.WebviewPanel }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: GdxService,
    readonly states: ViewStateStore,
  ) {}

  openCustomDocument(uri: vscode.Uri): GdxDocument {
    return new GdxDocument(uri);
  }

  resolveCustomEditor(document: GdxDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    if (document.uri.scheme !== 'file') {
      panel.webview.html = `<body><p>GDX files can only be viewed from the local file system (got ${document.uri.scheme}:).</p></body>`;
      return;
    }
    const session = new ViewerSession(this.service, document.uri, panel, this.states);
    const entry = { session, panel };
    this.sessions.add(entry);
    panel.onDidDispose(() => {
      session.dispose();
      this.sessions.delete(entry);
    });
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'viewer.js', path.basename(document.uri.fsPath));
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
