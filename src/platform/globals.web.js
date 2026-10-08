// The globals of Node.js that the modules of the web extension use (injected by scripts/build-web.mjs):
// Buffer (of the buffer package) and the parts of `process` they read.
export { Buffer } from 'buffer';

export const process = { platform: 'web', pid: 0, env: {}, cwd: () => '/' };
