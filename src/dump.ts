import * as path from 'path';
import * as vscode from 'vscode';
import { GdxService, errorMessage } from './service';

export const DUMP_SCHEME = 'gdxdump';

interface DumpTarget {
  file: string;
  symbol?: string;
}

/** Virtual, read-only document with the gdxdump output of a file or one of its symbols. */
export function dumpUri(file: string, symbol?: string): vscode.Uri {
  const base = path.basename(file);
  const label = symbol ? `${base} - ${symbol}.gms` : `${base}.gms`;
  const target: DumpTarget = { file, symbol };
  // The directory keeps equally named files from different folders apart in the tab titles' tooltips.
  return vscode.Uri.from({
    scheme: DUMP_SCHEME,
    path: `${vscode.Uri.file(path.dirname(file)).path}/${label}`,
    query: JSON.stringify(target),
  });
}

function targetOf(uri: vscode.Uri): DumpTarget {
  return JSON.parse(uri.query) as DumpTarget;
}

export class GdxDumpProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  /** One watcher per dumped GDX file while any of its dump documents is open. */
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(private readonly service: GdxService) {
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument(() => this.pruneWatchers()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gdxAnalyzer.encoding')) {
          this.refresh(() => true);
        }
      }),
    );
  }

  dispose() {
    this.watchers.forEach((w) => w.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const { file, symbol } = targetOf(uri);
    this.watch(file);
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `gdxdump ${path.basename(file)}${symbol ? ' ' + symbol : ''}` },
        () => this.service.tools().dump(file, { symbol }, { signal: abort.signal }),
      );
    } catch (err) {
      this.service.log(`Error dumping ${file}: ${errorMessage(err)}`);
      return `* gdxdump failed for ${file}${symbol ? ` (symbol ${symbol})` : ''}:\n*\n` +
        errorMessage(err).split(/\r?\n/).map((l) => `* ${l}`).join('\n') + '\n';
    } finally {
      sub.dispose();
    }
  }

  private watch(file: string) {
    if (this.watchers.has(file)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    let timer: NodeJS.Timeout | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh((f) => f === file), 500);
    };
    const subs = [watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh)];
    this.watchers.set(file, {
      dispose: () => {
        clearTimeout(timer);
        subs.forEach((s) => s.dispose());
      },
    });
  }

  /** Reads the open dump documents of the files that match again. */
  private refresh(matches: (file: string) => boolean) {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === DUMP_SCHEME && matches(targetOf(doc.uri).file)) {
        this.changed.fire(doc.uri);
      }
    }
  }

  private pruneWatchers() {
    const open = new Set(
      vscode.workspace.textDocuments.filter((d) => d.uri.scheme === DUMP_SCHEME && !d.isClosed).map((d) => targetOf(d.uri).file),
    );
    for (const [file, watcher] of this.watchers) {
      if (!open.has(file)) {
        watcher.dispose();
        this.watchers.delete(file);
      }
    }
  }
}
