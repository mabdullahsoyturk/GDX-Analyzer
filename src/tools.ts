/**
 * Locating and running gdxdump/gdxdiff, either directly from a GAMS system
 * directory or through the GAMSPy CLI (`gamspy gdx dump|diff`).
 *
 * This module deliberately has no dependency on `vscode` so it can be unit tested.
 */
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Backend = 'gams' | 'gamspy';
export type BackendSetting = 'auto' | Backend;

export interface ToolSettings {
  backend: BackendSetting;
  gamsSystemDirectory?: string;
  gamspyExecutable?: string;
  /** Folders searched for a `.venv` / `venv` containing gamspy (usually the workspace folders). */
  venvSearchRoots?: string[];
}

export interface ResolvedTools {
  backend: Backend;
  /** GAMS backend: the system directory. GAMSPy backend: the gamspy executable. */
  location: string;
  gdxdump: string;
  gdxdiff: string;
}

export interface DumpOptions {
  symbol?: string;
  format?: 'normal' | 'csv' | 'gamsbas';
  csvAllFields?: boolean;
  csvSetText?: boolean;
  symbols?: boolean;
  domainInfo?: boolean;
  version?: boolean;
  /** Writes all unique elements (in GDX order) as a set with this name. */
  uelTable?: string;
  noData?: boolean;
  /** hexBytes writes the exact IEEE 754 bits of each value. */
  dFormat?: 'normal' | 'hexponential' | 'hexBytes';
}

export interface DiffOptions {
  eps?: number;
  relEps?: number;
  /** L, M, Up, Lo, Prior, Scale or All. */
  field?: string;
  /** With a field: write variables and equations as parameters of that field (FldOnly). */
  fieldOnly?: boolean;
  /** Write variables and equations as parameters with the field as an extra dimension (DiffOnly). */
  diffOnly?: boolean;
  compareDomains?: boolean;
  /** Report default values found in only one file as differences (CmpDefaults). */
  compareDefaults?: boolean;
  ignoreOrder?: boolean;
  /** Do not compare the explanatory texts of set elements (SetDesc=N). */
  ignoreSetText?: boolean;
  /** Compare only these symbols. */
  ids?: string[];
  /** Do not compare these symbols. */
  skipIds?: string[];
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ToolNotFoundError extends Error {}

export class ToolError extends Error {
  constructor(message: string, readonly result?: RunResult) {
    super(message);
  }
}

const isWindows = process.platform === 'win32';
const exe = (name: string) => (isWindows ? `${name}.exe` : name);

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Minimal `which`: returns the first match for `name` on the PATH. */
export function findOnPath(name: string, envPath = process.env.PATH ?? ''): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir.replace(/^"(.*)"$/, '$1'), name + ext);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function hasGdxTools(dir: string): boolean {
  return isFile(path.join(dir, exe('gdxdump'))) && isFile(path.join(dir, exe('gdxdiff')));
}

/** Sort key for directory names like "55", "win64/24.9" or "gams50.1_linux_x64_64_sfx". */
function versionKey(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number);
}

function compareVersionsDesc(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? -1) - (ka[i] ?? -1);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function subdirsByVersion(parent: string): string[] {
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(compareVersionsDesc)
      .map((n) => path.join(parent, n));
  } catch {
    return [];
  }
}

/** Candidate GAMS system directories in standard install locations, newest first. */
export function defaultGamsLocations(): string[] {
  const home = os.homedir();
  if (isWindows) {
    const roots = ['C:\\GAMS', process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'GAMS') : ''].filter(Boolean);
    const result: string[] = [];
    for (const root of roots) {
      for (const dir of subdirsByVersion(root)) {
        result.push(dir);
        // Older layout: C:\GAMS\win64\<version>
        result.push(...subdirsByVersion(dir));
      }
    }
    return result;
  }
  if (process.platform === 'darwin') {
    return [
      '/Library/Frameworks/GAMS.framework/Versions/Current/Resources',
      ...subdirsByVersion('/Library/Frameworks/GAMS.framework/Versions').map((d) => path.join(d, 'Resources')),
      ...subdirsByVersion('/Applications').filter((d) => /GAMS/i.test(path.basename(d))).map((d) => path.join(d, 'sysdir')),
    ];
  }
  return [
    ...subdirsByVersion('/opt/gams').filter((d) => /gams/i.test(path.basename(d))),
    ...subdirsByVersion(home).filter((d) => /^gams/i.test(path.basename(d))),
  ];
}

function resolveGams(settings: ToolSettings): ResolvedTools | undefined {
  const make = (dir: string): ResolvedTools => ({
    backend: 'gams',
    location: dir,
    gdxdump: path.join(dir, exe('gdxdump')),
    gdxdiff: path.join(dir, exe('gdxdiff')),
  });
  const configured = settings.gamsSystemDirectory?.trim();
  if (configured) {
    if (!hasGdxTools(configured)) {
      throw new ToolNotFoundError(
        `gdxdump/gdxdiff were not found in the configured GAMS system directory "${configured}" (setting gdx.gamsSystemDirectory).`,
      );
    }
    return make(configured);
  }
  const onPath = findOnPath('gdxdump');
  if (onPath && hasGdxTools(path.dirname(onPath))) {
    return make(path.dirname(onPath));
  }
  const found = defaultGamsLocations().find(hasGdxTools);
  return found ? make(found) : undefined;
}

function resolveGamspy(settings: ToolSettings): ResolvedTools | undefined {
  const make = (gamspy: string): ResolvedTools => ({ backend: 'gamspy', location: gamspy, gdxdump: gamspy, gdxdiff: gamspy });
  const configured = settings.gamspyExecutable?.trim();
  if (configured) {
    const candidates = isDir(configured)
      ? [path.join(configured, exe('gamspy')), path.join(configured, isWindows ? 'Scripts' : 'bin', exe('gamspy'))]
      : [configured, isWindows && !configured.toLowerCase().endsWith('.exe') ? configured + '.exe' : configured];
    const found = candidates.find(isFile);
    if (!found) {
      throw new ToolNotFoundError(`The configured gamspy executable "${configured}" does not exist (setting gdx.gamspyExecutable).`);
    }
    return make(found);
  }
  for (const root of settings.venvSearchRoots ?? []) {
    for (const venv of ['.venv', 'venv', 'env']) {
      const candidate = path.join(root, venv, isWindows ? 'Scripts' : 'bin', exe('gamspy'));
      if (isFile(candidate)) {
        return make(candidate);
      }
    }
  }
  const onPath = findOnPath('gamspy');
  return onPath ? make(onPath) : undefined;
}

export function resolveTools(settings: ToolSettings): ResolvedTools {
  const backend = settings.backend ?? 'auto';
  if (backend === 'gams' || backend === 'auto') {
    const gams = resolveGams(settings);
    if (gams) {
      return gams;
    }
    if (backend === 'gams') {
      throw new ToolNotFoundError(
        'No GAMS system with gdxdump/gdxdiff was found. Set gdx.gamsSystemDirectory or add the GAMS system directory to the PATH.',
      );
    }
  }
  const gamspy = resolveGamspy(settings);
  if (gamspy) {
    return gamspy;
  }
  throw new ToolNotFoundError(
    backend === 'gamspy'
      ? 'The gamspy executable was not found. Install GAMSPy (pip install gamspy) or set gdx.gamspyExecutable.'
      : 'Neither a GAMS system (gdxdump/gdxdiff) nor the GAMSPy CLI was found. ' +
          'Install GAMS or GAMSPy (pip install gamspy), or set gdx.gamsSystemDirectory / gdx.gamspyExecutable.',
  );
}

/** Command line arguments for gdxdump (GAMS syntax) or `gamspy gdx dump` (GAMSPy CLI syntax). */
export function buildDumpArgs(backend: Backend, file: string, o: DumpOptions = {}): string[] {
  if (backend === 'gams') {
    const args = [file];
    if (o.version) args.push('-V');
    if (o.symbol) args.push(`Symb=${o.symbol}`);
    if (o.format) args.push(`Format=${o.format}`);
    if (o.csvAllFields) args.push('CSVAllFields');
    if (o.csvSetText) args.push('CSVSetText');
    if (o.symbols) args.push('Symbols');
    if (o.domainInfo) args.push('DomainInfo');
    if (o.uelTable) args.push(`UelTable=${o.uelTable}`);
    if (o.noData) args.push('NoData');
    if (o.dFormat) args.push(`dFormat=${o.dFormat}`);
    return args;
  }
  const args = ['gdx', 'dump', file];
  if (o.version) args.push('--version');
  if (o.symbol) args.push('--symb', o.symbol);
  if (o.format) args.push('--format', o.format);
  if (o.csvAllFields) args.push('--csvallfields');
  if (o.csvSetText) args.push('--csvsettext');
  if (o.symbols) args.push('--symbols');
  if (o.domainInfo) args.push('--domaininfo');
  if (o.uelTable) args.push('--ueltable', o.uelTable);
  if (o.noData) args.push('--nodata');
  if (o.dFormat) args.push('--dformat', o.dFormat);
  return args;
}

/** Command line arguments for gdxdiff (GAMS syntax) or `gamspy gdx diff` (GAMSPy CLI syntax). */
export function buildDiffArgs(backend: Backend, file1: string, file2: string, diffFile: string, o: DiffOptions = {}): string[] {
  const field = o.field && o.field !== 'All' ? o.field : undefined;
  if (backend === 'gams') {
    const args = [file1, file2, diffFile];
    if (o.eps) args.push(`Eps=${o.eps}`);
    if (o.relEps) args.push(`RelEps=${o.relEps}`);
    if (field) args.push(`Field=${field}`);
    if (field && o.fieldOnly) args.push('FldOnly');
    if (o.diffOnly && !(field && o.fieldOnly)) args.push('DiffOnly');
    if (o.compareDomains) args.push('CmpDomains');
    if (o.compareDefaults) args.push('CmpDefaults');
    if (o.ignoreOrder) args.push('IgnoreOrder');
    if (o.ignoreSetText) args.push('SetDesc=N');
    for (const id of o.ids ?? []) args.push(`ID=${id}`);
    for (const id of o.skipIds ?? []) args.push(`SkipID=${id}`);
    return args;
  }
  const args = ['gdx', 'diff', file1, file2, diffFile];
  if (o.eps) args.push('--eps', String(o.eps));
  if (o.relEps) args.push('--releps', String(o.relEps));
  if (field) args.push('--field', field);
  if (field && o.fieldOnly) args.push('--fldonly');
  if (o.diffOnly && !(field && o.fieldOnly)) args.push('--diffonly');
  if (o.compareDomains) args.push('--cmpdomains');
  if (o.compareDefaults) args.push('--cmpdefaults');
  if (o.ignoreOrder) args.push('--ignoreorder');
  if (o.ignoreSetText) args.push('--setdesc', 'N');
  for (const id of o.ids ?? []) args.push('--id', id);
  for (const id of o.skipIds ?? []) args.push('--skipid', id);
  return args;
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
  /**
   * Receives the output as it arrives (decoded as UTF-8) instead of it being collected;
   * RunResult.stdout then only holds the first few kilobytes (for error messages).
   */
  onStdout?: (chunk: string) => void;
}

/** Output kept for error messages when it is streamed. */
const STREAMED_OUTPUT_KEPT = 16384;

export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      windowsHide: true,
      signal: opts.signal,
      timeout: opts.timeoutMs,
      // Make the GAMSPy CLI (Python) write UTF-8 regardless of the console code page.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let kept = 0;
    const decoder = new StringDecoder('utf8');
    const stream = opts.onStdout;
    let streamError: unknown;
    child.stdout.on('data', (d: Buffer) => {
      if (!stream) {
        out.push(d);
        return;
      }
      if (kept < STREAMED_OUTPUT_KEPT) {
        out.push(d.subarray(0, STREAMED_OUTPUT_KEPT - kept));
        kept += d.length;
      }
      if (streamError === undefined) {
        try {
          stream(decoder.write(d));
        } catch (e) {
          // Stop the tool if the consumer fails (e.g. out of memory for the data).
          streamError = e;
          child.kill();
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code, sig) => {
      if (stream && streamError === undefined) {
        try {
          stream(decoder.end());
        } catch (e) {
          streamError = e;
        }
      }
      if (streamError !== undefined) {
        reject(streamError);
        return;
      }
      const result = {
        exitCode: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      };
      if (sig && code === null) {
        reject(new ToolError(`${path.basename(command)} was terminated (${sig}).`, result));
      } else {
        resolve(result);
      }
    });
  });
}

/** Strips the ANSI escape codes the GAMSPy CLI may emit in error messages. */
function clean(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

export type Logger = (line: string) => void;

export class GdxTools {
  constructor(readonly tools: ResolvedTools, private readonly log: Logger = () => {}) {}

  private checkFile(file: string) {
    // `gamspy gdx dump|diff` appends ".gdx" to any file name not ending in lower-case ".gdx".
    if (this.tools.backend === 'gamspy' && !file.endsWith('.gdx')) {
      throw new ToolError(`The GAMSPy CLI only accepts file names ending in ".gdx": ${file}`);
    }
  }

  private async exec(command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    this.log(`> ${[command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const started = Date.now();
    const result = await run(command, args, opts);
    this.log(`  exit code ${result.exitCode} (${Date.now() - started} ms)`);
    return result;
  }

  async dump(file: string, options: DumpOptions = {}, opts?: RunOptions): Promise<string> {
    this.checkFile(file);
    const result = await this.exec(this.tools.gdxdump, buildDumpArgs(this.tools.backend, file, options), opts);
    if (result.exitCode !== 0) {
      const message = clean(result.stdout + '\n' + result.stderr) || `gdxdump failed with exit code ${result.exitCode}`;
      throw new ToolError(message, result);
    }
    return result.stdout;
  }

  /**
   * Runs gdxdump and hands its output to `onChunk` as it arrives, without holding all
   * of it in memory (for symbols with many records).
   */
  async dumpStream(file: string, options: DumpOptions, onChunk: (chunk: string) => void, opts?: RunOptions): Promise<void> {
    this.checkFile(file);
    const result = await this.exec(this.tools.gdxdump, buildDumpArgs(this.tools.backend, file, options), { ...opts, onStdout: onChunk });
    if (result.exitCode !== 0) {
      const message = clean(result.stdout + '\n' + result.stderr) || `gdxdump failed with exit code ${result.exitCode}`;
      throw new ToolError(message, result);
    }
  }

  /**
   * Runs gdxdiff. Exit code 0 means no differences and 1 means differences were
   * found; any other exit code is an error.
   */
  async diff(file1: string, file2: string, diffFile: string, options: DiffOptions = {}, opts?: RunOptions): Promise<RunResult> {
    this.checkFile(file1);
    this.checkFile(file2);
    this.checkFile(diffFile);
    const result = await this.exec(this.tools.gdxdiff, buildDiffArgs(this.tools.backend, file1, file2, diffFile, options), opts);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const message = clean(result.stdout + '\n' + result.stderr) || `gdxdiff failed with exit code ${result.exitCode}`;
      throw new ToolError(message, result);
    }
    return result;
  }
}
