/*
 * Tests of the web extension, executed in VS Code for the Web (a web worker in a browser, see
 * runWeb.ts): the fixtures are in a virtual workspace folder (vscode-test-web://mount/), so they are
 * read with vscode.workspace.fs, as files of github.dev are. Bundled by scripts/build-web.mjs --tests
 * with the web variants of the modules, like the extension.
 */
import * as vscode from 'vscode';
import { compareFiles, loadDumpText, loadFileInfo, loadSymbolColumns, loadSymbolCsv } from '../../gdxFile';
import { writeGdxSubset } from '../../gdxSubset';
import { fileKey, fileUri } from '../../platform/files.web';
import { writeXlsx } from '../../xlsx';
import { readXlsx } from '../../xlsxRead';

const folder = () => vscode.workspace.workspaceFolders![0].uri;
const fixture = (...names: string[]) => vscode.Uri.joinPath(folder(), ...names);
const source = { encoding: 'utf-8', tools: () => fail('no gdxdump in the browser') };

function fail(message: string): never {
  throw new Error(message);
}

function ok(value: unknown, message: string) {
  if (!value) fail(message);
}

function equal<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function matches(text: string | undefined, rx: RegExp, what: string) {
  if (text === undefined || !rx.test(text)) fail(`${what}: ${rx} does not match ${JSON.stringify(text?.slice(0, 500))}`);
}

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) fail(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const activeText = () => vscode.window.activeTextEditor?.document.getText();
const activeTabInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;

/** A file system in memory (the scheme gdxtest-mem), to write files to, as files of other file systems are. */
class MemFs implements vscode.FileSystemProvider {
  private readonly entries = new Map<string, { data?: Uint8Array; mtime: number }>([['/', { mtime: Date.now() }]]);
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  watch() {
    return new vscode.Disposable(() => {});
  }
  private entry(uri: vscode.Uri) {
    const e = this.entries.get(uri.path.replace(/\/$/, '') || '/');
    if (!e) throw vscode.FileSystemError.FileNotFound(uri);
    return e;
  }
  stat(uri: vscode.Uri): vscode.FileStat {
    const e = this.entry(uri);
    return { type: e.data ? vscode.FileType.File : vscode.FileType.Directory, ctime: e.mtime, mtime: e.mtime, size: e.data?.length ?? 0 };
  }
  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const dir = uri.path.replace(/\/$/, '');
    return [...this.entries.keys()]
      .filter((p) => p !== dir && p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map((p) => [p.slice(dir.length + 1), this.entries.get(p)!.data ? vscode.FileType.File : vscode.FileType.Directory]);
  }
  createDirectory(uri: vscode.Uri) {
    this.entries.set(uri.path.replace(/\/$/, ''), { mtime: Date.now() });
  }
  readFile(uri: vscode.Uri): Uint8Array {
    return this.entry(uri).data ?? fail(`${uri} is a directory`);
  }
  writeFile(uri: vscode.Uri, content: Uint8Array) {
    this.entries.set(uri.path, { data: content, mtime: Date.now() });
  }
  delete(uri: vscode.Uri) {
    for (const p of [...this.entries.keys()]) if (p === uri.path || p.startsWith(`${uri.path}/`)) this.entries.delete(p);
  }
  rename(from: vscode.Uri, to: vscode.Uri) {
    this.writeFile(to, this.readFile(from));
    this.delete(from);
  }
}

const mem = (name: string) => vscode.Uri.from({ scheme: 'gdxtest-mem', path: `/${name}` });

const tests: [string, () => Promise<void>][] = [
  [
    'opens GDX files of a virtual file system with the custom editor',
    async () => {
      await vscode.commands.executeCommand('vscode.open', fixture('transport1.gdx'));
      const tab = await waitFor('viewer tab', () => {
        const input = activeTabInput();
        return input instanceof vscode.TabInputCustom ? input : undefined;
      });
      equal(tab.viewType, 'gdxAnalyzer.viewer', 'view type');
      equal(tab.uri.toString(), fixture('transport1.gdx').toString(), 'uri');
    },
  ],
  [
    'dumps files and symbols',
    async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.dump', fixture('transport1.gdx'));
      const all = await waitFor('full dump', () => (activeText()?.includes('Parameter a(i)') ? activeText() : undefined));
      matches(all, /Scalar f freight in dollars per case per thousand miles \/ 90 \/;/, 'dump');
      await vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', fixture('transport1.gdx'), 'x');
      const x = await waitFor('symbol dump', () => (activeText()?.includes('Variable x') ? activeText() : undefined));
      matches(x, /positive Variable x\(i,j\) shipment quantities in cases/, 'symbol dump');
    },
  ],
  [
    'reads GDX files with vscode.workspace.fs, compressed ones with fflate',
    async () => {
      const t1 = fileKey(fixture('transport1.gdx'));
      equal(t1, '/vscode-test-web/@mount/transport1.gdx', 'file name');
      const info = await loadFileInfo(source, t1);
      equal(info.symbols.length, 14, 'symbols');
      const x = info.symbols.find((s) => s.name === 'x')!;
      const columns = await loadSymbolColumns(source, t1, x);
      equal(columns.store.length, 6, 'records of x');
      // The compressed files of format versions 6 and 7 read as the uncompressed ones.
      const dump = (name: string) => loadDumpText(source, fileKey(fixture('formats', name)));
      equal(await dump('transport1_v6c.gdx'), await dump('transport1_v6u.gdx'), 'compressed version 6');
      equal(await dump('transport1_v7c.gdx'), await loadDumpText(source, t1), 'compressed version 7');
    },
  ],
  [
    'reads every fixture exactly as the desktop extension does',
    async () => {
      // Written by runWeb.ts with the desktop modules (file handles of Node.js and its zlib).
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'gdx-analyzer')!;
      const expected: { file: string; encoding: string; dump: string; symbols: string; csv: Record<string, string> }[] = JSON.parse(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, 'out-web', 'test', 'expected.json'))),
      );
      ok(expected.length >= 13, `expected results of all fixtures (${expected.length})`);
      for (const e of expected) {
        const src = { ...source, encoding: e.encoding };
        const file = fileKey(fixture(...e.file.split('/')));
        const what = `${e.file} (${e.encoding})`;
        equal(JSON.stringify((await loadFileInfo(src, file)).symbols), e.symbols, `symbols of ${what}`);
        equal(await loadDumpText(src, file), e.dump, `dump of ${what}`);
        for (const [name, csv] of Object.entries(e.csv)) equal(await loadSymbolCsv(src, file, name), csv, `CSV of ${name} in ${what}`);
      }
    },
  ],
  [
    'compares files and saves symbols as GDX into another file system',
    async () => {
      const t1 = fileKey(fixture('transport1.gdx'));
      const t2 = fileKey(fixture('transport2.gdx'));
      const diff = fileKey(mem('diff.gdx'));
      const result = await compareFiles(source, t1, t2, diff, {});
      equal(result.exitCode, 1, 'gdxdiff exit code');
      matches(result.stdout, /Summary of differences/i, 'summary');
      const symbols = (await loadFileInfo(source, diff)).symbols.map((s) => s.name);
      ok(symbols.includes('x'), `x differs (${symbols.join(', ')})`);

      const subset = fileKey(mem('subset.gdx'));
      const written = await writeGdxSubset(t1, subset, [{ name: 'a' }, { name: 'x' }]);
      equal(written.symbols.join(','), 'a,x', 'symbols written');
      matches(await loadDumpText(source, subset, 'a'), /'seattle' 350,\s*\n'san-diego' 600 \/;/, 'saved records of a');
    },
  ],
  [
    'writes and reads Excel workbooks (deflate with fflate)',
    async () => {
      const book = writeXlsx([{ name: 'a', rows: [[{ v: 'i' }, { v: 'value' }], [{ v: 'seattle' }, { v: 350 }], [{ v: 'san-diego' }, { v: 600.5 }]] }]);
      const read = readXlsx(Buffer.from(book));
      equal(read.sheets.join(','), 'a', 'sheets');
      equal(JSON.stringify(read.rows('a')), JSON.stringify([['i', 'value'], ['seattle', '350'], ['san-diego', '600.5']]), 'cells');
    },
  ],
  [
    'compares files and scenarios in panels',
    async () => {
      await vscode.commands.executeCommand('gdxAnalyzer.compare', fixture('transport1.gdx'), [fixture('transport1.gdx'), fixture('transport2.gdx')]);
      await waitFor('diff panel', () => {
        const input = activeTabInput();
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('gdxAnalyzer.diff') ? input : undefined;
      });
      await vscode.commands.executeCommand('gdxAnalyzer.compareScenarios', fixture('transport1.gdx'), [fixture('transport1.gdx'), fixture('transport2.gdx'), fixture('pair1.gdx')]);
      await waitFor('scenario panel', () => {
        const input = activeTabInput();
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('gdxAnalyzer.scenarios') ? input : undefined;
      });
    },
  ],
  [
    'links GDX files and symbols in GAMS source to the viewer',
    async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const gms = await vscode.workspace.openTextDocument({ language: 'gams', content: "$gdxIn transport1\n$load a d=dist\n$gdxIn\nexecute_unload 'results.gdx', x;\n" });
      const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', gms.uri);
      equal(links.map((l) => gms.getText(l.range)).sort().join(','), 'a,dist,results.gdx,transport1,x', 'links');
      const link = links.find((l) => gms.getText(l.range) === 'a')!;
      await vscode.commands.executeCommand(link.target!.path, ...JSON.parse(decodeURIComponent(link.target!.query)));
      const tab = await waitFor('viewer tab from a link', () => {
        const input = activeTabInput();
        return input instanceof vscode.TabInputCustom && input.viewType === 'gdxAnalyzer.viewer' ? input : undefined;
      });
      equal(tab.uri.toString(), fixture('transport1.gdx').toString(), 'linked file');
    },
  ],
  [
    'previews GDX files and symbols on hover in GAMS and GAMSPy source',
    async () => {
      const hover = async (doc: vscode.TextDocument, line: number, text: string) => {
        // On the first character of the first occurrence of `text` as a whole word (after a quote, on the name).
        const quoted = text.startsWith('"');
        const character = quoted ? doc.lineAt(line).text.indexOf(text) + 1 : doc.lineAt(line).text.search(new RegExp(`\\b${text.replace(/\./g, '\\.')}\\b`));
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character));
        return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      };
      const gms = await vscode.workspace.openTextDocument({ language: 'gams', content: "$gdxIn transport1\n$load a\n$gdxIn\nParameter total; total = x.l('seattle','chicago');\nexecute_unload 'not_written_yet.gdx', total;\n" });
      matches(await hover(gms, 0, 'transport1'), /\*\*transport1\.gdx\*\* · 14 symbols/, 'file hover');
      matches(await hover(gms, 1, 'a'), /\*\*a\(i\)\*\* · Parameter · 2 records[\s\S]*\| seattle \| 350 \|/, 'symbol hover');
      matches(await hover(gms, 3, 'x.l'), /\*\*x\(i,j\)\*\* · Positive Variable · 6 records/, 'name hover');
      matches(await hover(gms, 4, 'not_written_yet'), /`not_written_yet\.gdx` does not exist \(yet\)/, 'missing file');
      const py = await vscode.workspace.openTextDocument({ language: 'python', content: 'import gamspy as gp\nm = gp.Container(load_from="transport1.gdx")\nlimit = gp.Equation(m, name="supply", domain=m["i"])\n' });
      matches(await hover(py, 2, 'limit'), /^\*\*supply\(i\)\*\* · Equation/, 'GAMSPy hover');
    },
  ],
  [
    'names files of URIs with a query (e.g. revisions in Source Control diffs) and without an authority',
    async () => {
      const revision = vscode.Uri.from({ scheme: 'gdxtest-mem', path: '/rev/transport2.gdx', query: '{"ref":"HEAD~1"}' });
      const key = fileKey(revision);
      equal(key, '/gdxtest-mem/@/!%7B%22ref%22%3A%22HEAD~1%22%7D/rev/transport2.gdx', 'key with a query');
      equal(fileUri(key).toString(), revision.toString(), 'URI of the key');
      equal(fileUri(fileKey(folder())).toString(), folder().toString(), 'workspace folder');
      await vscode.workspace.fs.createDirectory(mem('rev'));
      await vscode.workspace.fs.writeFile(revision, await vscode.workspace.fs.readFile(fixture('transport2.gdx')));
      await vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', revision, 'a');
      const text = await waitFor('dump of the revision', () => (activeText()?.includes('Parameter a(i)') ? activeText() : undefined));
      matches(text, /'seattle' 360,/, 'records of the revision');
      // Source Control shows a changed GDX file as a diff of its two versions in the viewer.
      await vscode.commands.executeCommand('vscode.diff', revision, fixture('transport1.gdx'), 'transport (HEAD~1 ↔ working tree)');
      // VS Code names a diff of custom editors after the two files.
      await waitFor('diff of two GDX files', () => {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        return tab?.label === 'transport2.gdx ↔ transport1.gdx' ? tab : undefined;
      });
    },
  ],
  [
    'hides the commands that need the desktop',
    async () => {
      const commands = await vscode.commands.getCommands(true);
      ok(commands.includes('gdxAnalyzer.open'), 'gdxAnalyzer.open is registered');
      for (const c of ['gdxAnalyzer.copyMcpServerConfig', 'gdxAnalyzer.compareWithRevision', 'gdxAnalyzer.setUpGitDiff']) {
        ok(!commands.includes(c), `${c} is not registered`);
      }
    },
  ],
];

export async function run(): Promise<void> {
  // If the extension cannot be activated, every test would wait for its timeouts: stop with the reason instead.
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'gdx-analyzer');
  if (!ext) fail('The extension under test is not loaded.');
  await ext.activate();
  const disposable = vscode.workspace.registerFileSystemProvider('gdxtest-mem', new MemFs());
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ✔ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✖ ${name}\n${err instanceof Error ? err.stack : err}`);
      }
    }
  } finally {
    disposable.dispose();
  }
  if (failed) {
    throw new Error(`${failed} web test(s) failed`);
  }
}
