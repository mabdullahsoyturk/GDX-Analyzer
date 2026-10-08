/**
 * The web extension cannot run gdxdump and gdxdiff (in place of tools.ts, see scripts/build-web.mjs):
 * GDX files are read and compared natively there, and finding the tools fails with a message that says so.
 * Only what the modules of the web extension use at run time is here; their types come from tools.ts.
 */
export { textDecoder } from './encoding';

const NOT_AVAILABLE = 'gdxdump and gdxdiff cannot be used in VS Code for the Web: GDX files are read and compared by the extension itself.';

export class ToolNotFoundError extends Error {}

export class ToolError extends Error {}

export function resolveTools(): never {
  throw new ToolNotFoundError(NOT_AVAILABLE);
}

export class GdxTools {
  constructor() {
    throw new ToolNotFoundError(NOT_AVAILABLE);
  }
}
