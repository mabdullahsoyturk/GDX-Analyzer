/**
 * Compares a GDX file with one of its versions in Git (the last commit, the staged version
 * or a commit of its history), using the Git extension of VS Code to read that version.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** The part of the API of the built-in Git extension (vscode.git) that is used. */
interface GitCommit {
  hash: string;
  message: string;
  authorName?: string;
  authorDate?: Date;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  /** The contents of a file at a revision ('' is the staged version). */
  buffer(ref: string, path: string): Promise<Buffer>;
  log(options?: { maxEntries?: number; path?: string }): Promise<GitCommit[]>;
}

interface GitAPI {
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

async function gitApi(): Promise<GitAPI> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const git = ext && (ext.isActive ? ext.exports : await ext.activate());
  if (!git || !git.enabled) {
    throw new Error('The Git extension of VS Code is not available or disabled (setting git.enabled).');
  }
  return git.getAPI(1);
}

/** A version of the file: a revision (the ref for Git; '' is the staged version) or the working tree (null). */
interface Revision {
  ref: string | null;
  /** Shown in the comparison, e.g. "HEAD" or "a1b2c3d". */
  name: string;
}

const WORKING_TREE: Revision = { ref: null, name: 'working tree' };

/** A ref given to the command (e.g. in a keybinding's args) as a revision. */
const revisionOf = (ref: string): Revision => ({ ref, name: ref === '' ? 'staged' : ref });

/**
 * Asks for a version: HEAD, the staged version, a commit of the file's history or any ref,
 * and (with `workingTree`) the working tree; or (with `two`) to compare two revisions.
 */
async function pickRevision(repo: GitRepository, file: string, title: string, options: { two?: boolean; workingTree?: boolean } = {}): Promise<Revision | 'two' | undefined> {
  type Item = vscode.QuickPickItem & { revision?: Revision; other?: boolean; two?: boolean };
  const items: Item[] = [
    ...(options.workingTree ? [{ label: '$(file) Working Tree', description: 'The file as it is now', revision: WORKING_TREE }] : []),
    { label: '$(git-commit) HEAD', description: 'The last commit', revision: { ref: 'HEAD', name: 'HEAD' } },
    { label: '$(diff) Staged', description: 'The version in the index', revision: { ref: '', name: 'staged' } },
  ];
  let history: GitCommit[] = [];
  try {
    history = await repo.log({ path: file, maxEntries: 30 });
  } catch {
    // No history (e.g. a new file): HEAD and the staged version can still be tried.
  }
  if (history.length) {
    items.push({ label: 'History of the file', kind: vscode.QuickPickItemKind.Separator });
    for (const c of history) {
      const short = c.hash.slice(0, 7);
      items.push({
        label: `$(git-commit) ${short}`,
        description: c.message.split('\n')[0],
        detail: [c.authorName, c.authorDate?.toLocaleString()].filter(Boolean).join(', ') || undefined,
        revision: { ref: c.hash, name: short },
      });
    }
  }
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(edit) Other Revision…', description: 'A branch, tag or ref such as HEAD~2', other: true });
  if (options.two) {
    items.push({ label: '$(git-compare) Two Revisions…', description: 'Compare two versions of the file with each other, e.g. HEAD~1 and HEAD', two: true });
  }
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  if (picked?.two) {
    return 'two';
  }
  if (picked?.other) {
    const ref = (await vscode.window.showInputBox({ title, prompt: 'A branch, tag, commit or ref such as HEAD~2' }))?.trim();
    return ref ? revisionOf(ref) : undefined;
  }
  return picked?.revision;
}

/** Asks for the two versions to compare: the first (older), then the second (newer, also the working tree). */
async function pickTwo(repo: GitRepository, file: string): Promise<[Revision, Revision] | undefined> {
  const name = path.basename(file);
  const first = await pickRevision(repo, file, `Compare ${name}: the first (older) version`);
  if (!first || first === 'two') return undefined;
  const second = await pickRevision(repo, file, `Compare ${name} @ ${first.name} with`, { workingTree: true });
  return second && second !== 'two' ? [first, second] : undefined;
}

/**
 * Writes the revision of a GDX file to a temporary file (named like the file, so that the
 * comparison names it) and returns its path and how to show it.
 */
async function revisionFile(repo: GitRepository, file: string, revision: Revision, storage: vscode.Uri): Promise<{ path: string; label: string }> {
  if (revision.ref === null) {
    return { path: file, label: `${file} (working tree)` };
  }
  let data: Buffer;
  try {
    data = await repo.buffer(revision.ref, file);
  } catch (err) {
    throw new Error(`${path.basename(file)} does not exist in ${revision.name === 'staged' ? 'the index' : revision.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // One directory per file and revision, so that comparing again reuses the open comparison.
  const id = crypto.createHash('sha1').update(`${file}\0${revision.ref}`).digest('hex').slice(0, 16);
  const dir = path.join(storage.fsPath, 'revisions', id);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(file));
  await fs.promises.writeFile(target, data);
  return { path: target, label: `${file} @ ${revision.name}` };
}

/** The file a command was run on: an Explorer or editor URI, or a resource with a URI (e.g. of Source Control). */
function fileOf(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const resource = (arg as { resourceUri?: unknown } | undefined)?.resourceUri;
  return resource instanceof vscode.Uri ? resource : undefined;
}

export function registerGitCompare(
  context: vscode.ExtensionContext,
  current: () => vscode.Uri | undefined,
  compare: (file1: string, file2: string, labels: Record<string, string>) => void,
  onError: (err: unknown) => Promise<unknown>,
) {
  context.subscriptions.push(
    // With `ref` (e.g. "HEAD" in a keybinding's args), that revision is compared with the working tree without
    // asking; with `ref2` too, the two revisions (e.g. "HEAD~1" and "HEAD"; '' is the staged version).
    vscode.commands.registerCommand('gdxAnalyzer.compareWithRevision', async (arg?: unknown, ref?: unknown, ref2?: unknown) => {
      try {
        const uri = fileOf(arg) ?? current();
        if (!uri || uri.scheme !== 'file') {
          vscode.window.showInformationMessage('Open a GDX file of a Git repository, or run the command on one in the Explorer.');
          return;
        }
        const repo = (await gitApi()).getRepository(uri);
        if (!repo) {
          vscode.window.showWarningMessage(`${path.basename(uri.fsPath)} is not in a Git repository that VS Code has open.`);
          return;
        }
        let versions: [Revision, Revision] | undefined;
        if (typeof ref === 'string') {
          versions = [revisionOf(ref), typeof ref2 === 'string' ? revisionOf(ref2) : WORKING_TREE];
        } else {
          const picked = await pickRevision(repo, uri.fsPath, `Compare ${path.basename(uri.fsPath)} with`, { two: true });
          versions = picked === 'two' ? await pickTwo(repo, uri.fsPath) : picked && [picked, WORKING_TREE];
        }
        if (!versions) {
          return;
        }
        const [a, b] = await Promise.all(versions.map((v) => revisionFile(repo, uri.fsPath, v, context.globalStorageUri)));
        compare(a.path, b.path, { [a.path]: a.label, [b.path]: b.label });
      } catch (err) {
        await onError(err);
      }
    }),
  );
}
