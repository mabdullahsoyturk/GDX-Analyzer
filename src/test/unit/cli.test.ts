/*
 * The command line (cli.ts) and git diff of GDX files as text (gitTextconv.ts): the launcher, the
 * textconv command and the attribute files, and `git diff` of a repository set up with them.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../../cli';
import { loadDumpText, loadSymbolCsv } from '../../gdxFile';
import { configureDiffDriver, hasGdxAttribute, launcherScript, shellQuote, textconvCommand, withGdxAttribute } from '../../gitTextconv';
import { findOnPath } from '../../tools';

const fixtures = path.resolve(__dirname, '../../../test/fixtures');
const cli = path.resolve(__dirname, '../../cli.js');
const native = { encoding: 'utf-8', tools: () => assert.fail('no tools needed') };
// Without GAMS tools: the native reader only, as without a GAMS installation.
const env = { GDX_BACKEND: 'gams', GDX_GAMS_SYSTEM_DIRECTORY: path.join(os.tmpdir(), 'no-gams-here') };

async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(typeof t === 'string' ? t : Buffer.from(t).toString('utf8')), stderr: (t) => err.push(t), env });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-cli-test-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('command line', () => {
  it('dumps a file, a symbol and a symbol as CSV as gdxdump does', async () => {
    const file = path.join(fixtures, 'transport1.gdx');
    assert.deepEqual(await run('dump', file), { code: 0, stdout: await loadDumpText(native, file), stderr: '' });
    assert.equal((await run('dump', file, 'x')).stdout, await loadDumpText(native, file, 'x'));
    assert.equal((await run('dump', file, 'x', '--csv')).stdout, await loadSymbolCsv(native, file, 'x'));
    const latin1 = await run('dump', path.join(fixtures, 'latin1.gdx'), '--encoding', 'windows-1252');
    assert.equal(latin1.stdout, await loadDumpText({ ...native, encoding: 'windows-1252' }, path.join(fixtures, 'latin1.gdx')));
  });

  it('reports wrong arguments and unreadable files', async () => {
    for (const argv of [[], ['view', 'a.gdx'], ['dump'], ['dump', 'a.gdx', '--csv'], ['textconv', 'a.gdx', 'b'], ['dump', 'a.gdx', '--bogus']]) {
      const r = await run(...argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.stderr, /usage:/);
    }
    const missing = await run('dump', path.join(tmp, 'missing.gdx'));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^gdx dump: missing\.gdx: /);
  });

  it('textconv: GDX files as dump, other files as they are or as a note, so that git diff works', async () => {
    const file = path.join(fixtures, 'transport2.gdx');
    assert.equal((await run('textconv', file)).stdout, await loadDumpText(native, file));
    const pointer = path.join(tmp, 'pointer.gdx');
    fs.writeFileSync(pointer, 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n');
    assert.deepEqual(await run('textconv', pointer), { code: 0, stdout: fs.readFileSync(pointer, 'utf8'), stderr: '' });
    const binary = path.join(tmp, 'binary.gdx');
    fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    const note = await run('textconv', binary);
    assert.equal(note.code, 0);
    assert.match(note.stdout, /^\* GDX Analyzer cannot show this file as text \(.+\)\n\* 4 bytes, SHA-1 a02a05b025b928c039cf1ae7e8ee04e7c190c0db\n$/);
    const empty = path.join(tmp, 'empty.gdx');
    fs.writeFileSync(empty, '');
    assert.deepEqual(await run('textconv', empty), { code: 0, stdout: '', stderr: '' });
  });
});

describe('git diff of GDX files', () => {
  it('adds the attribute once, after other lines for *.gdx, keeping the line ends', () => {
    assert.equal(withGdxAttribute(''), '# Show GDX files as text in git diff (GDX Analyzer: GDX: Set Up Git Diff for GDX Files)\n*.gdx diff=gdx\n');
    const lfs = '*.gdx filter=lfs diff=lfs merge=lfs -text\r\n';
    const added = withGdxAttribute(lfs)!;
    assert.match(added, /^\*\.gdx filter=lfs diff=lfs merge=lfs -text\r\n\r\n# Show .*\r\n\*\.gdx diff=gdx\r\n$/);
    assert.equal(withGdxAttribute(added), undefined);
    assert.equal(withGdxAttribute('*.txt text'), '*.txt text\n\n# Show GDX files as text in git diff (GDX Analyzer: GDX: Set Up Git Diff for GDX Files)\n*.gdx diff=gdx\n');
    assert.ok(hasGdxAttribute('*.[gG][dD][xX]  -text diff=gdx'));
    assert.ok(!hasGdxAttribute('# *.gdx diff=gdx'));
    assert.ok(!hasGdxAttribute('data/*.gdx diff=gdx'));
  });

  it('builds the command for Git’s shell', () => {
    assert.equal(shellQuote('C:\\Users\\a b\\x.js', true), '"C:/Users/a b/x.js"');
    assert.equal(shellQuote('/home/a/$x"`y', false), '"/home/a/\\$x\\"\\`y"');
    assert.equal(textconvCommand({ runtime: 'node', launcher: '/s/l.js', windows: false }), 'node "/s/l.js" textconv');
    assert.equal(
      textconvCommand({ runtime: 'C:\\VS Code\\Code.exe', electron: true, launcher: 'C:\\s\\l.js', encoding: 'windows-1252', windows: true }),
      'ELECTRON_RUN_AS_NODE=1 "C:/VS Code/Code.exe" "C:/s/l.js" textconv --encoding "windows-1252"',
    );
    assert.equal(textconvCommand({ runtime: 'node', launcher: '/l.js', encoding: 'UTF-8', windows: false }), 'node "/l.js" textconv');
  });

  it('launcher: runs the version that wrote it, else the newest one installed, else writes a note', () => {
    const extensions = path.join(tmp, 'extensions');
    for (const version of ['0.9.0', '0.10.1', '0.10.0']) {
      const dir = path.join(extensions, `muhammet-soyturk.gdx-analyzer-${version}`, 'out');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cli.js'), `exports.main = async (argv) => { process.stdout.write(${JSON.stringify(version)} + ' ' + argv.join(' ')); return 0; };`);
    }
    fs.mkdirSync(path.join(extensions, 'other.extension-9.9.9', 'out'), { recursive: true });
    fs.writeFileSync(path.join(extensions, 'other.extension-9.9.9', 'out', 'cli.js'), 'throw new Error("wrong extension")');
    const launcher = path.join(tmp, 'launcher.js');
    const runLauncher = () => execFileSync(process.execPath, [launcher, 'textconv', 'f.gdx'], { cwd: tmp, encoding: 'utf8' });
    const written = path.join(extensions, 'muhammet-soyturk.gdx-analyzer-0.9.0', 'out', 'cli.js');
    fs.writeFileSync(launcher, launcherScript(written, extensions, 'Muhammet-Soyturk.gdx-analyzer'));
    assert.equal(runLauncher(), '0.9.0 textconv f.gdx');
    fs.writeFileSync(launcher, launcherScript(path.join(extensions, 'muhammet-soyturk.gdx-analyzer-0.8.0', 'out', 'cli.js'), extensions, 'muhammet-soyturk.gdx-analyzer'));
    assert.equal(runLauncher(), '0.10.1 textconv f.gdx');
    fs.writeFileSync(launcher, launcherScript(path.join(tmp, 'gone', 'cli.js'), path.join(tmp, 'gone'), 'muhammet-soyturk.gdx-analyzer'));
    fs.writeFileSync(path.join(tmp, 'f.gdx'), 'x');
    assert.match(runLauncher(), /^\* GDX Analyzer is not installed: .*\n\* SHA-1 11f6ad8ec52a2984abaafd7c3b516503785c2072\n$/);
  });

  const gitPath = findOnPath('git');
  it('shows the records that changed, under the declaration of their symbol', { skip: gitPath ? false : 'git not found' }, async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(gitPath!, args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.autocrlf', 'false');
    const launcher = path.join(tmp, 'gdx-textconv.js');
    fs.writeFileSync(launcher, launcherScript(cli, path.join(tmp, 'none'), 'muhammet-soyturk.gdx-analyzer'));
    await configureDiffDriver(gitPath!, 'local', repo, textconvCommand({ runtime: process.execPath, launcher }));
    fs.writeFileSync(path.join(repo, '.gitattributes'), withGdxAttribute('')!);
    fs.copyFileSync(path.join(fixtures, 'transport1.gdx'), path.join(repo, 'out.gdx'));
    git('add', '.');
    git('commit', '-qm', 'transport1');
    fs.copyFileSync(path.join(fixtures, 'transport2.gdx'), path.join(repo, 'out.gdx'));
    const diff = git('diff', 'out.gdx');
    assert.match(diff, /^-'seattle'\.'new-york'\.L 50, $/m);
    assert.match(diff, /^\+'seattle'\.'new-york'\.L 60, $/m);
    assert.match(diff, /^\+Scalar extra only in variant 2 \/ 42 \/;$/m);
    assert.match(diff, /^@@ .* @@ Parameter specials\(\*\) special values \/$/m);
    assert.doesNotMatch(diff, /Binary files/);
  });
});
