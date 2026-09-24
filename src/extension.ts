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
import { registerMcpServer } from './mcpProvider';

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
  // Platform-specific packages carry gdxdump/gdxdiff in bin/ (see scripts/package.sh).
  const service = new GdxService(path.join(context.extensionPath, 'bin'));
  const viewer = new GdxViewerProvider(context.extensionUri, service, new ViewStateStore(context.globalState));
  const dumps = new GdxDumpProvider(service);
  let selectedForCompare: vscode.Uri | undefined;

  cleanupDiffStorage(context.globalStorageUri);
  registerMcpServer(context, service);

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

  function compare(file1: vscode.Uri, file2: vscode.Uri) {
    if (file1.scheme !== 'file' || file2.scheme !== 'file') {
      vscode.window.showErrorMessage('Only GDX files on the local file system can be compared.');
      return;
    }
    DiffPanel.show(context.extensionUri, context.globalStorageUri, service, file1.fsPath, file2.fsPath);
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
      guarded('gdxdump failed', async (arg?: unknown) => {
        const uri = await gdxOrPick(arg, 'Dump GDX File');
        if (uri) {
          await openDump(uri);
        }
      }),
    ),

    vscode.commands.registerCommand(
      'gdxAnalyzer.dumpSymbol',
      guarded('gdxdump failed', async (arg?: unknown, symbolArg?: unknown) => {
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
        const csv = await service.tools().dump(uri.fsPath, { symbol, format: 'csv', csvAllFields: true, csvSetText: true });
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
          vscode.window.showWarningMessage('Select exactly two GDX files to compare.');
          return;
        }
        const first = currentGdx(arg) ?? (await pickGdx('First GDX File'));
        const second = first && (await pickGdx(`Compare ${path.basename(first.fsPath)} with…`, first));
        if (first && second) {
          compare(first, second);
        }
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
        await session?.whenLoaded();
        session?.openExport();
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

    vscode.commands.registerCommand(
      'gdxAnalyzer.showToolInfo',
      guarded('Locating the GDX tools failed', async () => {
        const tools = service.tools().tools;
        const lines = [`Backend: ${describeTools(tools)}`, `gdxdump: ${tools.gdxdump}`, `gdxdiff: ${tools.gdxdiff}`];
        lines.forEach((l) => service.log(l));
        const choice = await vscode.window.showInformationMessage(lines[0], 'Show Log', 'Open Settings');
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
