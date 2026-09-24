/**
 * Makes the GDX MCP server (mcp.ts) available to VS Code's chat, and copies its
 * configuration for other agents (e.g. Claude Code).
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { GdxService } from './service';
import { findOnPath } from './tools';

/** Environment of the server: the tools the extension uses, and the encoding. */
function serverEnv(service: GdxService): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration('gdx');
  const env: Record<string, string> = {};
  const encoding = cfg.get<string>('encoding', 'utf-8').trim();
  if (encoding && encoding.toLowerCase() !== 'utf-8') {
    env.GDX_ENCODING = encoding;
  }
  try {
    // The resolved tools, so that the server finds them like the extension does (e.g. in a workspace .venv).
    const tools = service.tools().tools;
    env.GDX_BACKEND = tools.backend;
    env[tools.backend === 'gams' ? 'GDX_GAMS_SYSTEM_DIRECTORY' : 'GDX_GAMSPY_EXECUTABLE'] = tools.location;
  } catch {
    // Not found: the server reports it when a tool is called.
    env.GDX_BACKEND = cfg.get<string>('backend', 'auto');
  }
  return env;
}

export function registerMcpServer(context: vscode.ExtensionContext, service: GdxService): void {
  const script = path.join(context.extensionPath, 'out', 'mcp.js');
  const version = String(context.extension.packageJSON.version ?? '');
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gdx') && changed.fire()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.lm.registerMcpServerDefinitionProvider('gdx.mcp', {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        // VS Code's own runtime runs the script as Node.js.
        const server = new vscode.McpStdioServerDefinition('GDX', process.execPath, [script], { ELECTRON_RUN_AS_NODE: '1', ...serverEnv(service) }, version);
        const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file');
        if (folder) {
          server.cwd = folder.uri;
        }
        return [server];
      },
    }),
    vscode.commands.registerCommand('gdx.copyMcpServerConfig', async () => {
      const node = findOnPath('node');
      const command = node ? 'node' : process.execPath;
      const env = { ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }), ...serverEnv(service) };
      const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Claude Code command', description: 'claude mcp add …', format: 'claude' as const },
          { label: 'JSON configuration', description: 'mcpServers entry for .mcp.json, Cursor, Claude Desktop, …', format: 'json' as const },
        ],
        { title: 'Copy the GDX MCP Server Configuration' },
      );
      if (!choice) {
        return;
      }
      const text =
        choice.format === 'claude'
          ? ['claude mcp add gdx', ...Object.entries(env).map(([k, v]) => `-e ${quote(`${k}=${v}`)}`), '--', quote(command), quote(script)].join(' ')
          : JSON.stringify({ mcpServers: { gdx: { command, args: [script], env } } }, null, 2);
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(
        `Copied the ${choice.format === 'claude' ? 'command' : 'configuration'}. The server is part of this extension version; copy it again after updating the extension.`,
      );
    }),
  );
}
