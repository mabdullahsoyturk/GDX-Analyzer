/**
 * Text encodings of labels and texts in GDX files (setting gdxAnalyzer.encoding).
 *
 * No dependency on `vscode` or Node.js: also part of the web extension.
 */

/**
 * A decoder for the text encoding `label` (e.g. "utf-8", "windows-1252", "latin1");
 * throws a RangeError for unknown encodings.
 */
export function textDecoder(label = 'utf-8'): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder(label.trim() || 'utf-8');
  } catch {
    throw new RangeError(`Unknown text encoding "${label}" (setting gdxAnalyzer.encoding).`);
  }
}
