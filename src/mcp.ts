/**
 * MCP server (stdio) that gives AI agents read-only access to GDX files: the tools of
 * gdxQuery.ts. VS Code starts it for its chat (see extension.ts); other agents such as
 * Claude Code can run it with `node out/mcp.js` (GDX: Copy MCP Server Configuration).
 *
 * The tools are found like in the extension; these environment variables set them:
 *   GDX_BACKEND                auto (default), gams or gamspy
 *   GDX_GAMS_SYSTEM_DIRECTORY  GAMS system directory with gdxdump and gdxdiff
 *   GDX_GAMSPY_EXECUTABLE      gamspy executable (or its virtual environment)
 *   GDX_ENCODING               encoding of labels and texts (default utf-8)
 *
 * The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.
 * No dependency on `vscode`.
 */
import * as readline from 'readline';
import { GdxQueries, QueryError, TOOL_SPECS } from './gdxQuery';
import { BackendSetting, GdxTools, ToolError, ToolNotFoundError, resolveTools } from './tools';

/** Protocol versions this server speaks, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// package.json is next to out/ in the extension and in the repository.
const VERSION: string = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
}

/** Handles the JSON-RPC messages of one MCP session; `send` writes a message to the client. */
export class McpServer {
  private readonly queries: GdxQueries;
  private cachedTools?: GdxTools;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;

  constructor(
    private readonly send: (message: unknown) => void,
    options: ServerOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((l) => process.stderr.write(l + '\n'));
    this.queries = new GdxQueries(() => this.tools(), options.cwd ?? process.cwd());
  }

  dispose() {
    this.queries.dispose();
  }

  private tools(): GdxTools {
    if (!this.cachedTools) {
      const env = this.env;
      const resolved = resolveTools({
        backend: (env.GDX_BACKEND as BackendSetting) || 'auto',
        gamsSystemDirectory: env.GDX_GAMS_SYSTEM_DIRECTORY,
        gamspyExecutable: env.GDX_GAMSPY_EXECUTABLE,
        venvSearchRoots: [process.cwd()],
      });
      this.log(`Using ${resolved.backend === 'gams' ? `gdxdump/gdxdiff from ${resolved.location}` : `the GAMSPy CLI ${resolved.location}`}`);
      this.cachedTools = new GdxTools(resolved, (l) => this.log(l), env.GDX_ENCODING?.trim() || 'utf-8');
    }
    return this.cachedTools;
  }

  /** Handles one line of input (a JSON-RPC message or a batch). */
  async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    let message: Request | Request[];
    try {
      message = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    for (const m of Array.isArray(message) ? message : [message]) {
      await this.handle(m);
    }
  }

  private async handle(m: Request): Promise<void> {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
      // A response to a request of ours (we send none) or an invalid message.
      return;
    }
    const isRequest = m.id !== undefined && m.id !== null;
    try {
      const result = await this.dispatch(m);
      if (isRequest) {
        this.send({ jsonrpc: '2.0', id: m.id, result });
      }
    } catch (err) {
      if (isRequest) {
        const code = err instanceof RpcError ? err.code : -32603;
        this.send({ jsonrpc: '2.0', id: m.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    }
  }

  private async dispatch(m: Request): Promise<unknown> {
    switch (m.method) {
      case 'initialize': {
        const requested = m.params?.protocolVersion;
        return {
          protocolVersion: typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'gdx', title: 'GDX Viewer', version: VERSION },
          instructions:
            'Read-only access to GAMS GDX files (model data and solutions). Call gdx_list_symbols first, then gdx_read_symbol or gdx_symbol_stats ' +
            'for the records of a symbol; gdx_compare compares two files with gdxdiff. Results are CSV with exact values and are paged.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: TOOL_SPECS.map((t) => ({ ...t, annotations: { title: t.title, readOnlyHint: true, openWorldHint: false } })),
        };
      case 'tools/call':
        return this.callTool(m.params ?? {});
      default:
        if (m.method.startsWith('notifications/')) {
          return undefined;
        }
        throw new RpcError(-32601, `Method not found: ${m.method}`);
    }
  }

  private async callTool(params: Record<string, unknown>) {
    const name = params.name;
    if (typeof name !== 'string' || !TOOL_SPECS.some((t) => t.name === name)) {
      throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await this.queries.call(name, args);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // Errors of the call itself are reported as tool results, so the agent can correct them.
      const known = err instanceof QueryError || err instanceof ToolError || err instanceof ToolNotFoundError || err instanceof RangeError;
      const text = err instanceof Error ? err.message : String(err);
      if (!known) {
        this.log(`Error in ${name}: ${err instanceof Error ? err.stack : text}`);
      }
      if (err instanceof ToolNotFoundError) {
        this.cachedTools = undefined;
      }
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Serves MCP on stdin/stdout until stdin closes. */
export function serveStdio() {
  const server = new McpServer((message) => process.stdout.write(JSON.stringify(message) + '\n'));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Messages are handled concurrently; each answer carries the id of its request.
  rl.on('line', (line) => void server.handleLine(line));
  const stop = () => {
    server.dispose();
    process.exit(0);
  };
  rl.on('close', stop);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  serveStdio();
}
