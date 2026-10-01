/**
 * Finds references to GDX files (and to symbols in them) in GAMS and Python source, for
 * the document links of links.ts:
 * - GAMS: the file names of $gdxIn, $gdxOut, $gdxLoad, $gdxLoadAll, $gdxUnload and of
 *   execute_load/execute_unload and their variants (".gdx" may be left out), and the symbols
 *   they read or write ($load, $unLoad and the symbol lists of these statements);
 * - GAMS: other names ending in ".gdx", quoted or not (e.g. `$call gams trnsport gdx=out.gdx`
 *   or `put_utility 'gdxOut' / 'out.gdx'`), also within strings such as shell commands;
 * - Python: string literals ending in ".gdx" (e.g. Container("out.gdx")).
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

export interface GdxReferences {
  files: FileReference[];
  symbols: SymbolReference[];
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
    // Symbols in the code lines up to the end of the statement.
    for (const l of lines) {
      const from = Math.max(l.start, ref.next);
      const to = Math.min(l.end, stmtEnd);
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

/** GDX references in Python source (e.g. GAMSPy or GAMS Transfer): string literals ending in .gdx. */
export function pythonReferences(text: string): GdxReferences {
  return { files: quotedGdx(text), symbols: [] };
}
