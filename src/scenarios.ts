/**
 * The scenario comparison panel: one symbol of several GDX files side by side, with the
 * differences from a base scenario (see scenario.ts). Files can be added and removed and
 * any of them can be the base; the panel reads the files again when they change.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GdxFileInfo } from './gdxFile';
import { GdxSymbol, parseUelTable } from './parse';
import { baseAfterRemoval, scenarioNames, scenarioTable } from './scenario';
import { GdxService, describeTools, errorMessage } from './service';
import { TableView, cachedView } from './table';
import { CopyRequest, ImageMessage, SelectionRequest, SelectionTracker, WebviewQuery, answerColumnValues, answerQuery, copyToClipboard, pageSize, saveChartImage } from './tableHost';
import { PROTOCOL, webviewHtml } from './webview';

type FromWebview =
  | { type: 'ready' }
  | { type: 'query'; name: string; query: WebviewQuery }
  | { type: 'columnValues'; name: string; column: number }
  | CopyRequest
  | SelectionRequest
  | ImageMessage
  | { type: 'action'; action: 'setBase' | 'remove' | 'open'; index: number }
  | { type: 'action'; action: 'add' | 'refresh' };

/** A symbol of the compared files: from the first file that has it, with the files that have it. */
export interface ScenarioSymbol extends GdxSymbol {
  /** Per file: its number of records, or null if the file does not have the symbol. */
  inFiles: (number | null)[];
}

const find = (symbols: GdxSymbol[] | undefined, name: string) => symbols?.find((s) => s.name.toLowerCase() === name.toLowerCase());

export class ScenarioPanel implements vscode.Disposable {
  private static readonly panels = new Set<ScenarioPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private infos: (GdxFileInfo | undefined)[] = [];
  private views = new Map<string, Promise<TableView>>();
  private uels?: Promise<string[]>;
  private base = 0;
  private generation = 0;
  private reloadTimer?: NodeJS.Timeout;
  private readonly selection: SelectionTracker;

  /** Opens a comparison of the files (or shows the open one of the same files). */
  static show(extensionUri: vscode.Uri, service: GdxService, files: string[]) {
    for (const p of ScenarioPanel.panels) {
      if (p.files.join('\0') === files.join('\0')) {
        p.panel.reveal();
        return;
      }
    }
    ScenarioPanel.panels.add(new ScenarioPanel(extensionUri, service, files));
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly service: GdxService,
    private files: string[],
  ) {
    this.panel = vscode.window.createWebviewPanel('gdxAnalyzer.scenarios', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.webview.html = webviewHtml(this.panel.webview, extensionUri, 'scenarios.js', this.title());
    this.selection = new SelectionTracker(service.selectionStatus, this.panel);
    this.disposables.push(
      this.selection,
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gdxAnalyzer.numberFormat') || e.affectsConfiguration('gdxAnalyzer.squeezeDefaults') || e.affectsConfiguration('gdxAnalyzer.maxRowsPerPage') || e.affectsConfiguration('gdxAnalyzer.maxColumnsPerPage')) {
          this.post({ type: 'requery' });
        }
        if (e.affectsConfiguration('gdxAnalyzer.encoding')) {
          this.load();
        }
      }),
    );
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    ScenarioPanel.panels.delete(this);
    this.watchers.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  private title() {
    return `Scenarios: ${scenarioNames(this.files).join(', ')}`;
  }

  private post(message: unknown) {
    this.panel.webview.postMessage(message);
  }

  /** Reads the symbol lists of the files again when one changes (e.g. after a GAMS run). */
  private watch() {
    this.watchers.forEach((d) => d.dispose());
    this.watchers = this.files.flatMap((f) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(f)), path.basename(f)));
      const changed = () => {
        clearTimeout(this.reloadTimer);
        // GAMS writes GDX files incrementally: wait until the writes settle.
        this.reloadTimer = setTimeout(() => this.load(), 500);
      };
      return [w, w.onDidChange(changed), w.onDidCreate(changed), w.onDidDelete(changed)];
    });
  }

  /** Reads the symbol lists of the files and sends them to the webview. */
  async load() {
    const gen = ++this.generation;
    this.views = new Map();
    this.uels = undefined;
    this.selection.reset();
    this.panel.title = this.title();
    this.watch();
    const tools = this.service.tools();
    const results = await Promise.allSettled(this.files.map((f) => this.service.loadFile(f)));
    if (gen !== this.generation) {
      return;
    }
    this.infos = results.map((r) => (r.status === 'fulfilled' ? r.value : undefined));
    const names = scenarioNames(this.files);
    const files = this.files.map((f, i) => {
      const r = results[i];
      return { path: f, name: names[i], error: r.status === 'rejected' ? errorMessage(r.reason) : fs.existsSync(f) ? undefined : 'The file does not exist.' };
    });
    // The symbols of all files: in the order of the first file that has them.
    const symbols: ScenarioSymbol[] = [];
    this.infos.forEach((info) => {
      for (const s of info?.symbols ?? []) {
        if (!find(symbols, s.name)) {
          symbols.push({ ...s, inFiles: this.infos.map((other) => find(other?.symbols, s.name)?.records ?? null) });
        }
      }
    });
    this.post({ type: 'scenarios', protocol: PROTOCOL, files, base: this.base, symbols, tools: describeTools(tools.tools), pageSize: pageSize() });
  }

  /** The labels of all files in GDX order (the base first), for the table view and charts. */
  private loadUels(): Promise<string[]> {
    if (!this.uels) {
      const order = [this.base, ...this.files.map((_, i) => i).filter((i) => i !== this.base)];
      this.uels = Promise.all(
        order.map((i) =>
          this.infos[i]
            ? this.service
                .tools()
                .dump(this.files[i], { uelTable: 'uels', noData: true })
                .then(parseUelTable)
                .catch(() => [] as string[])
            : Promise.resolve([] as string[]),
        ),
      ).then((lists) => [...new Set(lists.flat())]);
    }
    return this.uels;
  }

  private view(name: string): Promise<TableView> {
    return cachedView(this.views, name, () => {
      const names = scenarioNames(this.files);
      const view = (async () => {
        const data = await Promise.all(
          this.files.map(async (f, i) => {
            const symbol = find(this.infos[i]?.symbols, name);
            return { name: names[i], data: symbol ? await this.service.loadSymbolColumns(f, symbol) : undefined };
          }),
        );
        const symbol = find(this.infos[this.base]?.symbols, name) ?? this.infos.map((info) => find(info?.symbols, name)).find((s) => s);
        const v = new TableView(scenarioTable(data, this.base, symbol));
        v.setUelOrder(await this.loadUels());
        return v;
      })();
      view.catch(() => this.views.delete(name));
      return view;
    });
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
        return this.load();
      case 'query': {
        const gen = this.generation;
        try {
          const view = await this.view(m.name);
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
      case 'selection':
        return this.selection.update(m, () => this.view(m.name));
      case 'copy':
        try {
          await copyToClipboard(await this.view(m.name), m);
        } catch (err) {
          this.service.showError(`Copying ${m.name} failed`, err);
        }
        return;
      case 'image':
        return saveChartImage(m, path.join(path.dirname(this.files[this.base] ?? this.files[0]), `scenarios_${m.name}`), (err) => this.service.showError('Saving the chart image failed', err));
      case 'action':
        switch (m.action) {
          case 'refresh':
            return this.load();
          case 'setBase':
            if (m.index >= 0 && m.index < this.files.length && m.index !== this.base) {
              this.base = m.index;
              return this.load();
            }
            return;
          case 'remove':
            if (this.files.length > 2 && m.index >= 0 && m.index < this.files.length) {
              this.files = this.files.filter((_, i) => i !== m.index);
              this.base = baseAfterRemoval(this.base, m.index);
              return this.load();
            }
            return;
          case 'add': {
            const picked = await vscode.window.showOpenDialog({
              title: 'Add Scenarios',
              canSelectMany: true,
              filters: { 'GDX files': ['gdx'] },
              defaultUri: vscode.Uri.file(path.dirname(this.files[this.files.length - 1])),
            });
            const added = (picked ?? []).map((u) => u.fsPath).filter((f) => !this.files.includes(f));
            if (added.length) {
              this.files = [...this.files, ...added];
              return this.load();
            }
            return;
          }
          case 'open':
            if (this.files[m.index]) {
              return vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(this.files[m.index]), 'gdxAnalyzer.viewer');
            }
            return;
        }
    }
  }
}
