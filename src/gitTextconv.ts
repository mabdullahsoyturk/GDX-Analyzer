/**
 * `git diff` of GDX files as text: Git's textconv runs the command line of the extension (cli.ts) on
 * each version of a file with the attribute diff=gdx. Set up per repository (.gitattributes and the
 * repository's Git configuration) or for all repositories (the global attributes file and configuration).
 *
 * Git runs a fixed command, but the extension's directory changes with each version: the command runs
 * a launcher at a fixed place (the extension's global storage), which runs the command line of the
 * version that wrote it or, if that one is gone, of the newest one installed.
 *
 * No dependency on `vscode`.
 */
import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

/** The attribute line, and the comment before it, added to attribute files. */
export const ATTRIBUTE_LINE = '*.gdx diff=gdx';
const ATTRIBUTE_COMMENT = '# Show GDX files as text in git diff (GDX Analyzer: GDX: Set Up Git Diff for GDX Files)';

/**
 * Hunk headers of `git diff`: the declaration of the symbol a change is in (see gdxText.ts). Git shows
 * the first group, so it is the whole line (POSIX regular expressions have no non-capturing groups).
 */
export const XFUNCNAME = '^(((Singleton )?Set|Alias|Acronym|Scalar|Parameter|Equation|[a-zA-Z0-9]+ +Variable) .*)$';

/** The launcher: runs the command line of the extension at `cli`, or of the newest version in `extensionsDir`. */
export function launcherScript(cli: string, extensionsDir: string, extensionId: string): string {
  return `// Written by GDX Analyzer (VS Code extension) for git diff of GDX files (git config diff.gdx.textconv).
// Runs the command line of the extension version that wrote it or, if that one is gone, of the newest one installed.
'use strict';
const fs = require('fs');
const path = require('path');
const written = ${JSON.stringify(cli)};
const extensions = ${JSON.stringify(extensionsDir)};
const prefix = ${JSON.stringify(`${extensionId.toLowerCase()}-`)};

function newest() {
  const key = (v) => v.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const later = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
  };
  let best;
  let bestKey;
  let names = [];
  try {
    names = fs.readdirSync(extensions);
  } catch {}
  for (const name of names) {
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const cli = path.join(extensions, name, 'out', 'cli.js');
    const k = key(name.slice(prefix.length));
    if (fs.existsSync(cli) && (!bestKey || later(k, bestKey))) {
      best = cli;
      bestKey = k;
    }
  }
  return best;
}

const cli = fs.existsSync(written) ? written : newest();
if (cli) {
  require(cli).main(process.argv.slice(2)).then((code) => (process.exitCode = code));
} else {
  // Not an error, which would stop the whole diff; the hash still shows whether the file changed.
  const file = process.argv[process.argv.length - 1];
  let hash = '';
  try {
    hash = require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {}
  process.stdout.write('* GDX Analyzer is not installed: install it, or remove diff.gdx.textconv from the Git configuration.\\n* SHA-1 ' + hash + '\\n');
}
`;
}

/** A path as an argument of a command run by Git's shell (sh, also on Windows). */
export function shellQuote(p: string, windows = process.platform === 'win32'): string {
  const s = windows ? p.replace(/\\/g, '/') : p;
  return `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
}

/**
 * The textconv command: `runtime` runs the launcher (Node.js, or with `electron` an Electron executable
 * such as VS Code's, run as Node.js). Git appends the file.
 */
export function textconvCommand(o: { runtime: string; electron?: boolean; launcher: string; encoding?: string; windows?: boolean }): string {
  const runtime = o.runtime === 'node' ? 'node' : shellQuote(o.runtime, o.windows);
  const encoding = o.encoding && o.encoding.toLowerCase() !== 'utf-8' ? ` --encoding ${shellQuote(o.encoding, o.windows)}` : '';
  return `${o.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${runtime} ${shellQuote(o.launcher, o.windows)} textconv${encoding}`;
}

/** Whether an attribute file already gives *.gdx the attribute diff=gdx. */
export function hasGdxAttribute(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    return !!pattern && !pattern.startsWith('#') && /^\*\.(gdx|\[gG\]\[dD\]\[xX\])$/.test(pattern) && attributes.includes('diff=gdx');
  });
}

/**
 * The attribute file with the attribute line added at the end (after other lines for *.gdx, such as
 * those of Git LFS, so that it sets the diff driver), or undefined if it has it already.
 */
export function withGdxAttribute(text: string): string | undefined {
  if (hasGdxAttribute(text)) return undefined;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text === '' ? '' : text.endsWith('\n') ? eol : eol + eol;
  return `${text}${sep}${ATTRIBUTE_COMMENT}${eol}${ATTRIBUTE_LINE}${eol}`;
}

function git(gitPath: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(gitPath, args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') {
        reject(err);
        return;
      }
      resolve({ code: err ? Number((err as NodeJS.ErrnoException).code) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Sets up the diff driver gdx in the repository's (`local`) or the user's (`global`) Git configuration. */
export async function configureDiffDriver(gitPath: string, scope: 'local' | 'global', cwd: string, command: string): Promise<void> {
  const settings: [string, string][] = [
    ['diff.gdx.textconv', command],
    // Each version of a file is converted once (in refs/notes/textconv/gdx).
    ['diff.gdx.cachetextconv', 'true'],
    ['diff.gdx.xfuncname', XFUNCNAME],
  ];
  for (const [key, value] of settings) {
    const r = await git(gitPath, ['config', `--${scope}`, key, value], cwd);
    if (r.code !== 0) {
      throw new Error(`git config --${scope} ${key} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
    }
  }
}

/** The global attribute file: core.attributesFile, else $XDG_CONFIG_HOME/git/attributes (as Git finds it). */
export async function globalAttributesFile(gitPath: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const r = await git(gitPath, ['config', '--global', '--path', 'core.attributesFile'], cwd);
  const configured = r.code === 0 ? r.stdout.trim() : '';
  if (configured) return path.resolve(cwd, configured);
  const home = env.HOME || os.homedir();
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'attributes');
}
