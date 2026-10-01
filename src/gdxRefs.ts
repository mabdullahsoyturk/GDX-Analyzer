/**
 * Finds references to GDX files (and to symbols in them) in GAMS and Python source, for
 * the document links of links.ts:
 * - GAMS: the file names of $gdxIn, $gdxOut, $gdxLoad, $gdxLoadAll, $gdxUnload and of
 *   execute_load/execute_unload and their variants (".gdx" may be left out), and the symbols
 *   they read or write ($load, $unLoad and the symbol lists of these statements);
 * - GAMS: other names ending in ".gdx", quoted or not (e.g. `$call gams trnsport gdx=out.gdx`
 *   or `put_utility 'gdxOut' / 'out.gdx'`), also within strings such as shell commands;
 * - Python: string literals ending in ".gdx" (e.g. Container("out.gdx")), and the symbols of GAMSPy and
 *   GAMS Transfer: those read or written by read(), write() and loadRecordsFromGdx() (symbol_names=,
 *   symbols= or a list after the file), and m["x"] of a container read from a file; also the Python names
 *   bound to symbols (limit = Equation(m, name="supply"), x = m["x"], a = c.addParameter("a")).
 * Names with compile-time variables (%...%), Python f-string fields ({...}) or wildcards are skipped.
 *
 * No dependency on `vscode`.
 */

export interface FileReference {
  /** Offsets of the file name in the text (without quotes). */
  start: number;
  end: number;
  /** The file name as GAMS reads it: with ".gdx" added if it has no extension. */
  file: string;
}

export interface SymbolReference {
  /** Offsets of the symbol name in the text. */
  start: number;
  end: number;
  /** The name of the symbol in the GDX file. */
  name: string;
  /** The file the symbol is read from or written to. */
  file: string;
}

/** A Python name bound to a GDX symbol of another name, e.g. `limit = Equation(m, name="supply")`. */
export interface NameBinding {
  /** Offsets of the Python name where it is assigned. */
  start: number;
  end: number;
  name: string;
  /** The name of the symbol. */
  symbol: string;
}

export interface GdxReferences {
  files: FileReference[];
  symbols: SymbolReference[];
  /** Python only. */
  names?: NameBinding[];
}

/** GAMS adds ".gdx" to GDX file names without an extension. */
function withExtension(name: string): string {
  const base = name.replace(/^.*[\\/]/, '');
  return base.includes('.') ? name : `${name}.gdx`;
}

const usable = (name: string) => name !== '' && !/[%{*?]/.test(name);

/** The quoted or unquoted name at `pos` (after whitespace): its text and offsets, and where it ends. */
function nameAt(text: string, pos: number, stop: RegExp): { name: string; start: number; end: number; next: number } | undefined {
  let i = pos;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  const q = text[i];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, i + 1);
    const eol = text.indexOf('\n', i + 1);
    if (close < 0 || (eol >= 0 && eol < close)) return undefined;
    return { name: text.slice(i + 1, close), start: i + 1, end: close, next: close + 1 };
  }
  let j = i;
  while (j < text.length && !stop.test(text[j])) j++;
  return j > i ? { name: text.slice(i, j), start: i, end: j, next: j } : undefined;
}

const SYMBOL = /[A-Za-z_][A-Za-z0-9_]*|\*/y;

/**
 * The GDX symbol names of a symbol list such as `a b=c, i<adata.dim2, j<=d`: the name
 * itself, or the name after `=`, `<` or `<=` (the symbol in the GDX file).
 */
function symbolList(text: string, from: number, to: number, file: string, out: SymbolReference[]) {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === ',' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    SYMBOL.lastIndex = i;
    const m = SYMBOL.exec(text);
    if (!m || m.index >= to) {
      i++;
      continue;
    }
    let start = m.index;
    let end = start + m[0].length;
    // A rename or projection: the GDX symbol follows.
    const rest = /^\s*(<=|<|=)\s*/.exec(text.slice(end, to));
    if (rest) {
      SYMBOL.lastIndex = end + rest[0].length;
      const g = SYMBOL.exec(text);
      if (g && g.index === end + rest[0].length && g.index < to) {
        start = g.index;
        end = start + g[0].length;
      }
    }
    out.push({ start, end, name: text.slice(start, end), file });
    i = end;
    // Skip a projected dimension such as ".dim2".
    while (i < to && /[.\w]/.test(text[i])) i++;
  }
}

/** Offsets of the lines of a text that are GAMS code (not `*` comment lines or $onText/$offText blocks). */
function codeLines(text: string): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let inText = false;
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    if (inText) {
      if (/^\$offText\b/i.test(line)) inText = false;
    } else if (/^\$onText\b/i.test(line)) {
      inText = true;
    } else if (!line.startsWith('*')) {
      lines.push({ start: pos, end: line.endsWith('\r') ? end - 1 : end });
    }
    pos = end + 1;
  }
  return lines;
}

const DOLLAR_FILE = /^\s*\$(gdxIn|gdxOut|gdxLoadAll|gdxLoad|gdxUnload)(?=[\s'"]|$)/i;
const DOLLAR_SYMBOLS = /^\s*\$(loadDCM|loadDCR|loadDC|loadFiltered|loadM|loadR|load|unLoad)(?=\s|$)/i;
const EXECUTE = /\bexecute_(loadpoint|loaddc|load|unloaddi|unloadidx|unload)(?=[\s'"])/gi;
/** Unquoted file names (of dollar control options) end at whitespace. */
const NAME_STOP = /\s/;

/** GDX references in GAMS source. */
export function gamsReferences(text: string): GdxReferences {
  const files: FileReference[] = [];
  const symbols: SymbolReference[] = [];
  let gdxIn: string | undefined;
  let gdxOut: string | undefined;
  const lines = codeLines(text);
  const code = new Uint8Array(text.length + 1);
  for (const l of lines) code.fill(1, l.start, l.end);

  for (const { start, end } of lines) {
    const line = text.slice(start, end);
    let m = DOLLAR_FILE.exec(line);
    if (m) {
      const kind = m[1].toLowerCase();
      const ref = nameAt(text, start + m[0].length, NAME_STOP);
      const named = ref && ref.end <= end && usable(ref.name) ? withExtension(ref.name) : undefined;
      if (ref && named) files.push({ start: ref.start, end: ref.end, file: named });
      if (kind === 'gdxin') gdxIn = named;
      else if (kind === 'gdxout') gdxOut = named;
      else if (named && ref && kind !== 'gdxloadall') symbolList(text, ref.next, end, named, symbols);
      continue;
    }
    m = DOLLAR_SYMBOLS.exec(line);
    if (m) {
      const file = m[1].toLowerCase() === 'unload' ? gdxOut : gdxIn;
      if (file) symbolList(text, start + m[0].length, end, file, symbols);
    }
  }

  // execute_load 'file', a, b=c; (statements may span lines). The file name is quoted: without
  // one, the symbols are read from the file opened with put_utility 'gdxIn' (not followed).
  EXECUTE.lastIndex = 0;
  for (let m = EXECUTE.exec(text); m; m = EXECUTE.exec(text)) {
    if (!code[m.index]) continue;
    const ref = nameAt(text, m.index + m[0].length, NAME_STOP);
    if (!ref || !usable(ref.name) || !/['"]/.test(text[ref.start - 1])) continue;
    const file = withExtension(ref.name);
    files.push({ start: ref.start, end: ref.end, file });
    let stmtEnd = text.indexOf(';', ref.next);
    if (stmtEnd < 0) stmtEnd = text.length;
    // Symbols in the code lines of the statement (from the line of the file name: lines are in order).
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].end <= ref.next) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < lines.length && lines[k].start < stmtEnd; k++) {
      const from = Math.max(lines[k].start, ref.next);
      const to = Math.min(lines[k].end, stmtEnd);
      if (from < to) symbolList(text, from, to, file, symbols);
    }
    EXECUTE.lastIndex = stmtEnd;
  }

  // Any other name ending in .gdx (e.g. $call gams model gdx=out.gdx).
  const taken = (s: number, e: number) => files.some((f) => s < f.end && e > f.start);
  for (const r of gdxNames(text)) {
    if (!taken(r.start, r.end)) files.push(r);
  }
  files.sort((a, b) => a.start - b.start);
  return { files, symbols };
}

/** Quoted strings ending in .gdx. */
function quotedGdx(text: string): FileReference[] {
  const out: FileReference[] = [];
  const rx = /(['"])([^'"\r\n]*?\.gdx)\1/gi;
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    if (usable(m[2])) out.push({ start: m.index + 1, end: m.index + 1 + m[2].length, file: m[2] });
  }
  return out;
}

/** Names ending in .gdx delimited by whitespace, quotes or punctuation (e.g. the value of gdx= on a command line). */
function gdxNames(text: string): FileReference[] {
  const out: FileReference[] = [];
  const rx = /(?<=^|[\s=(,'"])([^\s'"=(),;]+\.gdx)(?=$|[\s,;)'"])/gim;
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    if (usable(m[1])) out.push({ start: m.index, end: m.index + m[1].length, file: m[1] });
  }
  return out;
}

/** The offset of the parenthesis or bracket closing the one at `open` (skipping strings), or the end of the text. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      const eol = text.indexOf('\n', i + 1);
      if (end < 0 || (eol >= 0 && eol < end)) return text.length;
      i = end;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      if (--depth === 0) return i;
    }
  }
  return text.length;
}

/** The arguments of a call (or the items of a list) between `open` and its closing bracket, as offsets of their trimmed text. */
function args(text: string, open: number): { start: number; end: number }[] {
  const close = closing(text, open);
  const out: { start: number; end: number }[] = [];
  let from = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      i = end < 0 || end > close ? close - 1 : end;
    } else if (c === '(' || c === '[' || c === '{') {
      i = c === '{' ? Math.max(i, text.indexOf('}', i)) : closing(text, i);
    } else if (c === ',' || i === close) {
      let a = from;
      let b = i;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b });
      from = i + 1;
    }
  }
  return out;
}

/** The string literal at `start` (an argument): its content and offsets; undefined if it is not one. */
function stringAt(text: string, start: number, end: number): { value: string; start: number; end: number } | undefined {
  const m = /^[rRbBuU]?(["'])([^"'\r\n]*)\1$/.exec(text.slice(start, end));
  return m ? { value: m[2], start: end - 1 - m[2].length, end: end - 1 } : undefined;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** GAMSPy and GAMS Transfer methods that read or write a GDX file given first, with the symbols after it. */
const FILE_METHODS = /\.(read|write|loadRecordsFromGdx)\s*\(/g;
// Assignments at the start of a line (not keyword arguments, not tuples).
const CONTAINER = /^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_][\w.]*\.)?Container\s*\(/gm;
const SYMBOL_CLASSES = /^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_][\w.]*\.)?(Set|Alias|Parameter|Variable|Equation|UniverseAlias)\s*\(/gm;
const ADD_METHODS = /^[ \t]*([A-Za-z_]\w*)\s*=\s*[A-Za-z_][\w.]*\.add(Set|Alias|Parameter|Variable|Equation|UniverseAlias)\s*\(/gm;
const INDEX = /\b([A-Za-z_]\w*)\s*\[\s*/g;

/** GDX references in Python source (e.g. GAMSPy or GAMS Transfer). */
export function pythonReferences(text: string): GdxReferences {
  const files = quotedGdx(text);
  const symbols: SymbolReference[] = [];
  const names: NameBinding[] = [];
  const fileAt = (a: { start: number; end: number } | undefined) => {
    const lit = a && stringAt(text, a.start, a.end);
    return lit && files.find((f) => f.start === lit.start) ? lit.value : undefined;
  };
  /** The symbol names of a list, tuple or string argument. */
  const symbolNames = (a: { start: number; end: number }, file: string) => {
    const single = stringAt(text, a.start, a.end);
    const items = single ? [a] : /[[(]/.test(text[a.start]) ? args(text, a.start) : [];
    for (const item of items) {
      const lit = stringAt(text, item.start, item.end);
      if (lit && IDENTIFIER.test(lit.value)) symbols.push({ start: lit.start, end: lit.end, name: lit.value, file });
    }
  };
  /** The value of the keyword argument `name` among the arguments of a call, as offsets. */
  const keyword = (list: { start: number; end: number }[], name: string) => {
    const a = list.find((x) => new RegExp(`^${name}\\s*=(?!=)`).test(text.slice(x.start, x.end)));
    if (!a) return undefined;
    let v = text.indexOf('=', a.start) + 1;
    while (v < a.end && /\s/.test(text[v])) v++;
    return { start: v, end: a.end };
  };
  const positional = (a: { start: number; end: number } | undefined) => (a && !/^\w+\s*=(?!=)/.test(text.slice(a.start, a.end)) ? a : undefined);
  /** Which file a container was last read from, by offset: m = Container("in.gdx"), m.read("in.gdx"). */
  const reads: { at: number; container: string; file: string }[] = [];

  for (const m of text.matchAll(CONTAINER)) {
    const list = args(text, m.index + m[0].length - 1);
    const file = fileAt(keyword(list, 'load_from') ?? positional(list[0]));
    if (file) reads.push({ at: m.index, container: m[1], file });
  }
  for (const m of text.matchAll(FILE_METHODS)) {
    const list = args(text, m.index + m[0].length - 1);
    const file = fileAt(keyword(list, '(?:load_from|write_to)') ?? positional(list[0]));
    if (!file) continue;
    const owner = /([A-Za-z_]\w*)$/.exec(text.slice(0, m.index));
    if (m[1] !== 'write' && owner) reads.push({ at: m.index, container: owner[1], file });
    const named = keyword(list, '(?:symbol_names|symbols)') ?? positional(list[1]);
    if (named) symbolNames(named, file);
  }
  reads.sort((a, b) => a.at - b.at);

  // m["x"]: a symbol of the file the container was last read from; x = m["x"] binds x.
  for (const m of text.matchAll(INDEX)) {
    const close = closing(text, m.index + m[0].lastIndexOf('['));
    const lit = stringAt(text, m.index + m[0].length, close);
    if (!lit || !IDENTIFIER.test(lit.value)) continue;
    const read = reads.filter((r) => r.container === m[1] && r.at < m.index).pop();
    if (read) symbols.push({ start: lit.start, end: lit.end, name: lit.value, file: read.file });
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const assigned = /^[ \t]*([A-Za-z_]\w*)\s*=\s*$/.exec(text.slice(lineStart, m.index));
    if (assigned && assigned[1] !== lit.value) {
      const start = lineStart + assigned[0].indexOf(assigned[1]);
      names.push({ start, end: start + assigned[1].length, name: assigned[1], symbol: lit.value });
    }
  }
  // limit = Equation(m, name="supply") or Equation(m, "supply"); a = c.addParameter("a").
  const bind = (m: RegExpMatchArray, nameArg: (list: { start: number; end: number }[]) => { start: number; end: number } | undefined) => {
    const list = args(text, m.index! + m[0].length - 1);
    const arg = keyword(list, 'name') ?? positional(nameArg(list));
    const lit = arg && stringAt(text, arg.start, arg.end);
    if (lit && IDENTIFIER.test(lit.value) && lit.value !== m[1]) {
      const start = m.index! + m[0].indexOf(m[1]);
      names.push({ start, end: start + m[1].length, name: m[1], symbol: lit.value });
    }
  };
  for (const m of text.matchAll(SYMBOL_CLASSES)) bind(m, (list) => list[1]);
  for (const m of text.matchAll(ADD_METHODS)) bind(m, (list) => list[0]);

  symbols.sort((a, b) => a.start - b.start);
  names.sort((a, b) => a.start - b.start);
  return { files, symbols, names };
}
