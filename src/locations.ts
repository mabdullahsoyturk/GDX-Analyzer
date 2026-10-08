/**
 * Helpers for the files of the VS Code side, named as platform/uris.ts names them (paths on the
 * desktop, keys that behave like POSIX paths in the web extension).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { IS_WEB, fileKey, fileUri } from './platform/uris';

/** The name of the file of a URI; throws for files the GDX functions cannot read (other file systems on the desktop). */
export function fileOf(uri: vscode.Uri): string {
  const file = fileKey(uri);
  if (file === undefined) {
    throw new Error(`${uri.toString(true)}: only GDX files on the local file system can be read here.`);
  }
  return file;
}

/** The name of a URI's file (last path segment), whatever its file system. */
export function baseName(uri: vscode.Uri): string {
  return path.posix.basename(uri.path);
}

/** A watcher of one file. */
export function watchFile(file: string): vscode.FileSystemWatcher {
  return vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(fileUri(path.dirname(file)), path.basename(file)));
}

/** The URI of a file in a directory (the default of save dialogs); undefined without a directory. */
export function uriIn(dir: string | undefined, name: string): vscode.Uri | undefined {
  return dir === undefined ? undefined : fileUri(path.join(dir, name));
}

/**
 * The directory of the extension's global storage. On the desktop its URI may have the scheme
 * vscode-userdata, but it is a directory on disk: its path is used.
 */
export function storageDirectory(context: { globalStorageUri: vscode.Uri }): string {
  return IS_WEB ? fileOf(context.globalStorageUri) : context.globalStorageUri.fsPath;
}
