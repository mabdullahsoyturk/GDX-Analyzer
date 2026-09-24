/**
 * Reading GDX files with gdxdump: the symbol list and the records of a symbol.
 * No dependency on `vscode`, so the MCP server (mcp.ts) can use it too.
 */
import { GdxSymbol, SymbolColumns, mergeDomainInfo, mergeSubtypes, parseDomainInfo, parseSubtypes, parseSymbolStream, parseSymbols, parseVersionInfo } from './parse';
import { GdxTools } from './tools';

export interface GdxFileInfo {
  version: [string, string][];
  symbols: GdxSymbol[];
}

export async function loadFileInfo(tools: GdxTools, file: string): Promise<GdxFileInfo> {
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
}

/**
 * The records of a symbol in compact columns, parsed while gdxdump writes them (so that
 * symbols with millions of records fit into memory); hexBytes gives the exact values.
 */
export async function loadSymbolColumns(tools: GdxTools, file: string, symbol: GdxSymbol, signal?: AbortSignal): Promise<SymbolColumns> {
  const parser = parseSymbolStream(symbol);
  await tools.dumpStream(file, { symbol: symbol.name, format: 'csv', csvAllFields: true, csvSetText: true, dFormat: 'hexBytes' }, parser.push, { signal });
  return parser.finish();
}
