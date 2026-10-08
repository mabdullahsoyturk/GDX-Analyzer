/**
 * Reading and comparing GDX files: the symbol list, the records of a symbol, the unique elements,
 * the text gdxdump writes of them, and the comparison of two files as gdxdiff does it. Done natively
 * (gdxReader.ts, gdxText.ts, gdxDiff.ts) or, with `useGamsTools` or for files the native reader does
 * not support, with gdxdump and gdxdiff. No dependency on `vscode`, so the MCP server (mcp.ts) can use it too.
 */
import * as path from 'path';
import { GdxFormatError, GdxReader } from './gdxReader';
import { dumpText, symbolCsv } from './gdxText';
import { gdxDiff } from './gdxDiff';
import { statFile } from './platform/files';
import type { DiffOptions, RunResult } from './tools';
import { GdxSymbol, SymbolColumns, mergeDomainInfo, mergeSubtypes, parseDomainInfo, parseSubtypes, parseSymbolStream, parseSymbols, parseUelTable, parseVersionInfo } from './parse';
import type { GdxTools } from './tools';

export interface GdxFileInfo {
  version: [string, string][];
  symbols: GdxSymbol[];
}

/** How GDX files are read. */
export interface GdxSource {
  /** Encoding of labels and texts. */
  encoding: string;
  /** Read, dump and compare with gdxdump and gdxdiff instead of natively. */
  useGamsTools?: boolean;
  /** gdxdump and gdxdiff (resolved when first needed: reading natively needs neither). */
  tools: () => GdxTools;
  log?: (line: string) => void;
}

/** A source that reads with gdxdump of `tools` (e.g. for tests and the comparison of both). */
export function gdxdumpSource(tools: GdxTools): GdxSource {
  return { encoding: tools.encoding, useGamsTools: true, tools: () => tools };
}

/** The tables of the most recently read files, read again when a file changes. */
const readers = new Map<string, { mtimeMs: number; size: number; reader: Promise<GdxReader> }>();
const MAX_READERS = 4;

async function nativeReader(file: string, encoding: string): Promise<GdxReader> {
  const stat = await statFile(file);
  const key = `${file}\0${encoding}`;
  const hit = readers.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    readers.delete(key);
    readers.set(key, hit);
    return hit.reader;
  }
  const reader = GdxReader.open(file, encoding);
  reader.catch(() => readers.get(key)?.reader === reader && readers.delete(key));
  readers.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, reader });
  while (readers.size > MAX_READERS) readers.delete(readers.keys().next().value as string);
  return reader;
}

/**
 * Reads natively, or with gdxdump if asked to or if the native reader does not support the file
 * (e.g. a big-endian file), when gdxdump is available.
 */
async function read<T>(source: GdxSource, file: string, native: (reader: GdxReader) => T | Promise<T>, gdxdump: (tools: GdxTools) => Promise<T>): Promise<T> {
  if (source.useGamsTools) {
    return gdxdump(source.tools());
  }
  try {
    return await native(await nativeReader(file, source.encoding));
  } catch (err) {
    if (!(err instanceof GdxFormatError)) throw err;
    let tools: GdxTools;
    try {
      tools = source.tools();
    } catch {
      throw err;
    }
    source.log?.(`Reading ${file} with gdxdump: ${err.message}`);
    return gdxdump(tools);
  }
}

export function loadFileInfo(source: GdxSource, file: string): Promise<GdxFileInfo> {
  return read(
    source,
    file,
    (r) => {
      const { version, symbols } = r.contents();
      return { version, symbols };
    },
    async (tools) => {
      // In parallel, since each GAMSPy CLI call pays for a Python interpreter start-up.
      const [symbolsText, domainText, versionText, declarations] = await Promise.all([
        tools.dump(file, { symbols: true }),
        tools.dump(file, { domainInfo: true }),
        tools.dump(file, { version: true }),
        // The declarations contain the variable subtypes and singleton sets.
        tools.dump(file, { noData: true }),
      ]);
      const symbols = mergeSubtypes(mergeDomainInfo(parseSymbols(symbolsText), parseDomainInfo(domainText)), parseSubtypes(declarations));
      return { version: parseVersionInfo(versionText), symbols };
    },
  );
}

/** The symbols of a file (with gdxdump only their names, types, dimensions, records and texts). */
export function loadSymbolList(source: GdxSource, file: string): Promise<GdxSymbol[]> {
  return read(
    source,
    file,
    (r) => r.contents().symbols,
    async (tools) => parseSymbols(await tools.dump(file, { symbols: true })),
  );
}

/** The domain of each symbol, by its lower-case name. */
export function loadDomains(source: GdxSource, file: string): Promise<Map<string, string[]>> {
  return read(
    source,
    file,
    (r) => new Map(r.contents().symbols.map((s) => [s.name.toLowerCase(), s.domain])),
    async (tools) => new Map([...parseDomainInfo(await tools.dump(file, { domainInfo: true }))].map(([k, v]) => [k, v.domain])),
  );
}

/** The unique elements of a file in GDX order. */
export function loadUels(source: GdxSource, file: string): Promise<string[]> {
  return read(
    source,
    file,
    (r) => r.uels,
    async (tools) => parseUelTable(await tools.dump(file, { uelTable: 'uels', noData: true })),
  );
}

/**
 * The records of a symbol in compact columns (so that symbols with millions of records fit
 * into memory), with exact values; with gdxdump parsed while it writes them (dFormat=hexBytes).
 */
export function loadSymbolColumns(source: GdxSource, file: string, symbol: GdxSymbol, signal?: AbortSignal): Promise<SymbolColumns> {
  return read(
    source,
    file,
    (r) => r.symbolColumns(symbol, signal),
    async (tools) => {
      const parser = parseSymbolStream(symbol);
      await tools.dumpStream(file, { symbol: symbol.name, format: 'csv', csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' }, parser.push, { signal });
      return parser.finish();
    },
  );
}

/** The output of gdxdump for a file, or for one of its symbols: GAMS declarations with the data. */
export function loadDumpText(source: GdxSource, file: string, symbol?: string, signal?: AbortSignal): Promise<string> {
  return read(
    source,
    file,
    (r) => dumpText(r, symbol, signal),
    (tools) => tools.dump(file, { symbol }, { signal }),
  );
}

/** A symbol as CSV with all fields and set texts, as gdxdump writes it (Format=csv CSVAllFields CSVSetText). */
export function loadSymbolCsv(source: GdxSource, file: string, symbol: string, signal?: AbortSignal): Promise<string> {
  return read(
    source,
    file,
    (r) => symbolCsv(r, symbol, signal),
    (tools) => tools.dump(file, { symbol, format: 'csv', csvAllFields: true, csvSetText: true }, { signal }),
  );
}

/**
 * Compares two GDX files as gdxdiff does: the summary of differences (its console output) and the
 * difference file. Exit code 0: no differences, 1: differences.
 */
export async function compareFiles(source: GdxSource, file1: string, file2: string, diffFile: string, options: DiffOptions = {}, signal?: AbortSignal): Promise<RunResult> {
  if (source.useGamsTools) {
    return source.tools().diff(file1, file2, diffFile, options, { signal });
  }
  try {
    // With absolute paths, as gdxdiff is run (tools.ts): they are the texts of FilesCompared.
    const { exitCode, stdout } = await gdxDiff(path.resolve(file1), path.resolve(file2), path.resolve(diffFile), options, signal);
    return { exitCode, stdout, stderr: '' };
  } catch (err) {
    if (!(err instanceof GdxFormatError)) throw err;
    let tools: GdxTools;
    try {
      tools = source.tools();
    } catch {
      throw err;
    }
    source.log?.(`Comparing with gdxdiff: ${err.message}`);
    return tools.diff(file1, file2, diffFile, options, { signal });
  }
}
