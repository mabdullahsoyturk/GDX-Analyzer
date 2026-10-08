/**
 * The command line of GDX Analyzer, for Git (diff.gdx.textconv, see gitTextconv.ts) and scripts:
 *
 *   node out/cli.js dump <file> [<symbol>] [--csv] [--encoding <label>]
 *       The text gdxdump writes of a file or of one symbol; with --csv, a symbol as CSV with all fields
 *       and set texts (as gdxdump Format=csv CSVAllFields CSVSetText).
 *   node out/cli.js textconv <file> [--encoding <label>]
 *       The text of a file for `git diff`, as dump. A file that is not a GDX file (e.g. a Git LFS pointer)
 *       is written as it is if it is text, else as a note with its size and hash, so that diffs still work.
 *
 * Files the extension cannot read itself are read with gdxdump, found as by the MCP server (mcp.ts) with
 * the environment variables GDX_BACKEND, GDX_GAMS_SYSTEM_DIRECTORY, GDX_GAMSPY_EXECUTABLE, GDX_ENCODING
 * and GDX_USE_GAMS_TOOLS. Exit code 0: success, 1: the file could not be read, 2: wrong arguments.
 *
 * No dependency on `vscode`.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GdxSource, loadDumpText, loadSymbolCsv } from './gdxFile';
import { GdxTools, resolveToolsFromEnv } from './tools';

const USAGE = `usage:
  gdx dump <file> [<symbol>] [--csv] [--encoding <label>]
  gdx textconv <file> [--encoding <label>]`;

export interface CliIO {
  stdout: (text: string | Uint8Array) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

class UsageError extends Error {}

/** The arguments: the command, its positional arguments and the options. */
function parseArgs(argv: string[]): { command: string; positional: string[]; csv: boolean; encoding?: string } {
  const positional: string[] = [];
  let csv = false;
  let encoding: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') {
      csv = true;
    } else if (a === '--encoding') {
      encoding = argv[++i];
      if (!encoding) throw new UsageError('--encoding needs a label, e.g. windows-1252.');
    } else if (a.startsWith('--encoding=')) {
      encoding = a.slice('--encoding='.length);
    } else if (a.startsWith('--')) {
      throw new UsageError(`Unknown option ${a}.`);
    } else {
      positional.push(a);
    }
  }
  const [command = '', ...rest] = positional;
  return { command, positional: rest, csv, encoding };
}

function source(env: NodeJS.ProcessEnv, encoding: string | undefined, log: (line: string) => void): GdxSource {
  const enc = encoding?.trim() || env.GDX_ENCODING?.trim() || 'utf-8';
  let tools: GdxTools | undefined;
  return {
    encoding: enc,
    useGamsTools: /^(1|true|yes)$/i.test(env.GDX_USE_GAMS_TOOLS?.trim() ?? ''),
    tools: () => (tools ??= new GdxTools(resolveToolsFromEnv(env), log, enc)),
    log,
  };
}

/** Whether data looks like text, as Git decides it: no NUL byte in its first 8000 bytes. */
function isText(data: Uint8Array): boolean {
  return !data.subarray(0, 8000).includes(0);
}

/** Runs the command line; returns the exit code. */
export async function main(argv: string[], io: CliIO = processIO): Promise<number> {
  const env = io.env ?? process.env;
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
    if (args.command !== 'dump' && args.command !== 'textconv') {
      throw new UsageError(args.command ? `Unknown command ${args.command}.` : 'No command given.');
    }
    if (!args.positional.length) throw new UsageError(`${args.command} needs a GDX file.`);
    if (args.positional.length > (args.command === 'dump' ? 2 : 1)) throw new UsageError(`Too many arguments for ${args.command}.`);
    if (args.csv && (args.command !== 'dump' || args.positional.length < 2)) throw new UsageError('--csv needs a symbol.');
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  const [file, symbol] = args.positional;
  // Git shows what textconv writes to stderr in the middle of a diff: only dump logs (e.g. the gdxdump it runs).
  const src = source(env, args.encoding, args.command === 'dump' ? (line) => io.stderr(`${line}\n`) : () => undefined);
  try {
    if (args.command === 'dump') {
      io.stdout(args.csv ? await loadSymbolCsv(src, file, symbol) : await loadDumpText(src, file, symbol));
      return 0;
    }
    // textconv: Git passes a temporary file of each version; an empty one is an empty version.
    if (fs.statSync(file).size === 0) return 0;
    io.stdout(await loadDumpText(src, file));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.command === 'textconv') {
      // A failing textconv makes the whole `git diff` fail: show what the file holds instead.
      let data: Buffer;
      try {
        data = fs.readFileSync(file);
      } catch {
        io.stderr(`gdx textconv: ${message}\n`);
        return 1;
      }
      if (isText(data)) {
        io.stdout(data);
      } else {
        const sha1 = crypto.createHash('sha1').update(data).digest('hex');
        io.stdout(`* GDX Analyzer cannot show this file as text (${message})\n* ${data.length} bytes, SHA-1 ${sha1}\n`);
      }
      return 0;
    }
    io.stderr(`gdx dump: ${path.basename(file)}: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
}
