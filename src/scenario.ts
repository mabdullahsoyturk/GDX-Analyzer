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

/** The index of the base after removing the file at `removed`: the same file, or the first if it was the base. */
export function baseAfterRemoval(base: number, removed: number): number {
  return base === removed ? 0 : base > removed ? base - 1 : base;
}

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
  const totalRecords = scenarios.reduce((a, s) => a + (s.data?.store.length ?? 0), 0);
  const keyScenario = new Int32Array(totalRecords);
  const keyRecord = new Int32Array(totalRecords);
  let keyCountTotal = 0;
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
        index = keyCountTotal++;
        keyIndex.set(k, index);
        keyScenario[index] = s;
        keyRecord[index] = r;
      }
      keys[r] = index;
    }
    keyOf[s] = keys;
  }
  keyIndex.clear();
  const recOf = scenarios.map((s, i) => {
    const rec = new Int32Array(keyCountTotal).fill(-1);
    const keys = keyOf[i];
    for (let r = 0; r < keys.length; r++) rec[keys[r]] = r;
    return rec;
  });

  // Rows: per key, the scenarios (in their order) that have the record, or whose base has it.
  const hasRow = (k: number, s: number) => recOf[s][k] >= 0 || (s !== base && recOf[base][k] >= 0);
  let m = 0;
  for (let k = 0; k < keyCountTotal; k++) for (let s = 0; s < n; s++) if (hasRow(k, s)) m++;
  const rowKey = new Int32Array(m);
  const rowScenario = new Int32Array(m);
  /** The row of the base with the same key (-1: none), to mark the values that differ. */
  const baseRow = new Int32Array(m).fill(-1);
  for (let k = 0, i = 0; k < keyCountTotal; k++) {
    const first = i;
    let baseAt = -1;
    for (let s = 0; s < n; s++) {
      if (!hasRow(k, s)) continue;
      if (s === base) baseAt = i;
      rowKey[i] = k;
      rowScenario[i++] = s;
    }
    if (baseAt >= 0) baseRow.fill(baseAt, first, i);
  }

  const stored: StoredColumn[] = [];
  const columns: Column[] = [];
  keyNames.forEach((name, d) => {
    const ids = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      const k = rowKey[i];
      ids[i] = globalIds[keyScenario[k]]![d][keyRecord[k]];
    }
    stored.push({ type: 'label', ids, labels: labels[d] });
    columns.push({ name, kind: 'key' });
  });
  const scenarioLabels = new Labels();
  scenarios.forEach((s) => scenarioLabels.intern(s.name));
  stored.push({ type: 'label', ids: rowScenario, labels: scenarioLabels });
  columns.push({ name: SCENARIO_COLUMN, kind: 'key' });

  /** The record of row i in its scenario and in the base (-1: none). */
  const own = (i: number) => recOf[rowScenario[i]][rowKey[i]];
  const inBase = (i: number) => recOf[base][rowKey[i]];
  /** Per field: its column in each scenario's store. */
  const fieldCols = fields.map((f) => scenarios.map((s) => (s.data ? s.data.store.columns[s.data.columns.indexOf(f)] : undefined)));
  /** The positions of the fields in the table, to mark the values that differ from the base. */
  const marked: number[] = [];

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
      marked.push(columns.length);
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
    marked.push(columns.length);
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
    ...rowFunctions(stored, marked, rowScenario, baseRow, base),
  };
}

/**
 * The marks (values of a scenario that differ from the base, or that the base does not have)
 * and the classes of the rows. Created outside scenarioTable, whose closures would keep the
 * records of the files in memory: these use the table only.
 */
function rowFunctions(stored: StoredColumn[], marked: number[], rowScenario: Int32Array, baseRow: Int32Array, base: number): Pick<Table, 'rowMarks' | 'rowClass'> {
  /** Whether a field of row i differs from the base row b (-1: none, like an empty cell). */
  const differs = (c: StoredColumn, i: number, b: number): boolean => {
    if (c.type === 'label') return b < 0 ? c.labels.list[c.ids[i]] !== '' : c.ids[i] !== c.ids[b];
    const sb = b < 0 ? Sp.Empty : c.special[b];
    return c.special[i] !== sb || (sb === Sp.None && c.values[i] !== c.values[b]);
  };
  return {
    rowMarks: (i) => (rowScenario[i] === base ? [] : marked.filter((pos) => differs(stored[pos], i, baseRow[i]))),
    rowClass: (i) => (rowScenario[i] === base ? 'scenario-base' : undefined),
  };
}
