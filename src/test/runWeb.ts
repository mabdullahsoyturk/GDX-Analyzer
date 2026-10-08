/*
 * Runs the tests of the web extension (src/test/web, bundled by scripts/build-web.mjs --tests into
 * out-web/test) in VS Code for the Web, in a headless Chromium, with test/fixtures as the workspace
 * folder (a virtual file system). Set GDX_TEST_WEB_QUALITY to "insiders" to test with VS Code Insiders.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-web';
import { loadDumpText, loadFileInfo, loadSymbolCsv } from '../gdxFile';

/** What the desktop extension reads of a fixture: its gdxdump text, symbols and the CSV of each symbol. */
export interface Expected {
  file: string;
  encoding: string;
  dump: string;
  symbols: string;
  csv: Record<string, string>;
}

/** Reads all fixtures as the desktop extension does, for the web tests to compare (out-web/test/expected.json). */
async function writeExpected(fixtures: string, target: string) {
  const files = ['', 'formats'].flatMap((dir) => fs.readdirSync(path.join(fixtures, dir)).filter((n) => n.endsWith('.gdx')).map((n) => path.posix.join(dir, n)));
  const expected: Expected[] = [];
  for (const file of files) {
    for (const encoding of file === 'latin1.gdx' ? ['utf-8', 'windows-1252'] : ['utf-8']) {
      const source = { encoding, tools: () => { throw new Error('no gdxdump'); } };
      const full = path.join(fixtures, file);
      const info = await loadFileInfo(source, full);
      const csv: Record<string, string> = {};
      for (const s of info.symbols) csv[s.name] = await loadSymbolCsv(source, full, s.name);
      expected.push({ file, encoding, dump: await loadDumpText(source, full), symbols: JSON.stringify(info.symbols), csv });
    }
  }
  fs.writeFileSync(target, JSON.stringify(expected));
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  try {
    await writeExpected(path.join(root, 'test', 'fixtures'), path.join(root, 'out-web', 'test', 'expected.json'));
    await runTests({
      browserType: 'chromium',
      headless: true,
      quality: process.env.GDX_TEST_WEB_QUALITY === 'insiders' ? 'insiders' : 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'out-web', 'test', 'index.js'),
      folderPath: path.join(root, 'test', 'fixtures'),
      testRunnerDataDir: path.join(root, '.vscode-test-web'),
    });
  } catch (err) {
    console.error('Web tests failed:', err);
    process.exitCode = 1;
  }
}

main();
