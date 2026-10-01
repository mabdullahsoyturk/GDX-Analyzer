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

/** A revision to compare with: the ref for Git and how to name it. */
interface Revision {
  ref: string;
  /** Shown in the comparison, e.g. "HEAD" or "a1b2c3d". */
  name: string;
}

/** Asks for the revision: HEAD, the staged version, a commit of the file's history or any ref. */
async function pickRevision(repo: GitRepository, file: string): Promise<Revision | undefined> {
  type Item = vscode.QuickPickItem & { revision?: Revision; other?: boolean };
  const items: Item[] = [
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
  const picked = await vscode.window.showQuickPick(items, { title: `Compare ${path.basename(file)} with`, matchOnDescription: true });
  if (picked?.other) {
    const ref = (await vscode.window.showInputBox({ title: `Compare ${path.basename(file)} with`, prompt: 'A branch, tag, commit or ref such as HEAD~2' }))?.trim();
    return ref ? { ref, name: ref } : undefined;
  }
  return picked?.revision;
}

/**
 * Writes the revision of a GDX file to a temporary file (named like the file, so that the
 * comparison names it) and returns its path and how to show it.
 */
async function revisionFile(repo: GitRepository, file: string, revision: Revision, storage: vscode.Uri): Promise<{ path: string; label: string }> {
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
    // With `ref` (e.g. "HEAD" in a keybinding's args), that revision is compared without asking.
    vscode.commands.registerCommand('gdxAnalyzer.compareWithRevision', async (arg?: unknown, ref?: unknown) => {
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
        const revision = typeof ref === 'string' ? { ref, name: ref === '' ? 'staged' : ref } : await pickRevision(repo, uri.fsPath);
        if (!revision) {
          return;
        }
        const old = await revisionFile(repo, uri.fsPath, revision, context.globalStorageUri);
        compare(old.path, uri.fsPath, { [old.path]: old.label, [uri.fsPath]: `${uri.fsPath} (working tree)` });
      } catch (err) {
        await onError(err);
      }
    }),
  );
}
