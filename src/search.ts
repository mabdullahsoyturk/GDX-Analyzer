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
