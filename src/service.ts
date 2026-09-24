import * as vscode from 'vscode';
import { GdxFileInfo, loadFileInfo, loadSymbolColumns } from './gdxFile';
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

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gdx')) {
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
      const cfg = vscode.workspace.getConfiguration('gdx');
      const resolved: ResolvedTools = resolveTools({
        backend: cfg.get<BackendSetting>('backend', 'auto'),
        gamsSystemDirectory: cfg.get<string>('gamsSystemDirectory', ''),
        gamspyExecutable: cfg.get<string>('gamspyExecutable', ''),
        venvSearchRoots: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath),
      });
      const encoding = cfg.get<string>('encoding', 'utf-8').trim() || 'utf-8';
      this.log(`Using ${describeTools(resolved)}${encoding.toLowerCase().replace('-', '') === 'utf8' ? '' : `, reading GDX labels as ${encoding}`}`);
      this.cached = new GdxTools(resolved, (l) => this.log(l), encoding);
    }
    return this.cached;
  }

  loadFile(file: string): Promise<GdxFileInfo> {
    return loadFileInfo(this.tools(), file);
  }

  /** The records of a symbol in compact columns (see gdxFile.ts). */
  loadSymbolColumns(file: string, symbol: GdxSymbol): Promise<SymbolColumns> {
    return loadSymbolColumns(this.tools(), file, symbol);
  }

  /** Shows an error; offers to open the settings when the tools could not be found. */
  async showError(prefix: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`Error: ${prefix}: ${message}`);
    if (err instanceof ToolNotFoundError) {
      const choice = await vscode.window.showErrorMessage(message, 'Open Settings');
      if (choice) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'gdx.');
      }
    } else {
      vscode.window.showErrorMessage(`${prefix}: ${message}`);
    }
  }
}

export function describeTools(t: ResolvedTools): string {
  return t.backend === 'gams' ? `GAMS gdxdump/gdxdiff from ${t.location}` : `GAMSPy CLI (${t.location})`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
