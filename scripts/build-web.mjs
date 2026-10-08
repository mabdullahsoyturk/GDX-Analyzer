// Builds the web extension (VS Code for the Web: vscode.dev, github.dev): src/extension.ts and the
// modules it imports bundled into out-web/extension.js, for the web worker VS Code runs extensions in.
//
// usage: node scripts/build-web.mjs [--watch] [--production] [--tests]
//
// A module `x.ts` that has a `x.web.ts` next to it is replaced by that one (e.g. platform/files.web.ts
// reads files with vscode.workspace.fs). zlib is replaced by fflate (platform/zlib.web.ts), path by
// path-browserify, and Buffer and `process` are provided (platform/globals.web.js). Any other module
// of Node.js fails the build, so that nothing that needs Node.js gets into the web extension.
// --tests also bundles the tests that run in the browser (src/test/web) into out-web/test.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const args = new Set(process.argv.slice(2));

/** Resolves an import of a module of src/ to its web variant (x.web.ts), if there is one. */
const webVariants = {
  name: 'web-variants',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (a) => {
      if (!a.importer.startsWith(src) || /\.web\.[jt]s$/.test(a.importer)) return undefined;
      const base = path.resolve(a.resolveDir, a.path);
      for (const ext of ['.web.ts', '.web.js']) {
        if (fs.existsSync(base + ext)) return { path: base + ext };
      }
      return undefined;
    });
  },
};

const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  mainFields: ['browser', 'module', 'main'],
  external: ['vscode'],
  alias: { path: 'path-browserify', zlib: './src/platform/zlib.web.ts' },
  inject: ['./src/platform/globals.web.js'],
  plugins: [webVariants],
  sourcemap: !args.has('--production'),
  minify: args.has('--production'),
  logLevel: 'warning',
};

const builds = [{ ...options, entryPoints: { extension: 'src/extension.ts' }, outdir: 'out-web' }];
if (args.has('--tests')) {
  builds.push({ ...options, entryPoints: { index: 'src/test/web/index.ts' }, outdir: 'out-web/test' });
}

if (args.has('--watch')) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  for (const b of builds) await esbuild.build(b);
}
