/**
 * Links from GAMS and Python source to the GDX viewer: GDX file names open the file,
 * symbols read or written by $load, execute_unload etc. open it at that symbol, and
 * "GDX: Show Symbol in GDX File" opens a GDX file of the document at the symbol under the cursor.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GdxReferences, gamsReferences, pythonReferences } from './gdxRefs';

const SCHEMES = ['file', 'untitled', 'vscode-notebook-cell'];
export const SELECTOR: vscode.DocumentFilter[] = ['gams', 'python'].flatMap((language) => SCHEMES.map((scheme) => ({ language, scheme })));
export const SHOW_COMMAND = 'gdxAnalyzer.showInViewer';

function linksEnabled(): boolean {
  return vscode.workspace.getConfiguration('gdxAnalyzer').get<boolean>('links.enabled', true);
}

/**
 * The GDX references of a document. Of a notebook cell: those of all Python cells of its notebook
 * (a file is usually read in an earlier cell than its symbols are used), with offsets relative to the
 * cell, so that those of other cells lie before 0 or after its end.
 */
export function referencesOf(doc: vscode.TextDocument): GdxReferences {
  if (doc.uri.scheme === 'vscode-notebook-cell' && doc.languageId === 'python') {
    const id = doc.uri.toString();
    const notebook = vscode.workspace.notebookDocuments.find((nb) => nb.getCells().some((c) => c.document.uri.toString() === id));
    if (notebook) {
      let text = '';
      let base = 0;
      for (const cell of notebook.getCells()) {
        if (cell.kind !== vscode.NotebookCellKind.Code || cell.document.languageId !== 'python') continue;
        if (cell.document.uri.toString() === id) base = text.length;
        text += cell.document.getText() + '\n';
      }
      const refs = pythonReferences(text);
      const shift = <T extends { start: number; end: number }>(list: T[]) => list.map((r) => ({ ...r, start: r.start - base, end: r.end - base }));
      return { files: shift(refs.files), symbols: shift(refs.symbols), names: shift(refs.names ?? []) };
    }
  }
  return doc.languageId === 'python' ? pythonReferences(doc.getText()) : gamsReferences(doc.getText());
}

/** The directory of a document on disk (also for notebook cells), if it has one. */
function documentDir(doc: vscode.TextDocument): string | undefined {
  return doc.uri.scheme === 'file' || doc.uri.scheme === 'vscode-notebook-cell' ? path.dirname(doc.uri.fsPath) : undefined;
}

/**
 * Where a GDX file name of a document may be: absolute, or relative to the document's
 * directory (where GAMS usually runs) and then to the workspace folders.
 */
export function candidatePaths(file: string, doc: vscode.TextDocument): string[] {
  if (path.isAbsolute(file)) {
    return [file];
  }
  const dirs = [documentDir(doc), ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath)];
  return [...new Set(dirs.filter((d): d is string => !!d).map((d) => path.resolve(d, file)))];
}

export const existing = (paths: string[]) => paths.find((p) => fs.existsSync(p));

function commandUri(paths: string[], symbol?: string): vscode.Uri {
  return vscode.Uri.parse(`command:${SHOW_COMMAND}?${encodeURIComponent(JSON.stringify([paths, symbol]))}`);
}

export class GdxLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    if (!linksEnabled()) {
      return [];
    }
    const refs = referencesOf(doc);
    const range = (start: number, end: number) => new vscode.Range(doc.positionAt(start), doc.positionAt(end));
    // Not those of other cells of a notebook.
    const length = doc.getText().length;
    const inDocument = (r: { start: number; end: number }) => r.start >= 0 && r.end <= length;
    const files = refs.files.filter(inDocument).map((r) => {
      const link = new vscode.DocumentLink(range(r.start, r.end), commandUri(candidatePaths(r.file, doc)));
      link.tooltip = `Open ${path.basename(r.file)} in GDX Analyzer`;
      return link;
    });
    const symbols = refs.symbols.filter(inDocument).map((r) => {
      const link = new vscode.DocumentLink(range(r.start, r.end), commandUri(candidatePaths(r.file, doc), r.name));
      link.tooltip = r.name === '*' ? `Show the unique elements of ${path.basename(r.file)}` : `Show ${r.name} in ${path.basename(r.file)}`;
      return link;
    });
    return [...files, ...symbols];
  }
}

/** Opens a GDX file in the viewer, at `symbol` if given. */
export type ShowInViewer = (file: vscode.Uri, symbol?: string) => Promise<void>;

export function registerLinks(context: vscode.ExtensionContext, show: ShowInViewer, hasSymbol: (file: string, symbol: string) => Promise<boolean>) {
  const provider = new GdxLinkProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(SELECTOR, provider),

    vscode.commands.registerCommand(SHOW_COMMAND, async (paths: unknown, symbol?: unknown) => {
      const list = (Array.isArray(paths) ? paths : [paths]).filter((p): p is string => typeof p === 'string');
      const file = existing(list);
      if (!file) {
        vscode.window.showWarningMessage(`${path.basename(list[0] ?? 'The GDX file')} does not exist (yet). Looked in: ${list.map((p) => path.dirname(p)).join(', ')}`);
        return;
      }
      await show(vscode.Uri.file(file), typeof symbol === 'string' ? symbol : undefined);
    }),

    vscode.commands.registerCommand('gdxAnalyzer.showSymbol', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const doc = editor.document;
      const wordRange = doc.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][A-Za-z0-9_]*/);
      const symbol = wordRange && doc.getText(wordRange);
      if (!symbol) {
        vscode.window.showInformationMessage('Place the cursor on a symbol name to show it in a GDX file.');
        return;
      }
      const file = await pickFile(doc, editor.selection.active, symbol, hasSymbol);
      if (file) {
        await show(file, symbol);
      }
    }),
  );
}

/**
 * The GDX file to show `symbol` from: of the files the document references (the nearest
 * reference before the cursor first) or, if it references none, of the workspace, those
 * that have the symbol; asks if there are several.
 */
async function pickFile(doc: vscode.TextDocument, at: vscode.Position, symbol: string, hasSymbol: (file: string, symbol: string) => Promise<boolean>): Promise<vscode.Uri | undefined> {
  const offset = doc.offsetAt(at);
  const refs = referencesOf(doc);
  // Nearest reference before the cursor first, then the following ones.
  const ordered = [...refs.files.filter((r) => r.start <= offset).reverse(), ...refs.files.filter((r) => r.start > offset)];
  let files = [...new Set(ordered.map((r) => existing(candidatePaths(r.file, doc))).filter((f): f is string => !!f))];
  let where = 'this document';
  if (!files.length) {
    files = (await vscode.workspace.findFiles('**/*.gdx', undefined, 50)).map((u) => u.fsPath);
    where = 'the workspace';
  }
  if (!files.length) {
    vscode.window.showInformationMessage('No GDX file found: the document references none and the workspace has none.');
    return undefined;
  }
  // A few files at a time: each check runs gdxdump.
  const checks: boolean[] = [];
  for (let i = 0; i < files.length; i += 4) {
    checks.push(...(await Promise.all(files.slice(i, i + 4).map((f) => hasSymbol(f, symbol).catch(() => false)))));
  }
  const withSymbol = files.filter((_, i) => checks[i]);
  if (!withSymbol.length) {
    vscode.window.showInformationMessage(
      files.length === 1 ? `${path.basename(files[0])} has no symbol ${symbol}.` : `None of the GDX files of ${where} has a symbol ${symbol}.`,
    );
    return undefined;
  }
  if (withSymbol.length === 1) {
    return vscode.Uri.file(withSymbol[0]);
  }
  const base = documentDir(doc);
  const picked = await vscode.window.showQuickPick(
    withSymbol.map((f) => ({ label: path.basename(f), description: base ? path.relative(base, path.dirname(f)) || undefined : path.dirname(f), file: f })),
    { title: `Show ${symbol} in` },
  );
  return picked && vscode.Uri.file(picked.file);
}
