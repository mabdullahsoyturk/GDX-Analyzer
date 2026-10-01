/* Integration tests, executed inside the VS Code extension host. */
import assert from 'node:assert/strict';
import * as path from 'path';
import * as vscode from 'vscode';

const fixtures = path.resolve(__dirname, '../../../test/fixtures');
const t1 = vscode.Uri.file(path.join(fixtures, 'transport1.gdx'));
const t2 = vscode.Uri.file(path.join(fixtures, 'transport2.gdx'));

async function waitFor<T>(what: string, fn: () => T | undefined, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function activeText(): string | undefined {
  return vscode.window.activeTextEditor?.document.getText();
}

async function dumpTests(label: string) {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gdxAnalyzer.dump', t1);
  const all = await waitFor(`${label}: full dump`, () => (activeText()?.includes('Parameter a(i)') ? activeText() : undefined));
  assert.match(all, /Scalar f freight in dollars per case per thousand miles \/ 90 \/;/);
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'gdxdump');

  await vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', t1, 'x');
  const x = await waitFor(`${label}: symbol dump`, () => (activeText()?.includes('Variable x') ? activeText() : undefined));
  assert.match(x, /positive Variable x\(i,j\) shipment quantities in cases/);
  assert.doesNotMatch(x, /Parameter a/);
}

const tests: [string, () => Promise<void>][] = [
  [
    'opens GDX files with the custom editor',
    async () => {
      await vscode.commands.executeCommand('vscode.open', t1);
      const tab = await waitFor('viewer tab', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom ? input : undefined;
      });
      assert.equal(tab.viewType, 'gdxAnalyzer.viewer');
      assert.equal(tab.uri.fsPath, t1.fsPath);
    },
  ],
  ['dumps files and symbols (GAMS backend)', () => dumpTests('gams')],
  [
    'compares files without errors',
    async () => {
      await vscode.commands.executeCommand('gdxAnalyzer.compare', t1, [t1, t2]);
      const tab = await waitFor('diff panel', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('gdxAnalyzer.diff') ? input : undefined;
      });
      assert.ok(tab);
    },
  ],
  [
    'links GDX files and symbols in GAMS and Python source to the viewer',
    async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const gms = await vscode.workspace.openTextDocument({
        language: 'gams',
        content: "* reads the fixture\n$gdxIn transport1\n$load a d=dist\n$gdxIn\nexecute_unload 'results.gdx', x;\n",
      });
      const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', gms.uri);
      assert.deepEqual(links.map((l) => gms.getText(l.range)).sort(), ['a', 'dist', 'results.gdx', 'transport1', 'x']);
      // A link runs the command of its target with the candidate paths and the symbol.
      const follow = (link: vscode.DocumentLink) => {
        const target = link.target!;
        assert.equal(target.scheme, 'command');
        return vscode.commands.executeCommand(target.path, ...JSON.parse(decodeURIComponent(target.query)));
      };
      await follow(links.find((l) => gms.getText(l.range) === 'a')!);
      const tab = await waitFor('viewer tab from a link', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === 'gdxAnalyzer.viewer' ? input : undefined;
      });
      assert.equal(tab.uri.fsPath, t1.fsPath);

      const py = await vscode.workspace.openTextDocument({ language: 'python', content: 'from gamspy import Container\nm = Container(load_from="transport2.gdx")\n' });
      const pyLinks = await vscode.commands.executeCommand<vscode.DocumentLink[]>('vscode.executeLinkProvider', py.uri);
      assert.deepEqual(pyLinks.map((l) => py.getText(l.range)), ['transport2.gdx']);
      assert.ok((await vscode.commands.getCommands(true)).includes('gdxAnalyzer.showSymbol'));
    },
  ],
  [
    'previews GDX files and symbols on hover in GAMS source',
    async () => {
      const gms = await vscode.workspace.openTextDocument({
        language: 'gams',
        content: "$gdxIn transport1\n$load a\n$gdxIn\nParameter total; total = sum(i, a(i)) + x.l('seattle','chicago');\nexecute_unload 'not_written_yet.gdx', total;\n",
      });
      const hover = async (line: number, text: string) => {
        // On the first character of the first occurrence of `text` as a whole word.
        const character = gms.lineAt(line).text.search(new RegExp(`\\b${text.replace(/\./g, '\\.')}\\b`));
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', gms.uri, new vscode.Position(line, character));
        return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      };
      const file = await hover(0, 'transport1');
      assert.match(file, /\*\*transport1\.gdx\*\* · 14 symbols: 2 sets, 1 alias, 6 parameters, 2 variables, 3 equations/);
      assert.match(file, /\[Solution Report\]\(command:gdxAnalyzer\.solutionReport\?/);
      assert.match(await hover(1, 'a'), /\*\*a\(i\)\*\* · Parameter · 2 records[\s\S]*\| seattle \| 350 \|/);
      // Any name of a symbol of a file the document references.
      const x = await hover(3, 'x.l');
      assert.match(x, /\*\*x\(i,j\)\*\* · Positive Variable · 6 records/);
      assert.match(x, /Solution: 0 outside bounds · 2 non-zero marginal/);
      // The link to the viewer ends the first line (names in $load etc. are document links instead).
      assert.match(x, /^\*\*x\(i,j\)\*\* .* · \[Show\]\(command:gdxAnalyzer\.showInViewer\?/m);
      assert.doesNotMatch(await hover(1, 'a'), /\[Show\]/);
      assert.equal(await hover(3, 'total'), '');
      assert.match(await hover(4, 'not_written_yet'), /`not_written_yet\.gdx` does not exist \(yet\)/);
    },
  ],
  [
    'previews GDX symbols on hover in GAMSPy code and notebooks',
    async () => {
      const hoverAt = async (doc: vscode.TextDocument, line: number, text: string) => {
        // On the first character of `text` (after a quote, on the name).
        const character = doc.lineAt(line).text.indexOf(text) + (text.startsWith('"') ? 1 : 0);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character));
        return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      };
      const py = await vscode.workspace.openTextDocument({
        language: 'python',
        content: [
          'import gamspy as gp',
          'm = gp.Container(load_from="transport1.gdx")',
          'limit = gp.Equation(m, name="supply", domain=m["i"])',
          'dist = m.addParameter("d")',
          'm.write("not_written_yet.gdx", symbol_names=["x"])',
        ].join('\n'),
      });
      // Python names bound to symbols of other names.
      assert.match(await hoverAt(py, 2, 'limit'), /^\*\*supply\(i\)\*\* · Equation/);
      assert.match(await hoverAt(py, 3, 'dist'), /^\*\*d\(i,j\)\*\* · Parameter/);
      // m["i"] of the container read from the file; the symbols written to a file that does not exist yet.
      assert.match(await hoverAt(py, 2, '"i"'), /^\*\*i\(\\\*\)\*\* · Set/);
      assert.match(await hoverAt(py, 4, '"x"'), /`not_written_yet\.gdx` does not exist/);

      // A notebook: the file is read in the first cell, its symbols are used in the second.
      const nb = await vscode.workspace.openNotebookDocument(
        'jupyter-notebook',
        new vscode.NotebookData([
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'import gamspy as gp\nm = gp.Container(load_from="transport1.gdx")', 'python'),
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'cost = m["c"]\ncost.records', 'python'),
        ]),
      );
      const cell = nb.cellAt(1).document;
      assert.match(await hoverAt(cell, 0, '"c"'), /^\*\*c\(i,j\)\*\* · Parameter/);
      assert.match(await hoverAt(cell, 1, 'cost'), /^\*\*c\(i,j\)\*\* · Parameter/);
    },
  ],
  [
    'compares a GDX file with its Git revision and views Git revisions',
    async () => {
      // The fixtures are committed in the repository of the extension, a parent of the workspace folder
      // (which VS Code only opens when asked).
      const git = vscode.extensions.getExtension<any>('vscode.git');
      const api = (git!.isActive ? git!.exports : await git!.activate()).getAPI(1);
      await api.openRepository(vscode.Uri.file(path.resolve(fixtures, '../..')));
      await waitFor('Git repository', () => api.getRepository(t1) ?? undefined);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.compareWithRevision', t1, 'HEAD');
      const tab = await waitFor('comparison with HEAD', () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('gdxAnalyzer.diff') ? t : undefined;
      });
      assert.equal(tab.label, 'transport1.gdx @ HEAD ↔ transport1.gdx (working tree)');
      // Two revisions with each other.
      await vscode.commands.executeCommand('gdxAnalyzer.compareWithRevision', t1, 'HEAD~1', 'HEAD');
      await waitFor('comparison of two revisions', () => (vscode.window.tabGroups.activeTabGroup.activeTab?.label === 'transport1.gdx @ HEAD~1 ↔ transport1.gdx @ HEAD' ? true : undefined));
      // A git: URI (as in the diff editor of Source Control) opens in the viewer through a copy.
      await vscode.commands.executeCommand('vscode.openWith', api.toGitUri(t1, 'HEAD'), 'gdxAnalyzer.viewer');
      const viewer = await waitFor('viewer of the Git revision', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.uri.scheme === 'git' ? input : undefined;
      });
      assert.equal(viewer.viewType, 'gdxAnalyzer.viewer');
    },
  ],
  [
    'compares scenarios, also when comparing more than two files',
    async () => {
      const scenarioTab = (what: string) =>
        waitFor(what, () => {
          const t = vscode.window.tabGroups.activeTabGroup.activeTab;
          return t?.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('gdxAnalyzer.scenarios') ? t : undefined;
        });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.compareScenarios', t1, [t1, t2]);
      assert.equal((await scenarioTab('scenario panel')).label, 'Scenarios: transport1, transport2');
      // gdxdiff compares two files: "Compare GDX Files" with three compares them as scenarios.
      const types = vscode.Uri.file(path.join(fixtures, 'types.gdx'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.compare', t1, [t1, t2, types]);
      assert.equal((await scenarioTab('scenario panel of three files')).label, 'Scenarios: transport1, transport2, types');
    },
  ],
  [
    'opens the solution report of a file in the viewer',
    async () => {
      const solution = vscode.Uri.file(path.join(fixtures, 'solution.gdx'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.solutionReport', solution);
      const tab = await waitFor('viewer tab', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === 'gdxAnalyzer.viewer' ? input : undefined;
      });
      assert.equal(tab.uri.fsPath, solution.fsPath);
    },
  ],
  [
    'registers the MCP server for AI agents',
    async () => {
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'gdx-analyzer');
      assert.ok(ext?.isActive);
      assert.deepEqual(ext.packageJSON.contributes.mcpServerDefinitionProviders, [{ id: 'gdxAnalyzer.mcp', label: 'GDX' }]);
      assert.ok((await vscode.commands.getCommands(true)).includes('gdxAnalyzer.copyMcpServerConfig'));
    },
  ],
  [
    'reads labels with the configured encoding',
    async () => {
      const latin1 = vscode.Uri.file(path.join(fixtures, 'latin1.gdx'));
      const cfg = vscode.workspace.getConfiguration('gdxAnalyzer');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdxAnalyzer.dumpSymbol', latin1, 'c');
      await waitFor('UTF-8 dump', () => (activeText()?.includes('�') ? activeText() : undefined));
      try {
        // The open dump is read again when the setting changes.
        await cfg.update('encoding', 'windows-1252', vscode.ConfigurationTarget.Global);
        const text = await waitFor('Latin-1 dump', () => (activeText()?.includes('stück') ? activeText() : undefined));
        assert.match(text, /Größe/);
      } finally {
        await cfg.update('encoding', undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
  [
    'dumps files and symbols (GAMSPy backend)',
    async () => {
      const gamspy = process.env.GDX_TEST_GAMSPY;
      if (!gamspy) {
        console.log('    (skipped: GDX_TEST_GAMSPY not set)');
        return;
      }
      const cfg = vscode.workspace.getConfiguration('gdxAnalyzer');
      await cfg.update('backend', 'gamspy', vscode.ConfigurationTarget.Global);
      await cfg.update('gamspyExecutable', gamspy, vscode.ConfigurationTarget.Global);
      try {
        await dumpTests('gamspy');
      } finally {
        await cfg.update('backend', undefined, vscode.ConfigurationTarget.Global);
        await cfg.update('gamspyExecutable', undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
];

export async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✖ ${name}\n${err instanceof Error ? err.stack : err}`);
    }
  }
  if (failed) {
    throw new Error(`${failed} integration test(s) failed`);
  }
}
