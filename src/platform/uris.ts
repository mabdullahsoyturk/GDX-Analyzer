/**
 * How the VS Code side of the extension names the files that the GDX functions read and write
 * (see files.ts): on the desktop, the paths of the local file system. The web extension uses
 * uris.web.ts instead (see scripts/build-web.mjs).
 */
import * as os from 'os';
import * as vscode from 'vscode';

/** Whether this is the web extension (VS Code for the Web: vscode.dev, github.dev). */
export const IS_WEB = false;

/**
 * The name of the file of a URI for the GDX functions, or undefined for files they cannot read
 * directly (other file systems, e.g. git: in diff editors; these are read through a temporary copy).
 */
export function fileKey(uri: vscode.Uri): string | undefined {
  return uri.scheme === 'file' ? uri.fsPath : undefined;
}

/** The URI of a file named by fileKey. */
export function fileUri(file: string): vscode.Uri {
  return vscode.Uri.file(file);
}

/** How a file is shown in the viewer and the comparisons: its path. */
export function displayFile(file: string): string {
  return file;
}

/** How code run outside VS Code (Copy as Code, GAMS Connect instructions) names a file: its path. */
export function codeFile(file: string): string {
  return file;
}

/** Where files are saved when no GDX file suggests a directory: the first workspace folder, else the home directory. */
export function defaultDirectory(): string | undefined {
  return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath ?? os.homedir();
}
