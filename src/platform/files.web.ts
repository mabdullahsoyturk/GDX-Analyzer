/**
 * File access of the web extension (in place of files.ts, see scripts/build-web.mjs): the files of
 * VS Code's file systems (e.g. vscode-vfs: of github.dev), read and written with vscode.workspace.fs.
 *
 * The GDX functions name files by strings and take paths apart with `path` (basename, dirname, join):
 * here a file is named by a key that behaves like a POSIX path, /<scheme>/@<authority>/<path>, e.g.
 * /vscode-vfs/@github/owner/repo/results.gdx. A URI with a query gets a directory for it after the
 * authority, /<scheme>/@<authority>/!<query>/<path>, so that the files next to it have the same query
 * (e.g. the same revision).
 *
 * The browser cannot read a file at given positions: a file is read whole and kept in memory while it
 * is one of the most recently read ones (and has not changed).
 */
import * as vscode from 'vscode';

export interface ReadHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
}

/** The name of the file of a URI. */
export function fileKey(uri: vscode.Uri): string {
  const p = uri.path.startsWith('/') ? uri.path : `/${uri.path}`;
  const query = uri.query ? `/!${encodeURIComponent(uri.query)}` : '';
  return `/${uri.scheme}/@${uri.authority}${query}${p === '/' ? '' : p}`;
}

/** The URI of the file of a name (see fileKey). */
export function fileUri(file: string): vscode.Uri {
  const m = /^\/([^/]+)\/@([^/]*)(?:\/!([^/]*))?(\/.*)?$/.exec(file);
  if (!m) {
    throw new Error(`Not a file name of the web extension: ${file}`);
  }
  return vscode.Uri.from({ scheme: m[1], authority: m[2], path: m[4] ?? '/', query: m[3] ? decodeURIComponent(m[3]) : '' });
}

interface Contents {
  mtime: number;
  size: number;
  data: Promise<Uint8Array>;
}

/** The contents of the most recently read files. */
const contents = new Map<string, Contents>();
const MAX_CACHED_FILES = 4;

async function contentsOf(file: string): Promise<Uint8Array> {
  const uri = fileUri(file);
  const stat = await vscode.workspace.fs.stat(uri);
  const hit = contents.get(file);
  if (hit && hit.mtime === stat.mtime && hit.size === stat.size) {
    contents.delete(file);
    contents.set(file, hit);
    return hit.data;
  }
  const data = Promise.resolve(vscode.workspace.fs.readFile(uri));
  data.catch(() => contents.get(file)?.data === data && contents.delete(file));
  contents.set(file, { mtime: stat.mtime, size: stat.size, data });
  while (contents.size > MAX_CACHED_FILES) contents.delete(contents.keys().next().value as string);
  return data;
}

export async function openFile(file: string): Promise<ReadHandle> {
  const bytes = await contentsOf(file);
  return {
    async read(buffer, offset, length, position) {
      const n = Math.max(0, Math.min(length, bytes.length - position));
      buffer.set(bytes.subarray(position, position + n), offset);
      return { bytesRead: n };
    },
    async close() {},
  };
}

export async function statFile(file: string): Promise<FileStat> {
  const s = await vscode.workspace.fs.stat(fileUri(file));
  return { mtimeMs: s.mtime, size: s.size, isDirectory: (s.type & vscode.FileType.Directory) !== 0 };
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(fileUri(file));
    return true;
  } catch {
    return false;
  }
}

export async function readFile(file: string): Promise<Uint8Array> {
  return contentsOf(file);
}

export async function writeFile(file: string, data: Uint8Array | string): Promise<void> {
  contents.delete(file);
  await vscode.workspace.fs.writeFile(fileUri(file), typeof data === 'string' ? new TextEncoder().encode(data) : data);
}

export async function copyFile(from: string, to: string): Promise<void> {
  contents.delete(to);
  await vscode.workspace.fs.copy(fileUri(from), fileUri(to), { overwrite: true });
}

export async function makeDirectory(dir: string): Promise<void> {
  await vscode.workspace.fs.createDirectory(fileUri(dir));
}

/** Removes a file or a directory with its contents; nothing if it does not exist. */
export async function remove(file: string): Promise<void> {
  for (const key of [...contents.keys()]) if (isWithin(key, file)) contents.delete(key);
  try {
    await vscode.workspace.fs.delete(fileUri(file), { recursive: true, useTrash: false });
  } catch (err) {
    if (await fileExists(file)) throw err;
  }
}

/** The names in a directory. */
export async function listDirectory(dir: string): Promise<string[]> {
  return (await vscode.workspace.fs.readDirectory(fileUri(dir))).map(([name]) => name);
}

/** Whether `file` is `dir` or lies in it. */
export function isWithin(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}
