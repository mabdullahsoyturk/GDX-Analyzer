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
  await vscode.commands.executeCommand('gdx.dump', t1);
  const all = await waitFor(`${label}: full dump`, () => (activeText()?.includes('Parameter a(i)') ? activeText() : undefined));
  assert.match(all, /Scalar f freight in dollars per case per thousand miles \/ 90 \/;/);
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'gdxdump');

  await vscode.commands.executeCommand('gdx.dumpSymbol', t1, 'x');
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
      assert.equal(tab.viewType, 'gdx.viewer');
      assert.equal(tab.uri.fsPath, t1.fsPath);
    },
  ],
  ['dumps files and symbols (GAMS backend)', () => dumpTests('gams')],
  [
    'compares files without errors',
    async () => {
      await vscode.commands.executeCommand('gdx.compare', t1, [t1, t2]);
      const tab = await waitFor('diff panel', () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputWebview && input.viewType.endsWith('gdx.diff') ? input : undefined;
      });
      assert.ok(tab);
    },
  ],
  [
    'registers the MCP server for AI agents',
    async () => {
      const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'gdx-viewer');
      assert.ok(ext?.isActive);
      assert.deepEqual(ext.packageJSON.contributes.mcpServerDefinitionProviders, [{ id: 'gdx.mcp', label: 'GDX' }]);
      assert.ok((await vscode.commands.getCommands(true)).includes('gdx.copyMcpServerConfig'));
    },
  ],
  [
    'reads labels with the configured encoding',
    async () => {
      const latin1 = vscode.Uri.file(path.join(fixtures, 'latin1.gdx'));
      const cfg = vscode.workspace.getConfiguration('gdx');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('gdx.dumpSymbol', latin1, 'c');
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
      const cfg = vscode.workspace.getConfiguration('gdx');
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
