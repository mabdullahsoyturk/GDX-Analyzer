/**
 * Copies symbols of a GDX file into a new GDX file, all of their records or some of them (e.g. those
 * passing the filters of the viewer), like gdxcopy or a GAMS unload of some symbols: with their types,
 * subtypes, texts, comments, domains, set element texts and acronyms, and the labels in the order of
 * the source file. The file is read byte for byte (RAW_BYTES), so labels and texts in any encoding
 * are copied unchanged.
 *
 * No dependency on `vscode`.
 */
import { Sp } from './columns';
import { GdxReader, RAW_BYTES, SymbolEntry } from './gdxReader';
import { GdxWriter, RAW } from './gdxWriter';

export interface SubsetItem {
  /** The symbol (as gdxFindSymbol: case-insensitive). */
  name: string;
  /** The records to copy, as their positions in the symbol (ascending); all records if absent. */
  rows?: ArrayLike<number>;
  /** With `rows`: the number of records the positions are of, checked against the file (which may have changed). */
  recordCount?: number;
}

export interface SubsetResult {
  /** The symbols written, in their order in the new file. */
  symbols: string[];
  /** Sets written because an alias of them was chosen. */
  addedSets: string[];
  /** Symbols whose regular domain was written as relaxed domain (names only), and why. */
  relaxed: { name: string; reason: string }[];
  records: number;
}

const FIELD_COUNT = [1, 1, 5, 5, 0];
const RAW_OF: Partial<Record<Sp, number>> = { [Sp.Undf]: RAW.undf, [Sp.NA]: RAW.na, [Sp.PInf]: RAW.pinf, [Sp.MInf]: RAW.minf, [Sp.Eps]: RAW.eps };

/** The records of a symbol kept in memory: keys as UEL numbers of the source, values as doubles of GAMS. */
interface Kept {
  entry: SymbolEntry;
  count: number;
  keys: Int32Array;
  values: Float64Array;
}

export async function writeGdxSubset(source: string, target: string, items: SubsetItem[], signal?: AbortSignal): Promise<SubsetResult> {
  const reader = await GdxReader.open(source, RAW_BYTES);
  const chosen = new Map<number, SubsetItem>();
  for (const item of items) {
    chosen.set(reader.entry(item.name).entry, item);
  }
  // An alias needs its set (GAMS has no alias without it).
  const addedSets: string[] = [];
  for (const nr of [...chosen.keys()]) {
    const e = reader.entries[nr - 1];
    if (e.dataType === 4 && e.userInfo > 0 && !chosen.has(e.userInfo)) {
      const set = reader.entries[e.userInfo - 1];
      if (set) {
        chosen.set(set.entry, { name: set.name });
        addedSets.push(set.name);
      }
    }
  }
  // In the order of the source file; the number of each symbol in the new file.
  const order = [...chosen.keys()].sort((a, b) => a - b).map((nr) => reader.entries[nr - 1]);
  const newNumber = new Map(order.map((e, k) => [e.entry, k + 1]));

  // The records to copy, and the labels and acronyms they use.
  const usedUels = new Uint8Array(reader.uels.length + 1);
  const usedAcronyms = new Set<number>();
  const kept = new Map<number, Kept>();
  for (const e of order) {
    if (e.dataType === 4) continue;
    const item = chosen.get(e.entry)!;
    const fields = FIELD_COUNT[e.dataType];
    const dim = e.dim;
    const rows = item.rows;
    let capacity = Math.max(16, rows ? rows.length : e.count);
    let keys = new Int32Array(capacity * dim);
    let values = new Float64Array(capacity * fields);
    let count = 0;
    let position = 0;
    let next = 0;
    // A scalar without a stored record has its default value: none is written either.
    const stored = dim > 0 || e.count > 0;
    if (stored) {
      await reader.forEachRecord(
        e,
        (k, _, v, sp) => {
          const at = position++;
          if (rows) {
            while (next < rows.length && rows[next] < at) next++;
            if (next >= rows.length || rows[next] !== at) return;
          }
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
            keys[count * dim + d] = k[d];
            if (k[d] >= 1 && k[d] < usedUels.length) usedUels[k[d]] = 1;
          }
          for (let f = 0; f < fields; f++) {
            if (sp[f] === Sp.Text) usedAcronyms.add(v[f]);
            values[count * fields + f] = sp[f] === Sp.None ? v[f] : sp[f] === Sp.Text ? v[f] * RAW.acronym : (RAW_OF[sp[f] as Sp] ?? 0);
          }
          count++;
        },
        signal,
      );
    }
    if (rows && item.recordCount !== undefined && position !== item.recordCount) {
      throw new Error(`${e.name} has ${position} records in the file instead of ${item.recordCount}: the file changed. Refresh the viewer and try again.`);
    }
    kept.set(e.entry, { entry: e, count, keys, values });
  }

  const writer = new GdxWriter('GDX Analyzer', 'GDX Analyzer');
  // The labels in the order of the source file, so that records stay in order and views show them as in the source.
  const uelOf = new Int32Array(reader.uels.length + 1);
  for (let k = 1; k < usedUels.length; k++) {
    if (usedUels[k]) uelOf[k] = writer.uel(reader.uels[k - 1]);
  }
  const uel = (k: number) => uelOf[k] || (uelOf[k] = writer.uel(reader.uels[k - 1] ?? `L__${k}`));
  for (const index of usedAcronyms) {
    const a = reader.acronyms.find((x) => x.index === index);
    if (a) writer.acronym(index, a.name, a.text);
  }

  /** The set whose records a domain symbol has (an alias: its set); undefined for the universe. */
  const setOf = (nr: number): SymbolEntry | undefined => {
    let e: SymbolEntry | undefined = reader.entries[nr - 1];
    for (let guard = 0; e && e.dataType === 4 && guard < 100; guard++) e = e.userInfo > 0 ? reader.entries[e.userInfo - 1] : undefined;
    return e;
  };
  const relaxed: SubsetResult['relaxed'] = [];

  /** The regular domain of a symbol in the new file, or why it is written as relaxed domain. */
  const regularDomain = (e: SymbolEntry, k: Kept | undefined): number[] | string => {
    const domain = e.domainSymbols!;
    const missing = domain.filter((d) => d > 0 && !newNumber.has(d)).map((d) => reader.entries[d - 1]?.name ?? String(d));
    if (missing.length) return `${[...new Set(missing)].join(', ')} not written`;
    // The GDX library writes only records within regular domains: records left out of a domain set make them relaxed.
    if (k) {
      for (let d = 0; d < e.dim; d++) {
        const set = domain[d] > 0 ? setOf(domain[d]) : undefined;
        // Not checked: the universe, and a set that is its own domain (set i(i)).
        if (!set || set.entry === e.entry || set.dim !== 1) continue;
        const members = kept.get(set.entry);
        if (!members) continue;
        const inSet = new Uint8Array(reader.uels.length + 1);
        for (let r = 0; r < members.count; r++) inSet[members.keys[r]] = 1;
        let outside = 0;
        for (let r = 0; r < k.count; r++) if (!inSet[k.keys[r * e.dim + d]]) outside++;
        if (outside) return `${outside} record${outside === 1 ? '' : 's'} outside the records of ${set.name} written`;
      }
    }
    return domain.map((d) => (d > 0 ? newNumber.get(d)! : 0));
  };

  let records = 0;
  for (const e of order) {
    if (e.dataType === 4) {
      writer.addAlias(e.name, e.userInfo > 0 ? (newNumber.get(e.userInfo) ?? 0) : 0, e.dim, e.text);
      continue;
    }
    const k = kept.get(e.entry)!;
    const extras: { domainSymbols?: number[]; domainNames?: string[]; comments: string[] } = { comments: e.comments };
    if (e.dim > 0 && e.domainSymbols && !e.domainStrings) {
      const regular = regularDomain(e, k);
      if (typeof regular === 'string') {
        relaxed.push({ name: e.name, reason: regular });
        extras.domainNames = reader.domainOf(e).domain;
      } else {
        extras.domainSymbols = regular;
      }
    } else if (e.dim > 0 && e.domainStrings) {
      extras.domainNames = reader.domainOf(e).domain;
    }
    writer.startSymbol(e.name, e.text, e.dim, e.dataType, e.userInfo, undefined, extras);
    const fields = FIELD_COUNT[e.dataType];
    const key = new Int32Array(e.dim);
    const value = new Float64Array(fields);
    for (let r = 0; r < k.count; r++) {
      for (let d = 0; d < e.dim; d++) key[d] = uel(k.keys[r * e.dim + d]);
      for (let f = 0; f < fields; f++) value[f] = k.values[r * fields + f];
      // Set element texts: their number in the new file.
      if (e.dataType === 0 && value[0] !== 0) value[0] = writer.setText(reader.setTexts[Math.round(value[0])] ?? '');
      writer.record(key, value);
    }
    writer.endSymbol();
    records += k.count;
  }
  await writer.write(target);
  return { symbols: order.map((e) => e.name), addedSets, relaxed, records };
}
