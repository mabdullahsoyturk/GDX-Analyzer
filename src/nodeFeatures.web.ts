/**
 * The web extension has none of the features of nodeFeatures.ts: their commands are hidden there
 * (`isWeb` in package.json).
 */
import * as vscode from 'vscode';
import { GdxService } from './service';

export function registerNodeFeatures(
  _context: vscode.ExtensionContext,
  _service: GdxService,
  _currentGdx: () => vscode.Uri | undefined,
  _compare: (file1: string, file2: string, labels: Record<string, string>) => void,
) {}
