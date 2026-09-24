/**
 * Saved views of GDX files (selected symbol, symbol list options and, per symbol,
 * filters, sorting, fields, layout and number format), like GAMS Studio keeps them
 * in its settings. The state itself is produced and interpreted by media/viewer.js.
 */

/** The part of vscode.Memento that is needed (for tests without VS Code). */
export interface StateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

interface Entry {
  time: number;
  state: unknown;
}

const KEY = 'gdxAnalyzer.viewStates';
export const MAX_FILES = 100;

/** Normalizes file paths so that the same file maps to one entry (Windows paths are case-insensitive). */
function keyOf(file: string, windows = process.platform === 'win32'): string {
  const p = file.replace(/\\/g, '/');
  return windows ? p.toLowerCase() : p;
}

export class ViewStateStore {
  constructor(
    private readonly storage: StateStorage,
    private readonly windows = process.platform === 'win32',
  ) {}

  private all(): Record<string, Entry> {
    return this.storage.get<Record<string, Entry>>(KEY) ?? {};
  }

  get(file: string): unknown {
    return this.all()[keyOf(file, this.windows)]?.state;
  }

  /** Saves the view of a file; only the most recently saved files are kept. */
  async set(file: string, state: unknown): Promise<void> {
    const all = this.all();
    all[keyOf(file, this.windows)] = { time: Date.now(), state };
    const keys = Object.keys(all).sort((a, b) => all[b].time - all[a].time);
    for (const k of keys.slice(MAX_FILES)) {
      delete all[k];
    }
    await this.storage.update(KEY, all);
  }

  async clear(file: string): Promise<void> {
    const all = this.all();
    delete all[keyOf(file, this.windows)];
    await this.storage.update(KEY, all);
  }
}
