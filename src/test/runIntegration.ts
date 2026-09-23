/*
 * Runs the integration tests in a VS Code extension host. Set VSCODE_EXECUTABLE to
 * use an installed VS Code instead of downloading one, and GDX_TEST_GAMSPY to also
 * test the GAMSPy CLI backend with a specific gamspy executable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '../..');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-vscode-'));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'integration', 'index'),
      launchArgs: [path.join(root, 'test', 'fixtures'), '--disable-extensions', `--user-data-dir=${userDataDir}`],
    });
  } catch (err) {
    console.error('Integration tests failed:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main();
