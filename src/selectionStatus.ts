/**
 * Sum, average and count of the selected cells in the status bar (like a spreadsheet),
 * for the active GDX viewer or comparison.
 */
import * as vscode from 'vscode';
import { ShownStats, describeStats } from './query';

/** The status bar item; shows the statistics of one owner (a viewer tab or comparison) at a time. */
export class SelectionStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('gdxAnalyzer.selection', vscode.StatusBarAlignment.Right, 100);
  private owner?: object;

  constructor() {
    this.item.name = 'GDX Selection';
  }

  dispose() {
    this.item.dispose();
  }

  /** Shows the statistics of `owner`'s selection (nothing for fewer than two cells). */
  show(owner: object, stats: ShownStats | undefined) {
    const shown = stats && describeStats(stats);
    if (!shown) {
      this.clear(owner);
      return;
    }
    this.owner = owner;
    this.item.text = shown.text;
    this.item.tooltip = shown.tooltip;
    this.item.show();
  }

  /** Hides the item if it shows `owner`'s statistics. */
  clear(owner: object) {
    if (this.owner === owner) {
      this.owner = undefined;
      this.item.hide();
    }
  }
}
