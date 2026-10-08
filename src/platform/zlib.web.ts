/**
 * The functions of Node.js's zlib that the extension uses (gdxReader.ts, xlsx.ts, xlsxRead.ts), for the
 * web extension (in place of `zlib`, see scripts/build-web.mjs): with fflate, which is written in JavaScript.
 */
import { deflateSync, inflateSync as inflateRaw, unzlibSync } from 'fflate';

/** A Buffer on the memory of the result (not a copy). */
const buffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** Decompresses zlib data (a zlib header, deflate data and an Adler-32 checksum), e.g. the blocks of compressed GDX files. */
export function inflateSync(data: Uint8Array): Buffer {
  return buffer(unzlibSync(data));
}

/** Compresses to raw deflate data (without header), as the entries of zip files hold it. */
export function deflateRawSync(data: Uint8Array): Buffer {
  return buffer(deflateSync(data));
}

/** Decompresses raw deflate data (without header). */
export function inflateRawSync(data: Uint8Array): Buffer {
  return buffer(inflateRaw(data));
}
