/**
 * How the web extension names files (in place of uris.ts, see scripts/build-web.mjs): every file of
 * VS Code's file systems by a key (see files.web.ts), shown and used in code relative to its workspace folder.
 */
import * as vscode from 'vscode';
import { fileKey as keyOf, fileUri } from './files.web';

export { fileUri } from './files.web';

/** Whether this is the web extension (VS Code for the Web: vscode.dev, github.dev). */
export const IS_WEB = true;

/** The name of the file of a URI for the GDX functions: any file VS Code can read. */
export function fileKey(uri: vscode.Uri): string | undefined {
  return keyOf(uri);
}

/** How a file is shown in the viewer and the comparisons: relative to its workspace folder, else its URI. */
export function displayFile(file: string): string {
  const uri = fileUri(file);
  return vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : uri.toString(true);
}

/** How code run outside VS Code (Copy as Code, GAMS Connect instructions) names a file: relative to its workspace folder. */
export function codeFile(file: string): string {
  return vscode.workspace.asRelativePath(fileUri(file), false);
}

/** Where files are saved when no GDX file suggests a directory: the first workspace folder. */
export function defaultDirectory(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && keyOf(folder.uri);
}
