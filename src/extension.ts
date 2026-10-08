import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffPanel, cleanupDiffStorage } from './diff';
import { DUMP_SCHEME, GdxDumpProvider, dumpUri } from './dump';
import { GdxSymbol } from './parse';
import { GdxService, describeTools } from './service';
import { textDecoder } from './tools';
import { ViewStateStore } from './viewState';
import { GdxViewerProvider } from './viewer';
import { registerGitCompare } from './gitCompare';
import { ScenarioPanel } from './scenarios';
import { registerLinks } from './links';
import { registerHovers } from './hovers';
import { registerMcpServer } from './mcpProvider';
import { postToActiveTable } from './tableHost';

const LARGE_FILE_BYTES = 100 * 1024 * 1024;
const GDX_FILTER = { 'GDX files': ['gdx'] };
/** Encodings offered by GDX: Select Encoding (GDX files store labels as bytes). */
const ENCODINGS: [string, string][] = [
  ['utf-8', 'Unicode (default)'],
  ['windows-1252', 'Western European (Latin-1)'],
  ['iso-8859-15', 'Western European (Latin-9)'],
  ['windows-1250', 'Central European'],
  ['iso-8859-2', 'Central European (Latin-2)'],
  ['windows-1251', 'Cyrillic'],
  ['koi8-r', 'Cyrillic (KOI8-R)'],
  ['windows-1253', 'Greek'],
  ['windows-1254', 'Turkish'],
  ['shift_jis', 'Japanese'],
  ['gbk', 'Simplified Chinese'],
  ['big5', 'Traditional Chinese'],
  ['euc-kr', 'Korean'],
];

function isKnownEncoding(label: string): boolean {
  try {
    textDecoder(label);
    return true;
  } catch {
    return false;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const service = new GdxService();
  const viewer = new GdxViewerProvider(context.extensionUri, service, new ViewStateStore(context.globalState), context.globalStorageUri);
  const dumps = new GdxDumpProvider(service);
  let selectedForCompare: vscode.Uri | undefined;

  for (const sub of ['diffs', 'copies', 'revisions']) cleanupDiffStorage(context.globalStorageUri, sub);
  registerMcpServer(context, service);
  registerLinks(context, (uri, symbol) => guarded('Opening the GDX file failed', showInViewer)(uri, symbol), hasSymbol);
  registerHovers(context, service);
  registerGitCompare(
    context,
    () => currentGdx(),
    (file1, file2, labels) => DiffPanel.show(context.extensionUri, context.globalStorageUri, service, file1, file2, labels),
    (err) => service.showError('Comparing with the Git revision failed', err),
  );

  /** The GDX file a command applies to: its argument, the active viewer or the active dump document. */
  function currentGdx(arg?: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) {
      return arg.scheme === DUMP_SCHEME ? vscode.Uri.file(JSON.parse(arg.query).file) : arg;
    }
    const active = viewer.active();
    if (active) {
      return active.uri;
    }
    const doc = vscode.window.activeTextEditor?.document.uri;
    if (doc?.scheme === DUMP_SCHEME) {
      return vscode.Uri.file(JSON.parse(doc.query).file);
    }
    if (doc?.scheme === 'file' && doc.fsPath.toLowerCase().endsWith('.gdx')) {
      return doc;
    }
    return undefined;
  }

  async function pickGdx(title: string, near?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const picked = await vscode.window.showOpenDialog({
      title,
      canSelectMany: false,
      filters: GDX_FILTER,
      defaultUri: near ? vscode.Uri.file(path.dirname(near.fsPath)) : vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    return picked?.[0];
  }

  async function gdxOrPick(arg: unknown, title: string): Promise<vscode.Uri | undefined> {
    return currentGdx(arg) ?? (await pickGdx(title));
  }

  /** Symbols of a file, from its open viewer if possible. */
  async function symbolsOf(uri: vscode.Uri): Promise<GdxSymbol[]> {
    const session = viewer.sessionFor(uri);
    if (session && session.symbols.length) {
      return session.symbols;
    }
    return (await service.loadFile(uri.fsPath)).symbols;
  }

  async function pickSymbol(uri: vscode.Uri, arg: unknown): Promise<string | undefined> {
    if (typeof arg === 'string') {
      return arg;
    }
    const symbols = await symbolsOf(uri);
    const selected = viewer.sessionFor(uri)?.selectedSymbol;
    const items = symbols.map((s) => ({
      label: s.name,
      description: `${s.type}${s.dim ? `(${s.domain.join(',')})` : ''} · ${s.records} records`,
      detail: s.text || undefined,
      picked: s.name === selected,
    }));
    const item = await vscode.window.showQuickPick(items, { title: `Symbol of ${path.basename(uri.fsPath)}`, matchOnDetail: true });
    return item?.label;
  }

  async function openDump(uri: vscode.Uri, symbol?: string) {
    if (!symbol) {
      const size = (await fs.promises.stat(uri.fsPath)).size;
      if (size > LARGE_FILE_BYTES) {
        const choice = await vscode.window.showWarningMessage(
          `${path.basename(uri.fsPath)} is ${(size / 1024 / 1024).toFixed(0)} MB. Dumping the whole file may take a while and use a lot of memory.`,
          'Dump Anyway',
          'Pick a Symbol',
        );
        if (choice === 'Pick a Symbol') {
          return vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', uri);
        }
        if (choice !== 'Dump Anyway') {
          return;
        }
      }
    }
    const doc = await vscode.workspace.openTextDocument(dumpUri(uri.fsPath, symbol));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Opens a GDX file in the viewer (or shows its open viewer), at a symbol if given. */
  async function showInViewer(uri: vscode.Uri, symbol?: string) {
    let session = viewer.sessionFor(uri);
    if (session) {
      session.reveal();
    } else {
      await vscode.commands.executeCommand('vscode.openWith', uri, GdxViewerProvider.viewType);
      session = viewer.sessionFor(uri);
    }
    if (!session || !symbol) {
      return;
    }
    // A file that cannot be read: the viewer shows why.
    if (!(await session.whenLoaded())) {
      return;
    }
    if (!session.showSymbol(symbol)) {
      vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} has no symbol ${symbol}.`);
    }
  }

  /** Whether a GDX file has a symbol: from its open viewer, else from gdxdump's symbol list (one call). */
  async function hasSymbol(file: string, symbol: string): Promise<boolean> {
    const wanted = symbol.toLowerCase();
    const session = viewer.sessionFor(vscode.Uri.file(file));
    const symbols = session?.symbols.length ? session.symbols : await service.loadSymbolList(file);
    return symbols.some((s) => s.name.toLowerCase() === wanted);
  }

  function compare(file1: vscode.Uri, file2: vscode.Uri) {
    if (file1.scheme !== 'file' || file2.scheme !== 'file') {
      vscode.window.showErrorMessage('Only GDX files on the local file system can be compared.');
      return;
    }
    DiffPanel.show(context.extensionUri, context.globalStorageUri, service, file1.fsPath, file2.fsPath);
  }

  function compareScenarios(uris: vscode.Uri[]) {
    if (uris.some((u) => u.scheme !== 'file')) {
      vscode.window.showErrorMessage('Only GDX files on the local file system can be compared.');
      return;
    }
    ScenarioPanel.show(context.extensionUri, service, uris.map((u) => u.fsPath));
  }

  /** Runs a command body and reports failures uniformly. */
  const guarded =
    (name: string, body: (...args: any[]) => unknown) =>
    async (...args: any[]) => {
      try {
        await body(...args);
      } catch (err) {
        await service.showError(name, err);
      }
    };

  context.subscriptions.push(
    service,
    dumps,
    vscode.window.registerCustomEditorProvider(GdxViewerProvider.viewType, viewer, {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.workspace.registerTextDocumentContentProvider(DUMP_SCHEME, dumps),

    vscode.commands.registerCommand(
      'gdxAnalyzer.open',
      guarded('Opening the GDX file failed', async (arg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Open GDX File');
        if (uri) {
          await vscode.commands.executeCommand('vscode.openWith', uri, GdxViewerProvider.viewType);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.dump',
      guarded('Dumping failed', async (arg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Dump GDX File');
        if (uri) {
          await openDump(uri);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.dumpSymbol',
      guarded('Dumping failed', async (arg?: unknown, symbolArg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Dump GDX Symbol');
        const symbol = uri && (await pickSymbol(uri, symbolArg));
        if (uri && symbol) {
          await openDump(uri, symbol);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.exportCsv',
      guarded('Exporting to CSV failed', async (arg?: unknown, symbolArg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Export GDX Symbol');
        const symbol = uri && (await pickSymbol(uri, symbolArg));
        if (!uri || !symbol) {
          return;
        }
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(path.dirname(uri.fsPath), `${symbol}.csv`)),
          filters: { 'CSV files': ['csv'] },
        });
        if (!target) {
          return;
        }
        const csv = await service.symbolCsv(uri.fsPath, symbol);
        await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
        const choice = await vscode.window.showInformationMessage(`Exported ${symbol} to ${path.basename(target.fsPath)}.`, 'Open');
        if (choice) {
          await vscode.window.showTextDocument(target);
        }
      }),
    ),

    vscode.commands.registerCommand('gdxAnalyzer.selectForCompare', (arg?: unknown) => {
      const uri = currentGdx(arg);
      if (uri) {
        selectedForCompare = uri;
        vscode.commands.executeCommand('setContext', 'gdxAnalyzer.hasSelectionForCompare', true);
        vscode.window.setStatusBarMessage(`Selected ${path.basename(uri.fsPath)} for GDX compare`, 3000);
      }
    }),

    vscode.commands.registerCommand(
      'gdxAnalyzer.compareWithSelected',
      guarded('gdxdiff failed', (arg?: unknown) => {
        const uri = currentGdx(arg);
        if (uri && selectedForCompare) {
          compare(selectedForCompare, uri);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.compare',
      guarded('gdxdiff failed', async (arg?: unknown, all?: unknown) => {
        const uris = Array.isArray(all) ? all.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
        if (uris.length === 2) {
          return compare(uris[0], uris[1]);
        }
        if (uris.length > 2) {
          // gdxdiff compares two files: more are compared as scenarios.
          return compareScenarios(uris);
        }
        const first = currentGdx(arg) ?? (await pickGdx('First GDX File'));
        const second = first && (await pickGdx(`Compare ${path.basename(first.fsPath)} with…`, first));
        if (first && second) {
          compare(first, second);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.compareScenarios',
      guarded('Comparing the scenarios failed', async (arg?: unknown, all?: unknown) => {
        let uris = Array.isArray(all) ? all.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
        if (uris.length < 2) {
          const first = currentGdx(arg);
          const picked = await vscode.window.showOpenDialog({
            title: first ? `Compare ${path.basename(first.fsPath)} with Scenarios` : 'Compare Scenarios (two or more GDX files)',
            canSelectMany: true,
            filters: GDX_FILTER,
            defaultUri: first ? vscode.Uri.file(path.dirname(first.fsPath)) : vscode.workspace.workspaceFolders?.[0]?.uri,
          });
          uris = [...(first ? [first] : []), ...(picked ?? []).filter((u) => !first || u.fsPath !== first.fsPath)];
        }
        if (uris.length < 2) {
          if (uris.length) vscode.window.showInformationMessage('Select at least two GDX files to compare as scenarios.');
          return;
        }
        compareScenarios(uris);
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.exportExcel',
      guarded('Exporting failed', async (arg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Export GDX File to Excel');
        if (!uri) {
          return;
        }
        let session = viewer.sessionFor(uri);
        if (!session) {
          await vscode.commands.executeCommand('vscode.openWith', uri, GdxViewerProvider.viewType);
          session = viewer.sessionFor(uri);
        }
        if (session && (await session.whenLoaded())) {
          session.openExport();
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.solutionReport',
      guarded('Showing the solution report failed', async (arg?: unknown) => {
        // A path from the link of a hover.
        const uri = typeof arg === 'string' ? vscode.Uri.file(arg) : await gdxOrPick(arg, 'Solution Report of GDX File');
        if (!uri) {
          return;
        }
        let session = viewer.sessionFor(uri);
        if (!session) {
          await vscode.commands.executeCommand('vscode.openWith', uri, GdxViewerProvider.viewType);
          session = viewer.sessionFor(uri);
        }
        if (!session || !(await session.whenLoaded())) {
          return;
        }
        if (!session.symbols.some((s) => s.type === 'Var' || s.type === 'Equ')) {
          vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} has no variables or equations.`);
          return;
        }
        session.showReport();
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.resetViewState',
      guarded('Resetting the viewer state failed', async (arg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Reset the Viewer State of');
        if (!uri) {
          return;
        }
        await viewer.states.clear(uri.fsPath);
        viewer.sessionFor(uri)?.resetState();
        vscode.window.setStatusBarMessage(`Reset the GDX viewer state of ${path.basename(uri.fsPath)}`, 3000);
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.selectEncoding',
      guarded('Changing the encoding failed', async () => {
        const cfg = vscode.workspace.getConfiguration('gdxAnalyzer');
        const current = cfg.get<string>('encoding', 'utf-8').trim().toLowerCase() || 'utf-8';
        const items = ENCODINGS.map(([label, description]) => ({ label, description, picked: label === current }));
        if (!items.some((i) => i.picked)) {
          items.unshift({ label: current, description: 'current', picked: true });
        }
        const other = { label: 'Other…', description: 'Any WHATWG encoding label', picked: false };
        const picked = await vscode.window.showQuickPick([...items, other], {
          title: 'Encoding of Labels and Texts in GDX Files',
          placeHolder: `Current: ${current}`,
        });
        let encoding = picked?.label;
        if (picked === other) {
          encoding = await vscode.window.showInputBox({
            title: 'Encoding of Labels and Texts in GDX Files',
            prompt: 'An encoding label such as windows-1252, iso-8859-2 or shift_jis',
            value: current,
            validateInput: (v) => (isKnownEncoding(v) ? undefined : `Unknown encoding "${v}"`),
          });
        }
        if (!encoding || encoding === current) {
          return;
        }
        // Where the setting is defined: the workspace keeps its own value.
        const inspected = cfg.inspect<string>('encoding');
        const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await cfg.update('encoding', encoding, target);
      }),
    ),

    // Like GAMS Studio's Ctrl+R: fit the columns of the active viewer or comparison to their content.
    vscode.commands.registerCommand('gdxAnalyzer.autoFitColumns', () => postToActiveTable({ type: 'autoFit' })),

    vscode.commands.registerCommand(
      'gdxAnalyzer.showToolInfo',
      guarded('Locating the GDX tools failed', async () => {
        const native = service.useGamsTools() ? 'GDX files: read and compared with gdxdump and gdxdiff' : 'GDX files: read and compared natively';
        let lines: string[];
        try {
          const tools = service.tools().tools;
          lines = [native, `Backend: ${describeTools(tools)}`, `gdxdump: ${tools.gdxdump}`, `gdxdiff: ${tools.gdxdiff}`];
        } catch (err) {
          // Reading natively needs no tools: say what else needs them.
          if (service.useGamsTools()) throw err;
          lines = [native, `gdxdump/gdxdiff (only used with gdxAnalyzer.useGamsTools): ${err instanceof Error ? err.message : String(err)}`];
        }
        lines.forEach((l) => service.log(l));
        const choice = await vscode.window.showInformationMessage(lines.slice(0, 2).join('. '), 'Show Log', 'Open Settings');
        if (choice === 'Show Log') {
          service.output.show();
        } else if (choice === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'gdxAnalyzer.');
        }
      }),
    ),
  );
}

export function deactivate() {}
