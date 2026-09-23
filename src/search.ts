/**
 * Text search like GAMS Studio's filter fields: case-insensitive; `*` (any characters)
 * and `?` (one character) are wildcards unless `regex` is set; with `exact`, the whole
 * cell must match instead of a part of it.
 *
 * media/table.js contains the same rules for the symbol list.
 */

export interface TextSearch {
  text: string;
  exact?: boolean;
  regex?: boolean;
}

/** The regular expression for a search; undefined for an empty search, an error message for an invalid one. */
export function compileSearch(s: TextSearch | string | undefined): RegExp | undefined | { error: string } {
  const search = typeof s === 'string' ? { text: s } : s;
  const text = search?.text ?? '';
  if (text.trim() === '') {
    return undefined;
  }
  let source: string;
  if (search?.regex) {
    source = text;
  } else {
    source = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  }
  if (search?.exact) {
    source = `^(?:${source})$`;
  }
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    return { error: err instanceof Error ? err.message.replace(/^Invalid regular expression: /, '') : String(err) };
  }
}

export function isSearchError(r: ReturnType<typeof compileSearch>): r is { error: string } {
  return !!r && !(r instanceof RegExp);
}

/** Special values as displayed in value cells. */
const SPECIAL_TEXTS = ['Eps', 'NA', '+Inf', '-Inf', 'Undf'];

/**
 * False if the search cannot match any number or special value as displayed, so that
 * value columns need not be formatted and tested (e.g. a search for a label). Regular
 * expressions are always tested.
 */
export function canMatchNumbers(search: TextSearch | string | undefined): boolean {
  const s = typeof search === 'string' ? { text: search } : search;
  if (!s || s.regex) {
    return true;
  }
  const rx = compileSearch(s);
  if (!(rx instanceof RegExp) || SPECIAL_TEXTS.some((v) => rx.test(v))) {
    return true;
  }
  // Every character but the wildcards must occur in a match; numbers consist of these.
  return /^[0-9.+\-eE]*$/.test(s.text.replace(/[*?]/g, ''));
}
