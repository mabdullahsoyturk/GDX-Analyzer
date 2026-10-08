/**
 * The features of the desktop extension that need Node.js and other processes: the MCP server for AI
 * agents, comparisons with Git revisions (through VS Code's Git extension, which VS Code for the Web does
 * not have) and the setup of git diff for GDX files. The web extension uses nodeFeatures.web.ts instead.
 */
import * as vscode from 'vscode';
import { registerGitCompare } from './gitCompare';
import { registerGitDiffSetup } from './gitDiffSetup';
import { registerMcpServer } from './mcpProvider';
import { GdxService } from './service';

export function registerNodeFeatures(
  context: vscode.ExtensionContext,
  service: GdxService,
  currentGdx: () => vscode.Uri | undefined,
  compare: (file1: string, file2: string, labels: Record<string, string>) => void,
) {
  registerMcpServer(context, service);
  registerGitCompare(context, currentGdx, compare, (err) => service.showError('Comparing with the Git revision failed', err));
  registerGitDiffSetup(context, currentGdx, (err) => service.showError('Setting up git diff for GDX files failed', err));
}
