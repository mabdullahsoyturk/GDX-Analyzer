/**
 * File access of the GDX functions (gdxReader.ts, gdxWriter.ts, gdxFile.ts) and the panels: files of
 * the local file system by path. The web extension uses files.web.ts instead (see scripts/build-web.mjs),
 * which reads and writes the files of VS Code's file systems, named by keys that behave like paths.
 *
 * No dependency on `vscode`, so the MCP server and the command line can use it too.
 */
import * as fs from 'fs';
import * as path from 'path';

/** An open file read at given positions (like fs.promises.FileHandle). */
export interface ReadHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
}

export function openFile(file: string): Promise<ReadHandle> {
  return fs.promises.open(file, 'r');
}

export async function statFile(file: string): Promise<FileStat> {
  const s = await fs.promises.stat(file);
  return { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.promises.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function readFile(file: string): Promise<Uint8Array> {
  return fs.promises.readFile(file);
}

/** Writes a file through a temporary file that replaces it, so that readers (e.g. a viewer that reloads) never see half of it. */
export async function writeFile(file: string, data: Uint8Array | string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, data);
  await fs.promises.rename(temp, file);
}

export async function copyFile(from: string, to: string): Promise<void> {
  await fs.promises.copyFile(from, to);
}

export async function makeDirectory(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Removes a file or a directory with its contents; nothing if it does not exist. */
export async function remove(file: string): Promise<void> {
  await fs.promises.rm(file, { recursive: true, force: true });
}

/** The names in a directory. */
export async function listDirectory(dir: string): Promise<string[]> {
  return fs.promises.readdir(dir);
}

/** Whether `file` is `dir` or lies in it. */
export function isWithin(file: string, dir: string): boolean {
  const f = path.resolve(file);
  const d = path.resolve(dir);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}
