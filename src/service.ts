import * as vscode from 'vscode';
import { GdxFileInfo, GdxSource, loadDomains, loadDumpText, loadFileInfo, loadSymbolColumns, loadSymbolCsv, loadSymbolList, loadUels } from './gdxFile';
import { GdxSymbol, SymbolColumns } from './parse';
import { SelectionStatus } from './selectionStatus';
import { BackendSetting, GdxTools, ResolvedTools, ToolNotFoundError, resolveTools } from './tools';

export type { GdxFileInfo } from './gdxFile';

/** Shared access to the resolved gdxdump/gdxdiff tools and common GDX queries. */
export class GdxService implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('GDX');
  /** Statistics of the selected cells of the active viewer or comparison. */
  readonly selectionStatus = new SelectionStatus();
  private cached?: GdxTools;
  private readonly disposables: vscode.Disposable[] = [this.output, this.selectionStatus];

  /** `bundledDirectory`: where the tools bundled with the extension are (if this package has them). */
  constructor(private readonly bundledDirectory?: string) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gdxAnalyzer')) {
          this.cached = undefined;
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => (this.cached = undefined)),
    );
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  log(line: string) {
    this.output.appendLine(line);
  }

  /** Resolves the tools according to the settings; throws ToolNotFoundError if none are available. */
  tools(): GdxTools {
    if (!this.cached) {
      const cfg = vscode.workspace.getConfiguration('gdxAnalyzer');
      const resolved: ResolvedTools = resolveTools({
        backend: cfg.get<BackendSetting>('backend', 'auto'),
        bundledDirectory: this.bundledDirectory,
        gamsSystemDirectory: cfg.get<string>('gamsSystemDirectory', ''),
        gamspyExecutable: cfg.get<string>('gamspyExecutable', ''),
        venvSearchRoots: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
      });
      const encoding = this.encoding();
      this.log(`Using ${describeTools(resolved)}${encoding.toLowerCase().replace('-', '') === 'utf8' ? '' : `, reading GDX labels as ${encoding}`}`);
      this.cached = new GdxTools(resolved, (l) => this.log(l), encoding);
    }
    return this.cached;
  }

  /** Setting gdxAnalyzer.encoding. */
  private encoding(): string {
    return vscode.workspace.getConfiguration('gdxAnalyzer').get<string>('encoding', 'utf-8').trim() || 'utf-8';
  }

  /** Setting gdxAnalyzer.reader: read GDX files with gdxdump instead of natively. */
  private useGdxdump(): boolean {
    return vscode.workspace.getConfiguration('gdxAnalyzer').get<string>('reader', 'native') === 'gdxdump';
  }

  /** How GDX files are read (natively unless set otherwise; the tools are only resolved when needed). */
  source(): GdxSource {
    return { encoding: this.encoding(), useGdxdump: this.useGdxdump(), tools: () => this.tools(), log: (l) => this.log(l) };
  }

  /** How GDX files are read, for the headers of the viewer and the comparisons. */
  describeReader(): string {
    if (this.useGdxdump()) {
      return describeTools(this.tools().tools);
    }
    try {
      return `native GDX reader · ${describeTools(this.tools().tools)}`;
    } catch {
      return 'native GDX reader (no gdxdump/gdxdiff found)';
    }
  }

  loadFile(file: string): Promise<GdxFileInfo> {
    return loadFileInfo(this.source(), file);
  }

  /** The records of a symbol in compact columns (see gdxFile.ts). */
  loadSymbolColumns(file: string, symbol: GdxSymbol, signal?: AbortSignal): Promise<SymbolColumns> {
    return loadSymbolColumns(this.source(), file, symbol, signal);
  }

  /** The unique elements of a file in GDX order. */
  loadUels(file: string): Promise<string[]> {
    return loadUels(this.source(), file);
  }

  /** The symbols of a file. */
  loadSymbolList(file: string): Promise<GdxSymbol[]> {
    return loadSymbolList(this.source(), file);
  }

  /** The gdxdump output of a file or one of its symbols. */
  dumpText(file: string, symbol?: string, signal?: AbortSignal): Promise<string> {
    return loadDumpText(this.source(), file, symbol, signal);
  }

  /** A symbol as CSV with all fields and set texts (as gdxdump writes it). */
  symbolCsv(file: string, symbol: string): Promise<string> {
    return loadSymbolCsv(this.source(), file, symbol);
  }

  /** The domain of each symbol of a file, by its lower-case name. */
  loadDomains(file: string): Promise<Map<string, string[]>> {
    return loadDomains(this.source(), file);
  }

  /** Shows an error; offers to open the settings when the tools could not be found. */
  async showError(prefix: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`Error: ${prefix}: ${message}`);
    if (err instanceof ToolNotFoundError) {
      const choice = await vscode.window.showErrorMessage(message, 'Open Settings');
      if (choice) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'gdxAnalyzer.');
      }
    } else {
      vscode.window.showErrorMessage(`${prefix}: ${message}`);
    }
  }
}

export function describeTools(t: ResolvedTools): string {
  if (t.bundled) {
    return `bundled gdxdump/gdxdiff${t.bundled.version ? ` (${t.bundled.version})` : ''}`;
  }
  return t.backend === 'gams' ? `GAMS gdxdump/gdxdiff from ${t.location}` : `GAMSPy CLI (${t.location})`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
