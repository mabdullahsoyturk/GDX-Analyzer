/**
 * A minimal .xlsx (Office Open XML spreadsheet) reader without dependencies: the names of the
 * sheets and the cells of a sheet as text (numbers as Excel stores them, shared and inline
 * strings, formula results, booleans as 1/0). Formats, styles and dates are not interpreted.
 */
import { inflateRawSync } from 'zlib';

/** The entries of a zip file by name (stored or deflated; no ZIP64). */
function unzip(buf: Buffer): Map<string, () => Buffer> {
  // The end of central directory record: its signature, searched from the end (it may have a comment).
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not an Excel workbook (.xlsx): no zip directory found.');
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('The workbook is damaged (zip directory).');
    const method = buf.readUInt16LE(pos + 10);
    const size = buf.readUInt32LE(pos + 20);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
    entries.set(name, () => {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`The workbook is damaged (${name}).`);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`The workbook uses an unsupported compression (${method}).`);
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decodes the entities of XML text and the _xHHHH_ escapes of Office Open XML. */
function text(s: string): string {
  return s
    .replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e: string) =>
      e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
    )
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The value of an attribute in the attributes of a tag. */
function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? text(m[1]) : undefined;
}

/** The text of the <t> elements of a string item (rich text runs concatenated, phonetic hints left out). */
function stringItem(xml: string): string {
  const plain = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of plain.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) s += text(m[1] ?? '');
  return s;
}

/** Column index (from 0) of a cell reference such as "AB12". */
function columnOf(ref: string): number {
  let c = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    c = c * 26 + code - 64;
  }
  return c - 1;
}

export interface Workbook {
  sheets: string[];
  /** The cells of a sheet as rows of text ('' for empty cells), without trailing empty rows. */
  rows(sheet: string): string[][];
}

export function readXlsx(buf: Buffer): Workbook {
  const files = unzip(buf);
  const file = (name: string) => files.get(name)?.().toString('utf8');
  const workbook = file('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook (.xlsx): no xl/workbook.xml.');
  // Sheet names and their parts, through the relationships of the workbook.
  const targets = new Map<string, string>();
  for (const m of (file('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const parts = new Map<string, string>();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name');
    const id = attr(m[1], 'r:id');
    const part = id && targets.get(id);
    if (name && part) parts.set(name, part);
  }
  let shared: string[] | undefined;
  const sharedStrings = () => (shared ??= [...(file('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => stringItem(m[1] ?? '')));
  return {
    sheets: [...parts.keys()],
    rows(sheet: string): string[][] {
      const xml = file(parts.get(sheet) ?? '');
      if (xml === undefined) throw new Error(`The workbook has no sheet ${sheet}.`);
      const rows: string[][] = [];
      let r = 0;
      for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const nr = attr(rowMatch[1], 'r');
        r = nr ? Number(nr) - 1 : r;
        const row: string[] = [];
        let c = 0;
        for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attr(cell[1], 'r');
          c = ref ? columnOf(ref) : c;
          const type = attr(cell[1], 't');
          const body = cell[2] ?? '';
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
          let value = '';
          if (type === 'inlineStr') value = stringItem(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
          else if (type === 's') value = v ? (sharedStrings()[Number(v[1])] ?? '') : '';
          else if (v) value = text(v[1]);
          while (row.length < c) row.push('');
          row[c] = value;
          c++;
        }
        while (rows.length < r) rows.push([]);
        rows[r] = row;
        r++;
      }
      while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
      return rows;
    },
  };
}
