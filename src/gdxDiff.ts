/**
 * Compares two GDX files as gdxdiff does (see https://github.com/GAMS-dev/gdx,
 * src/tools/gdxdiff/gdxdiff.cpp, MIT license), with the native reader and writer: the same
 * summary of differences on "stdout" and the same difference file, whose symbols hold the
 * differing records with an extra dimension (dif1/dif2 for changed records, ins1/ins2 for
 * records of one file only).
 *
 * The files are read byte for byte (RAW_BYTES), so that labels and texts in any encoding are
 * compared and written unchanged. No dependency on `vscode`.
 */
import { Sp } from './columns';
import { GdxReader, RAW_BYTES, SymbolEntry } from './gdxReader';
import { GdxWriter, RAW, asciiLower } from './gdxWriter';
import type { DiffOptions } from './tools';

const STATUS_TEXT = {
  notf1: 'Symbol not found in file 1',
  notf2: 'Symbol not found in file 2',
  dim: 'Dimensions are different',
  typ: 'Types are different',
  key: 'Keys are different',
  data: 'Data are different',
  dim10diff: 'Dim >= maxdim & different',
  domain: 'Domains are different',
};
type Status = 'same' | 'dim10' | keyof typeof STATUS_TEXT;

const TYPE_NAMES = ['Set', 'Parameter', 'Variable', 'Equation', 'Alias'];
const FIELD_NAMES = ['Level', 'Marginal', 'Lower', 'Upper', 'Scale'];
const MAX_DIM = 20;

/** Default records of variables by type, as doubles of GAMS (gmsDefRecVar). */
const P = RAW.pinf;
const M = RAW.minf;
const VAR_DEFAULTS = [
  [0, 0, 0, 0, 1],
  [0, 0, 0, 1, 1],
  [0, 0, 0, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, M, 0, 1],
  [0, 0, M, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, 0, P, 1],
  [0, 0, 1, P, 1],
  [0, 0, 1, P, 1],
];

/** The special value of a double of GAMS (gdxMapValue): 0 for numbers (and acronyms). */
function specialOf(x: number): number {
  return x === RAW.undf ? 1 : x === RAW.na ? 2 : x === RAW.pinf ? 3 : x === RAW.minf ? 4 : x === RAW.eps ? 5 : 0;
}
const SV_EPS = 5;

const RAW_OF: Partial<Record<Sp, number>> = { [Sp.Undf]: RAW.undf, [Sp.NA]: RAW.na, [Sp.PInf]: RAW.pinf, [Sp.MInf]: RAW.minf, [Sp.Eps]: RAW.eps };

/** The records of a symbol: keys as numbers of the common label table, values as doubles of GAMS. */
interface Records {
  count: number;
  keys: Int32Array;
  values: Float64Array;
  /** Values per record. */
  fields: number;
}

/** Values of a record by data type (set, parameter, variable, equation). */
const FIELD_COUNT = [1, 1, 5, 5, 1];

export interface DiffResult {
  /** 0: no differences, 1: differences (as gdxdiff). */
  exitCode: number;
  stdout: string;
}

/** An error in the options (gdxdiff reports them and exits with an error). */
export class DiffOptionError extends Error {}

export async function gdxDiff(file1: string, file2: string, diffFile: string, o: DiffOptions = {}, signal?: AbortSignal): Promise<DiffResult> {
  // Options (as gdxdiff checks them).
  const epsAbsolute = o.eps ?? 0;
  const epsRelative = o.relEps ?? 0;
  if (epsAbsolute < 0) throw new DiffOptionError('Eps cannot be negative');
  if (epsRelative < 0) throw new DiffOptionError('RelEps cannot be negative');
  let active = [0, 1, 2, 3, 4];
  let field: number | undefined;
  if (o.field && o.field.toLowerCase() !== 'all') {
    const f = { l: 0, m: 1, up: 3, lo: 2, prior: 4, scale: 4 }[o.field.toLowerCase()];
    if (f === undefined) throw new DiffOptionError(`Bad field name = ${o.field}`);
    field = f;
    active = [f];
  }
  // As the command line of gdxdiff is built (tools.ts): FldOnly needs a field, and then DiffOnly is not used.
  const fieldOnly = !!o.fieldOnly && field !== undefined;
  const diffOnly = !!o.diffOnly && !fieldOnly;
  const compareSetText = !o.ignoreSetText;
  const showDefaults = !!o.compareDefaults;
  const compareDomains = !!o.compareDomains;
  const ignoreOrder = !!o.ignoreOrder;
  /** Identifiers separated by commas or blanks, each once (case-insensitive). */
  const idList = (list: string[] | undefined) => {
    const names: string[] = [];
    for (const n of (list ?? []).flatMap((s) => s.split(/[ ,]+/)).filter(Boolean)) {
      if (!names.some((x) => asciiLower(x) === asciiLower(n))) names.push(n);
    }
    return names.length ? names : undefined;
  };
  const ids = idList(o.ids);
  const skipIds = idList(o.skipIds);
  const has = (list: string[], name: string) => list.some((x) => asciiLower(x) === asciiLower(name));
  const included = (name: string) => (!ids || has(ids, name)) && (!skipIds || !has(skipIds, name));

  const out: string[] = ['GDXDIFF          GDX Analyzer (native gdxdiff)', `File1 : ${file1}`, `File2 : ${file2}`];
  if (ids) out.push(`ID    : ${ids.join(' ')}`);
  if (skipIds) out.push(`SkipID: ${skipIds.join(' ')}`);

  const [r1, r2] = await Promise.all([GdxReader.open(file1, RAW_BYTES), GdxReader.open(file2, RAW_BYTES)]);
  const writer = new GdxWriter('GDX Analyzer (native gdxdiff)', 'GDXDIFF');

  // One label table for both files: the labels of the difference file, then those of file 1 and 2.
  const labels: string[] = [];
  const labelNumbers = new Map<string, number>();
  const label = (s: string) => {
    const key = asciiLower(s);
    let n = labelNumbers.get(key);
    if (n === undefined) {
      n = labels.length;
      labels.push(s);
      labelNumbers.set(key, n);
    }
    return n;
  };
  ['ins1', 'ins2', 'dif1', 'dif2', ...(diffOnly ? FIELD_NAMES : [])].forEach(label);
  const staticCount = labels.length;
  const map1 = Int32Array.from([-1, ...r1.uels.map(label)]);
  const map2 = Int32Array.from([-1, ...r2.uels.map(label)]);
  let registered = false;
  /** The labels of the difference file: all of them, or (IgnoreOrder) only its own, the others as written. */
  const registerLabels = () => {
    if (registered) return;
    registered = true;
    for (let n = 0; n < (ignoreOrder ? staticCount : labels.length); n++) diffLabel(n);
  };

  /** The label number in the difference file of a label of the common table (registered when first written). */
  const written = new Int32Array(labels.length);
  const diffLabel = (n: number) => written[n] || (written[n] = writer.uel(labels[n]));

  /** The records of a symbol (its values: as many as its type has), sorted by their keys in the common label table. */
  const recordsOf = async (reader: GdxReader, map: Int32Array, e: SymbolEntry): Promise<Records> => {
    const dim = e.dim;
    let target: SymbolEntry | undefined = e;
    for (let guard = 0; target && target.dataType === 4 && guard < 100; guard++) target = target.userInfo > 0 ? reader.entries[target.userInfo - 1] : undefined;
    const fields = target ? FIELD_COUNT[target.dataType] : 1;
    let capacity = Math.max(16, target ? target.count : reader.uels.length);
    let keys = new Int32Array(capacity * dim);
    let values = new Float64Array(capacity * fields);
    let count = 0;
    await reader.forEachRecord(
      e,
      (k, _, v, sp) => {
        if (count >= capacity) {
          capacity *= 2;
          const kk = new Int32Array(capacity * dim);
          kk.set(keys);
          keys = kk;
          const vv = new Float64Array(capacity * fields);
          vv.set(values);
          values = vv;
        }
        for (let d = 0; d < dim; d++) {
          const n = k[d] >= 1 && k[d] < map.length ? map[k[d]] : -1;
          // Records with labels that are not in the file (strict domains) are left out.
          if (n < 0) return;
          keys[count * dim + d] = n;
        }
        for (let f = 0; f < fields; f++) {
          values[count * fields + f] = sp[f] === Sp.None ? v[f] : sp[f] === Sp.Text ? v[f] * RAW.acronym : (RAW_OF[sp[f] as Sp] ?? 0);
        }
        count++;
      },
      signal,
    );
    // Sorted by the common label numbers (as gdxDataReadMap gives them).
    const compare = (a: number, b: number) => {
      for (let d = 0; d < dim; d++) {
        const c = keys[a * dim + d] - keys[b * dim + d];
        if (c) return c;
      }
      return 0;
    };
    let sorted = true;
    for (let i = 1; i < count && sorted; i++) sorted = compare(i - 1, i) < 0;
    if (!sorted) {
      const order = new Int32Array(count).map((_, i) => i).sort(compare);
      const kk = new Int32Array(count * dim);
      const vv = new Float64Array(count * fields);
      order.forEach((from, to) => {
        kk.set(keys.subarray(from * dim, from * dim + dim), to * dim);
        vv.set(values.subarray(from * fields, from * fields + fields), to * fields);
      });
      keys = kk;
      values = vv;
    }
    return { count, keys, values, fields };
  };

  const statuses = new Map<string, Status>();

  const compareSymbols = async (e1: SymbolEntry, e2: SymbolEntry) => {
    const dim = e1.dim;
    const type = e1.dataType === 4 ? 0 : e1.dataType;
    const varEquType = e1.userInfo;
    // gdxdiff names the difference symbol as file 2 does.
    const id = e2.name;
    const type2 = e2.dataType === 4 ? 0 : e2.dataType;
    let status: Status = 'same';
    let open = false;
    const done = () => {
      if (status !== 'same' && status !== 'dim10') statuses.set(id, status);
    };
    if (dim !== e2.dim || type !== type2) {
      out.push(`*** symbol = ${id} cannot be compared`);
      if (type !== type2) {
        out.push(`Typ1 = ${TYPE_NAMES[type]}, Typ2 = ${TYPE_NAMES[type2]}`);
        status = 'typ';
      }
      if (dim !== e2.dim) {
        out.push(`Dim1 = ${dim}, Dim2 = ${e2.dim}`);
        if (status === 'same') status = 'dim';
      }
      return done();
    }
    if (compareDomains && dim > 0) {
      const d1 = r1.domainOf(e1).domain;
      const d2 = r2.domainOf(e2).domain;
      if (d1.some((d, k) => asciiLower(d) !== asciiLower(d2[k]))) {
        status = 'domain';
        return done();
      }
    }
    const isVarEqu = type === 2 || type === 3;
    // The default records of inserted records (left out unless CmpDefaults). For equations, gdxdiff
    // looks up gmsDefRecEqu with the stored user info (53 + type), beyond the table: inserted equation
    // records are never default records there, so they are always reported.
    const defaults = type === 2 ? (VAR_DEFAULTS[varEquType] ?? VAR_DEFAULTS[0]) : [0, 0, 0, 0, 0];
    if (dim >= MAX_DIM || (diffOnly && dim - 1 >= MAX_DIM)) status = 'dim10';

    const doublesEqual = (v1: number, v2: number): boolean => {
      const s1 = specialOf(v1);
      const s2 = specialOf(v2);
      if (s1 === 0) {
        if (s2 === 0) {
          if (v1 >= RAW.acronym && v2 >= RAW.acronym) {
            return asciiLower(r1.acronymName(Math.round(v1 / RAW.acronym))) === asciiLower(r2.acronymName(Math.round(v2 / RAW.acronym)));
          }
          const diff = Math.abs(v1 - v2);
          if (diff <= epsAbsolute) return true;
          return epsRelative > 0 ? diff / (1 + Math.min(Math.abs(v1), Math.abs(v2))) <= epsRelative : false;
        }
        return s2 === SV_EPS && epsAbsolute > 0 && Math.abs(v1) <= epsAbsolute;
      }
      if (s2 === 0) return s1 === SV_EPS && epsAbsolute > 0 && Math.abs(v2) <= epsAbsolute;
      return s1 === s2;
    };

    // The keys of the records written: the labels, then the field (DiffOnly) and dif1/dif2/ins1/ins2.
    const extra = diffOnly && isVarEqu ? 2 : 1;
    const key = new Int32Array(dim + extra);
    const one = new Float64Array(1);
    const openSymbol = (): boolean => {
      registerLabels();
      if (status === 'dim10') status = 'dim10diff';
      if (!open && status !== 'dim10diff') {
        // Without IgnoreOrder, the labels have their numbers of the common table, and records come in order of them.
        const bounds = ignoreOrder ? undefined : { min: Array<number>(dim + extra).fill(1), max: [...Array<number>(dim).fill(labels.length), ...Array<number>(extra).fill(staticCount)] };
        if (fieldOnly && isVarEqu) writer.startSymbol(id, `Differences Field = ${FIELD_NAMES[field!]}`, dim + 1, 1, 0, bounds);
        else if (diffOnly && isVarEqu) writer.startSymbol(id, 'Differences Only', dim + 2, 1, 0, bounds);
        else writer.startSymbol(id, 'Differences', dim + 1, type, varEquType, bounds);
        open = true;
      }
      return open;
    };
    const ACT = { ins1: 0, ins2: 1, dif1: 2, dif2: 3 };
    /** Writes a record (WriteDiff): `values` of a record, or one value (`f` of it with FldOnly). */
    const write = (act: keyof typeof ACT, fieldLabel: number, keys: Int32Array, at: number, values: ArrayLike<number>) => {
      registerLabels();
      for (let d = 0; d < dim; d++) key[d] = diffLabel(keys[at * dim + d]);
      if (extra === 2) {
        key[dim] = diffLabel(fieldLabel);
        key[dim + 1] = diffLabel(ACT[act]);
      } else {
        key[dim] = diffLabel(ACT[act]);
      }
      if (fieldOnly && isVarEqu) {
        one[0] = values[field!];
        writer.record(key, one);
      } else {
        writer.record(key, values);
      }
    };
    const fieldLabel = (t: number) => 4 + t;
    const setText = (reader: GdxReader, n: number) => (n === 0 ? '' : (reader.setTexts[n] ?? `?Str__${n}`));

    const [a, b] = await Promise.all([recordsOf(r1, map1, e1), recordsOf(r2, map2, e2)]);
    const va = (i: number) => a.values.subarray(i * a.fields, i * a.fields + a.fields);
    const vb = (j: number) => b.values.subarray(j * b.fields, j * b.fields + b.fields);

    /** Changed values of a record in both files (CheckParDifference). */
    const parDifference = (i: number, j: number): boolean => {
      const v1 = va(i);
      const v2 = vb(j);
      let equal = true;
      if (type === 1) equal = doublesEqual(v1[0], v2[0]);
      else if (fieldOnly) equal = doublesEqual(v1[field!], v2[field!]);
      else for (let k = 0; k < active.length && equal; k++) equal = doublesEqual(v1[active[k]], v2[active[k]]);
      if (!equal) {
        if (!openSymbol()) return false;
        if (!diffOnly || !isVarEqu) {
          write('dif1', 0, a.keys, i, v1);
          write('dif2', 0, a.keys, i, v2);
        } else {
          for (const t of active) {
            if (doublesEqual(v1[t], v2[t])) continue;
            one[0] = v1[t];
            write('dif1', fieldLabel(t), a.keys, i, one);
            one[0] = v2[t];
            write('dif2', fieldLabel(t), a.keys, i, one);
          }
        }
      }
      return equal;
    };

    /** Changed element texts of a set record (CheckSetDifference). */
    const setDifference = (i: number, j: number): boolean => {
      const s1 = setText(r1, Math.round(a.values[i]));
      const s2 = setText(r2, Math.round(b.values[j]));
      if (s1 === s2) return true;
      if (!openSymbol()) return false;
      one[0] = writer.setText(s1);
      write('dif1', 0, a.keys, i, one);
      one[0] = writer.setText(s2);
      write('dif2', 0, a.keys, i, one);
      return false;
    };

    /** A record of one file only (ShowInsert); records with default values are left out unless CmpDefaults. */
    const insert = (act: 'ins1' | 'ins2', r: Records, i: number) => {
      let values: ArrayLike<number> = r.values.subarray(i * r.fields, i * r.fields + r.fields);
      let isDefault = false;
      if (type === 1) isDefault = doublesEqual(values[0], 0);
      else if (type === 2) isDefault = active.every((t) => doublesEqual(values[t], defaults[t]));
      if (isDefault && !showDefaults) return;
      if (status === 'same') status = 'key';
      if (status === 'dim10') status = 'dim10diff';
      if (status === 'dim10diff' || !openSymbol()) return;
      if (type === 0 && values[0] !== 0) {
        one[0] = writer.setText(setText(act === 'ins1' ? r1 : r2, Math.round(values[0])));
        values = one;
      }
      if (!diffOnly || !isVarEqu) {
        write(act, 0, r.keys, i, values);
      } else {
        const v = Float64Array.from(values);
        for (const t of active) {
          one[0] = v[t];
          write(act, fieldLabel(t), r.keys, i, one);
        }
      }
    };

    let i = 0;
    let j = 0;
    while (i < a.count && j < b.count) {
      let c = 0;
      for (let d = 0; d < dim && c === 0; d++) c = a.keys[i * dim + d] - b.keys[j * dim + d];
      if (c === 0) {
        const equal = type === 0 ? (compareSetText ? setDifference(i, j) : true) : parDifference(i, j);
        if (!equal && status === 'same') status = 'data';
        i++;
        j++;
      } else if (c < 0) {
        insert('ins1', a, i++);
      } else {
        insert('ins2', b, j++);
      }
    }
    while (i < a.count) insert('ins1', a, i++);
    while (j < b.count) insert('ins2', b, j++);
    if (open) writer.endSymbol();
    done();
  };

  // The symbols of file 1 (by name), then those only in file 2.
  const byName = (x: SymbolEntry, y: SymbolEntry) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  const find = (reader: GdxReader, name: string) => reader.entries.find((x) => asciiLower(x.name) === asciiLower(name));
  for (const e1 of r1.entries.filter((e) => included(e.name)).sort(byName)) {
    const e2 = find(r2, e1.name);
    if (e2) await compareSymbols(e1, e2);
    else statuses.set(e1.name, 'notf2');
  }
  for (const e2 of r2.entries.filter((e) => included(e.name)).sort(byName)) {
    if (!find(r1, e2.name)) statuses.set(e2.name, 'notf1');
  }

  if (!statuses.size) {
    out.push('No differences found');
  } else {
    out.push('Summary of differences:');
    const names = [...statuses.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const width = Math.max(1, ...names.map((n) => n.length));
    for (const n of names) out.push(`${n.padStart(width)}   ${STATUS_TEXT[statuses.get(n) as keyof typeof STATUS_TEXT]}`);
  }

  // The two files compared, as the element texts of a set.
  let id = 'FilesCompared';
  for (let n = 1; writer.hasSymbol(id); n++) id = `FilesCompared95${n}`;
  writer.startSymbol(id, '', 1, 0, 0);
  const asText = (file: string) => Buffer.from(file, 'utf8').toString('latin1');
  writer.record([writer.uel('File1')], [writer.setText(asText(file1))]);
  writer.record([writer.uel('File2')], [writer.setText(asText(file2))]);
  writer.endSymbol();
  await writer.write(diffFile);

  out.push(`Output: ${diffFile}`, 'GDXDiff finished');
  return { exitCode: statuses.size ? 1 : 0, stdout: out.join('\n') + '\n' };
}
