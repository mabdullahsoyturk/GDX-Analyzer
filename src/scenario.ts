/**
 * One symbol of several GDX files (scenarios) as one table, for comparing scenarios: the
 * keys of the symbol, then the scenario as an extra (last) key, then the fields, and for
 * the value of parameters and the level and marginal of variables and equations their
 * difference from the base scenario (Δ) and that difference in percent (Δ%).
 *
 * A record of a scenario is a row; a record of the base that a scenario does not have is a
 * row of that scenario too (without values, Δ = −base), as GAMS treats missing records as 0.
 * The table view shows the scenarios side by side (the scenario is the last key, so the
 * column dimension), charts can use the scenarios as series.
 *
 * No dependency on `vscode`.
 */
import { ColumnStore, LabelColumn, Labels, NumberColumn, Sp, StoredColumn } from './columns';
import { fieldDefaults } from './defaults';
import type { SymbolColumns } from './parse';
import { Column, Table, relativeOf } from './table';

export interface ScenarioData {
  name: string;
  /** The records of the symbol in this scenario; undefined if the file does not have the symbol. */
  data?: SymbolColumns;
}

/** Name of the key column of the scenarios. */
export const SCENARIO_COLUMN = 'Scenario';

/** Fields compared with the base scenario. */
const COMPARED = new Set(['Value', 'Level', 'Marginal']);

/** Unique scenario names for files: the file names without .gdx, with the folder where they repeat. */
export function scenarioNames(files: string[]): string[] {
  const parts = files.map((f) => f.split(/[\\/]/).filter(Boolean));
  const base = (p: string[]) => (p[p.length - 1] ?? '').replace(/\.gdx$/i, '');
  return parts.map((p, i) => {
    const name = base(p);
    const same = parts.filter((q) => base(q) === name).length > 1;
    let label = same && p.length > 1 ? `${p[p.length - 2]}/${name}` : name;
    // Still not unique (e.g. the same file twice): number them.
    const earlier = parts.slice(0, i).filter((q) => (same && q.length > 1 ? `${q[q.length - 2]}/${base(q)}` : base(q)) === label).length;
    if (earlier) label += ` (${earlier + 1})`;
    return label;
  });
}

/**
 * The table of a symbol in the scenarios (in their order); `base` is the index of the base
 * scenario. With the symbol's type (and subtype), the default values of variable and
 * equation fields are known (e.g. for the solution filters). Throws if the scenarios
 * have the symbol with different dimensions or fields.
 */
export function scenarioTable(scenarios: ScenarioData[], base: number, symbol?: { type: string; subtype?: string }): Table {
  // The names of the dimensions: those of the base if it has the symbol.
  const first = scenarios[base]?.data ?? scenarios.find((s) => s.data)?.data;
  if (!first) {
    throw new Error('None of the files has this symbol.');
  }
  const keyCount = first.keyCount;
  const keyNames = first.columns.slice(0, keyCount);
  const fields = first.columns.slice(keyCount);
  for (const s of scenarios) {
    if (!s.data) continue;
    const f = s.data.columns.slice(s.data.keyCount);
    if (s.data.keyCount !== keyCount || f.length !== fields.length || f.some((x) => !fields.includes(x))) {
      throw new Error(`The symbol has ${keyCount} dimension(s) and the fields ${fields.join(', ')} in one file, but ${s.data.keyCount} and ${f.join(', ')} in ${s.name}.`);
    }
  }
  const n = scenarios.length;

  // Labels of the keys in all scenarios, the base first (so that its order comes first).
  const labels = keyNames.map(() => new Labels());
  const order = [base, ...scenarios.map((_, i) => i).filter((i) => i !== base)];
  const globalIds: (Int32Array[] | undefined)[] = scenarios.map(() => undefined);
  for (const s of order) {
    const data = scenarios[s].data;
    if (!data) continue;
    globalIds[s] = keyNames.map((_, d) => {
      const col = data.store.columns[d] as LabelColumn;
      const map = Int32Array.from(col.labels.list, (l) => labels[d].intern(l));
      return Int32Array.from(col.ids, (id) => map[id]);
    });
  }

  // A number per key combination while it is exact, else a string.
  const counts = labels.map((l) => Math.max(1, l.list.length));
  const numeric = counts.reduce((a, b) => a * b, 1) < Number.MAX_SAFE_INTEGER;
  const keyIndex = new Map<number | string, number>();
  const keyOf: Int32Array[] = scenarios.map(() => new Int32Array(0));
  /** A scenario and record of each key (for its labels). */
  const keyRec: [number, number][] = [];
  for (const s of order) {
    const data = scenarios[s].data;
    const ids = globalIds[s];
    if (!data || !ids) continue;
    const keys = new Int32Array(data.store.length);
    for (let r = 0; r < data.store.length; r++) {
      let k: number | string = numeric ? 0 : '';
      for (let d = 0; d < keyCount; d++) {
        k = numeric ? (k as number) * counts[d] + ids[d][r] : `${k}${ids[d][r]},`;
      }
      let index = keyIndex.get(k);
      if (index === undefined) {
        index = keyRec.length;
        keyIndex.set(k, index);
        keyRec.push([s, r]);
      }
      keys[r] = index;
    }
    keyOf[s] = keys;
  }
  const keyCountTotal = keyRec.length;
  const recOf = scenarios.map((s, i) => {
    const rec = new Int32Array(keyCountTotal).fill(-1);
    const keys = keyOf[i];
    for (let r = 0; r < keys.length; r++) rec[keys[r]] = r;
    return rec;
  });

  // Rows: per key, the scenarios (in their order) that have the record, or whose base has it.
  const rowKey: number[] = [];
  const rowScenario: number[] = [];
  for (let k = 0; k < keyCountTotal; k++) {
    const inBase = recOf[base][k] >= 0;
    for (let s = 0; s < n; s++) {
      if (recOf[s][k] >= 0 || (inBase && s !== base)) {
        rowKey.push(k);
        rowScenario.push(s);
      }
    }
  }
  const m = rowKey.length;

  const stored: StoredColumn[] = [];
  const columns: Column[] = [];
  keyNames.forEach((name, d) => {
    const ids = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      const [s, r] = keyRec[rowKey[i]];
      ids[i] = globalIds[s]![d][r];
    }
    stored.push({ type: 'label', ids, labels: labels[d] });
    columns.push({ name, kind: 'key' });
  });
  const scenarioLabels = new Labels();
  scenarios.forEach((s) => scenarioLabels.intern(s.name));
  stored.push({ type: 'label', ids: Int32Array.from(rowScenario), labels: scenarioLabels });
  columns.push({ name: SCENARIO_COLUMN, kind: 'key' });

  /** The record of row i in its scenario and in the base (-1: none). */
  const own = (i: number) => recOf[rowScenario[i]][rowKey[i]];
  const inBase = (i: number) => recOf[base][rowKey[i]];
  /** Per field: its column in each scenario's store. */
  const fieldCols = fields.map((f) => scenarios.map((s) => (s.data ? s.data.store.columns[s.data.columns.indexOf(f)] : undefined)));
  /** Per shown field: its position in the table and its columns in the stores, to mark values that differ from the base. */
  const marked: { pos: number; cols: (StoredColumn | undefined)[] }[] = [];

  fields.forEach((name, f) => {
    const cols = fieldCols[f];
    const text = cols.some((c) => c?.type === 'label');
    if (text) {
      // Set element texts.
      const textLabels = new Labels();
      const empty = textLabels.intern('');
      const ids = new Int32Array(m);
      for (let i = 0; i < m; i++) {
        const c = cols[rowScenario[i]] as LabelColumn | undefined;
        const r = own(i);
        ids[i] = c && r >= 0 ? textLabels.intern(c.labels.list[c.ids[r]]) : empty;
      }
      marked.push({ pos: columns.length, cols });
      stored.push({ type: 'label', ids, labels: textLabels });
      columns.push({ name, kind: 'text' });
      return;
    }
    const values = new Float64Array(m);
    const special = new Uint8Array(m).fill(Sp.Empty);
    for (let i = 0; i < m; i++) {
      const c = cols[rowScenario[i]] as NumberColumn | undefined;
      const r = own(i);
      if (c && r >= 0) {
        values[i] = c.values[r];
        special[i] = c.special[r];
      }
    }
    marked.push({ pos: columns.length, cols });
    stored.push({ type: 'number', values, special });
    columns.push({ name, kind: 'value' });
    if (!COMPARED.has(name)) {
      return;
    }
    // Δ and Δ% from the base; a missing record counts as 0, special values other than EPS have no Δ.
    const baseCol = cols[base] as NumberColumn | undefined;
    const number = (c: NumberColumn | undefined, r: number): number | undefined => {
      if (!c || r < 0) return 0;
      const sp = c.special[r];
      return sp === Sp.None ? c.values[r] : sp === Sp.Eps || sp === Sp.Empty ? 0 : undefined;
    };
    const dValues = new Float64Array(m);
    const dSpecial = new Uint8Array(m).fill(Sp.Empty);
    const rValues = new Float64Array(m);
    const rSpecial = new Uint8Array(m).fill(Sp.Empty);
    for (let i = 0; i < m; i++) {
      if (rowScenario[i] === base) continue;
      const a = number(baseCol, inBase(i));
      const b = number(cols[rowScenario[i]] as NumberColumn | undefined, own(i));
      if (a === undefined || b === undefined) continue;
      dValues[i] = b - a;
      dSpecial[i] = Sp.None;
      const rel = relativeOf(a, b);
      rValues[i] = rel.value;
      rSpecial[i] = rel.special;
    }
    stored.push({ type: 'number', values: dValues, special: dSpecial }, { type: 'number', values: rValues, special: rSpecial });
    columns.push({ name: `Δ ${name}`, kind: 'value', delta: true }, { name: `Δ% ${name}`, kind: 'value', delta: true, relative: true });
  });

  const store = new ColumnStore(m, stored);
  const names = columns.map((c) => c.name);
  /** A cell of a scenario's store as text ('' if there is no record). */
  const cellOf = (c: StoredColumn | undefined, r: number): string => {
    if (!c || r < 0) return '';
    if (c.type === 'label') return c.labels.list[c.ids[r]];
    return c.special[r] === Sp.None ? String(c.values[r]) : `#${c.special[r]}`;
  };
  return {
    columns,
    store,
    defaults:
      symbol && (symbol.type === 'Var' || symbol.type === 'Equ')
        ? fieldDefaults(symbol.type, symbol.subtype, names, { length: m, get: (r, c) => store.get(r, c) })
        : undefined,
    setTexts: fields.includes('Text'),
    orderedColumns: [keyCount],
    // Charts: the values (not the differences) by the last dimension, a series per scenario.
    chartDefaults: {
      x: keyCount ? keyCount - 1 : keyCount,
      series: keyCount ? keyCount : undefined,
      value: columns.findIndex((c) => c.kind === 'value' && !c.delta),
    },
    // Values of a scenario that differ from the base (or that the base does not have).
    rowMarks: (i) => {
      if (rowScenario[i] === base) return [];
      const r = own(i);
      const b = inBase(i);
      return marked.flatMap(({ pos, cols }) => (cellOf(cols[rowScenario[i]], r) !== cellOf(cols[base], b) ? [pos] : []));
    },
    rowClass: (i) => (rowScenario[i] === base ? 'scenario-base' : undefined),
  };
}
