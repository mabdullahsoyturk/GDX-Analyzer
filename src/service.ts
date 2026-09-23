import * as vscode from 'vscode';
import { GdxSymbol, SymbolData, mergeDomainInfo, mergeSubtypes, parseDomainInfo, parseSubtypes, parseSymbolCsv, parseSymbols, parseVersionInfo } from './parse';
import { BackendSetting, GdxTools, ResolvedTools, ToolNotFoundError, resolveTools } from './tools';

export interface GdxFileInfo {
  version: [string, string][];
  symbols: GdxSymbol[];
}

/** Shared access to the resolved gdxdump/gdxdiff tools and common GDX queries. */
export class GdxService implements vscode.Disposable {
  readonly output = vscode.window.createOutputChannel('GDX');
  private cached?: GdxTools;
  private readonly disposables: vscode.Disposable[] = [this.output];

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
      this.log(`Using ${describeTools(resolved)}`);
      this.cached = new GdxTools(resolved, (l) => this.log(l));
    }
    return this.cached;
  }

  async loadFile(file: string): Promise<GdxFileInfo> {
    const tools = this.tools();
    // In parallel, since each GAMSPy CLI call pays for a Python interpreter start-up.
    const [symbolsText, domainText, versionText, declarations] = await Promise.all([
      tools.dump(file, { symbols: true }),
      tools.dump(file, { domainInfo: true }),
      tools.dump(file, { version: true }),
      // The declarations contain the variable subtypes and singleton sets.
      tools.dump(file, { noData: true }),
    ]);
    const symbols = mergeSubtypes(mergeDomainInfo(parseSymbols(symbolsText), parseDomainInfo(domainText)), parseSubtypes(declarations));
    return { version: parseVersionInfo(versionText), symbols };
  }

  async loadSymbol(file: string, symbol: GdxSymbol): Promise<SymbolData> {
    // hexBytes: exact values instead of gdxdump's 15 significant digits.
    const csv = await this.tools().dump(file, { symbol: symbol.name, format: 'csv', csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' });
    return parseSymbolCsv(csv, symbol);
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
