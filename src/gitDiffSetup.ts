/**
 * GDX: Set Up Git Diff for GDX Files: lets `git diff`, `git log -p` and `git show` show GDX files as
 * text (see gitTextconv.ts), for one repository or for all of them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitRepository, gitApi } from './gitCompare';
import { ATTRIBUTE_LINE, configureDiffDriver, globalAttributesFile, launcherScript, textconvCommand, withGdxAttribute } from './gitTextconv';
import { findOnPath } from './tools';

const LAUNCHER = 'gdx-textconv.js';

/** Writes the launcher for the running extension version (if it differs); returns its path. */
async function writeLauncher(context: vscode.ExtensionContext): Promise<string> {
  const file = path.join(context.globalStorageUri.fsPath, LAUNCHER);
  const script = launcherScript(path.join(context.extensionPath, 'out', 'cli.js'), path.dirname(context.extensionPath), context.extension.id);
  let current: string | undefined;
  try {
    current = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== script) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, script);
  }
  return file;
}

/** Adds the attribute line to an attribute file (created if needed); false if it has it already. */
async function addAttribute(file: string): Promise<boolean> {
  let text = '';
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const updated = withGdxAttribute(text);
  if (updated === undefined) return false;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, updated);
  return true;
}

async function pickRepository(repositories: GitRepository[], current: vscode.Uri | undefined): Promise<GitRepository | undefined> {
  const inCurrent = current && repositories.filter((r) => current.fsPath.toLowerCase().startsWith(r.rootUri.fsPath.toLowerCase())).sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
  if (inCurrent || repositories.length === 1) return inCurrent ?? repositories[0];
  const picked = await vscode.window.showQuickPick(
    repositories.map((r) => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, repo: r })),
    { title: 'Set Up Git Diff for GDX Files: Repository' },
  );
  return picked?.repo;
}

export function registerGitDiffSetup(context: vscode.ExtensionContext, current: () => vscode.Uri | undefined, onError: (err: unknown) => Promise<unknown>) {
  // Keeps the launcher of an earlier setup pointing to this version.
  if (fs.existsSync(path.join(context.globalStorageUri.fsPath, LAUNCHER))) {
    writeLauncher(context).catch(() => undefined);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('gdxAnalyzer.setUpGitDiff', async () => {
      try {
        const api = await gitApi();
        const repositories = api.repositories.filter((r) => r.rootUri.scheme === 'file');
        type Item = vscode.QuickPickItem & { scope: 'local' | 'global' };
        const items: Item[] = [
          ...(repositories.length
            ? [
                {
                  label: '$(repo) This Repository',
                  description: repositories.length === 1 ? path.basename(repositories[0].rootUri.fsPath) : undefined,
                  detail: `Adds "${ATTRIBUTE_LINE}" to .gitattributes (commit it to share it) and the conversion to the repository's Git configuration`,
                  scope: 'local' as const,
                },
              ]
            : []),
          {
            label: '$(globe) All Repositories',
            detail: 'Adds them to your global Git attributes file and Git configuration',
            scope: 'global' as const,
          },
        ];
        const choice = await vscode.window.showQuickPick(items, {
          title: 'Set Up Git Diff for GDX Files',
          placeHolder: 'git diff, git log -p and git show will show GDX files as text (in the format of gdxdump)',
        });
        if (!choice) return;
        const repo = choice.scope === 'local' ? await pickRepository(repositories, current()) : undefined;
        if (choice.scope === 'local' && !repo) return;
        const cwd = repo?.rootUri.fsPath ?? os.homedir();
        const launcher = await writeLauncher(context);
        // Node.js if it is on the PATH (found by Git too, also after it is updated), else VS Code's runtime.
        const node = findOnPath('node');
        const encoding = vscode.workspace.getConfiguration('gdxAnalyzer').get<string>('encoding', 'utf-8').trim();
        const command = textconvCommand({ runtime: node ? 'node' : process.execPath, electron: !node, launcher, encoding });
        await configureDiffDriver(api.git.path, choice.scope, cwd, command);
        const attributes = repo ? path.join(repo.rootUri.fsPath, '.gitattributes') : await globalAttributesFile(api.git.path, cwd);
        const added = await addAttribute(attributes);
        const open = 'Open Attributes File';
        const where = repo ? `the repository ${path.basename(repo.rootUri.fsPath)}` : 'all your repositories';
        const share = repo && added ? ' Commit .gitattributes to share it; others run this command too, as the conversion is part of each Git configuration.' : '';
        const answer = await vscode.window.showInformationMessage(`git diff now shows GDX files as text in ${where}.${share}`, open);
        if (answer === open) {
          await vscode.window.showTextDocument(vscode.Uri.file(attributes));
        }
      } catch (err) {
        await onError(err);
      }
    }),
  );
}
