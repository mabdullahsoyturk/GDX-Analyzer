/**
 * Hovers in GAMS and Python source: GDX file names show the symbols of the file, and symbol
 * names a preview of the symbol in a GDX file (see preview.ts) with a link to the viewer. Symbols
 * are those of $load, execute_unload etc. (and of read(), write() and m["x"] in GAMSPy and GAMS
 * Transfer code), and in a document that references GDX files any name of a symbol in one of them
 * (the nearest reference before the name first, as GDX: Show Symbol), also a Python name bound to one
 * (limit = Equation(m, name="supply")). In a notebook, the references of all its cells count.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { GdxFileInfo } from './gdxFile';
import { SELECTOR, SHOW_COMMAND, candidatePaths, existing, referencesOf } from './links';
import { statFile } from './platform/files';
import { displayFile } from './platform/uris';
import { MAX_PREVIEW_RECORDS, filePreview, symbolPreview } from './preview';
import { GdxService, errorMessage } from './service';
import { TableView, UNIVERSE, cachedView, columnTable, universeSymbol, universeTable } from './table';
import { defaultFormat } from './tableHost';

const REPORT_COMMAND = 'gdxAnalyzer.solutionReport';

function setting(name: 'hover.enabled' | 'links.enabled'): boolean {
  return vscode.workspace.getConfiguration('gdxAnalyzer').get<boolean>(name, true);
}

function markdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.isTrusted = { enabledCommands: [SHOW_COMMAND, REPORT_COMMAND] };
  return md;
}

const link = (label: string, command: string, args: unknown[]) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;

export class GdxHoverProvider implements vscode.HoverProvider {
  private readonly files = new Map<string, { mtimeMs: number; size: number; info: Promise<GdxFileInfo> }>();
  /** Previewed symbols (the most recently used ones), by file, modification and name. */
  private readonly views = new Map<string, Promise<TableView>>();

  constructor(private readonly service: GdxService) {}

  async provideHover(doc: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (!setting('hover.enabled')) {
      return undefined;
    }
    const offset = doc.offsetAt(position);
    const refs = referencesOf(doc);
    const at = <T extends { start: number; end: number }>(list: T[]) => list.find((r) => r.start <= offset && offset < r.end);
    const range = (r: { start: number; end: number }) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
    try {
      const fileRef = at(refs.files);
      if (fileRef) {
        return await this.fileHover(candidatePaths(fileRef.file, doc), range(fileRef), setting('links.enabled'));
      }
      const symbolRef = at(refs.symbols);
      if (symbolRef) {
        return await this.symbolHover(candidatePaths(symbolRef.file, doc), symbolRef.name, range(symbolRef), token, setting('links.enabled'));
      }
    } catch (err) {
      // Named in the document: say why there is no preview.
      return new vscode.Hover(markdown(`Reading the GDX file failed: ${errorMessage(err)}`));
    }
    // Any other name: a symbol of a GDX file the document references (otherwise no hover).
    const word = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!word || !refs.files.length) {
      return undefined;
    }
    // A Python name bound to a symbol of another name: the last binding before the name, else the first one.
    const text = doc.getText(word);
    const bindings = (refs.names ?? []).filter((n) => n.name === text);
    const bound = bindings.filter((n) => n.start <= offset).pop() ?? bindings[0];
    const name = (bound?.symbol ?? text).toLowerCase();
    const ordered = [...refs.files.filter((r) => r.start <= offset).reverse(), ...refs.files.filter((r) => r.start > offset)];
    const files = [...new Set((await Promise.all(ordered.map((r) => existing(candidatePaths(r.file, doc))))).filter((f): f is string => !!f))];
    if (token.isCancellationRequested) return undefined;
    for (const file of files) {
      try {
        const info = await this.info(file);
        if (token.isCancellationRequested) return undefined;
        if (info.symbols.some((s) => s.name.toLowerCase() === name)) {
          return await this.symbolHover([file], name, word, token, false);
        }
      } catch {
        // Not a readable GDX file (yet): try the next one.
      }
    }
    return undefined;
  }

  /** The symbols of a file, read again when it changed. */
  private async info(file: string): Promise<GdxFileInfo> {
    const stat = await statFile(file);
    const hit = this.files.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.info;
    }
    const info = this.service.loadFile(file);
    info.catch(() => this.files.get(file)?.info === info && this.files.delete(file));
    this.files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, info });
    while (this.files.size > 16) this.files.delete(this.files.keys().next().value as string);
    return info;
  }

  private missing(paths: string[]): vscode.Hover {
    const dirs = [...new Set(paths.map((p) => path.dirname(p)))];
    return new vscode.Hover(markdown(`\`${path.basename(paths[0] ?? 'The GDX file')}\` does not exist (yet). Looked in: ${dirs.map((d) => `\`${displayFile(d)}\``).join(', ')}`));
  }

  /** `linked`: the name is a document link, which VS Code adds to the hover (no link of its own then). */
  private async fileHover(paths: string[], range: vscode.Range, linked: boolean): Promise<vscode.Hover> {
    const file = await existing(paths);
    if (!file) {
      return this.missing(paths);
    }
    const info = await this.info(file);
    const links = linked ? [] : [link('Open in GDX Analyzer', SHOW_COMMAND, [[file]])];
    if (info.symbols.some((s) => s.type === 'Var' || s.type === 'Equ')) {
      links.push(link('Solution Report', REPORT_COMMAND, [file]));
    }
    return new vscode.Hover(markdown([filePreview(path.basename(file), info), ...(links.length ? [links.join(' · ')] : [])].join('\n\n')), range);
  }

  private async symbolHover(paths: string[], name: string, range: vscode.Range, token: vscode.CancellationToken, linked: boolean): Promise<vscode.Hover | undefined> {
    const file = await existing(paths);
    if (!file) {
      return this.missing(paths);
    }
    const info = await this.info(file);
    const symbol = name === UNIVERSE ? universeSymbol(info.version) : info.symbols.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!symbol) {
      return new vscode.Hover(markdown(`\`${path.basename(file)}\` has no symbol \`${name}\`.`), range);
    }
    let view: TableView | undefined;
    if (symbol.records <= MAX_PREVIEW_RECORDS) {
      const stat = await statFile(file);
      view = await cachedView(this.views, [file, stat.mtimeMs, stat.size, symbol.name].join('\0'), () => {
        const loaded =
          symbol.name === UNIVERSE
            ? this.service.loadUels(file).then((uels) => new TableView(universeTable(uels)))
            : // Set elements without text are shown empty (not "Y" as in the viewer).
              this.service.loadSymbolColumns(file, symbol).then((d) => new TableView({ ...columnTable(d.columns, d.keyCount, d.store, symbol), setTexts: false }));
        loaded.catch(() => this.views.forEach((v, k) => v === loaded && this.views.delete(k)));
        return loaded;
      });
      if (token.isCancellationRequested) return undefined;
    }
    const show = linked ? undefined : link('Show', SHOW_COMMAND, [[file], symbol.name]);
    return new vscode.Hover(markdown(symbolPreview(symbol, path.basename(file), view, defaultFormat(), show)), range);
  }
}

export function registerHovers(context: vscode.ExtensionContext, service: GdxService) {
  context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, new GdxHoverProvider(service)));
}
