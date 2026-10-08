/**
 * Compile-time checks that the modules of the web extension (*.web.ts, see scripts/build-web.mjs) export
 * what the modules they replace export, with the same types. Nothing of this is run.
 */
import type * as files from './files';
import type * as filesWeb from './files.web';
import type * as uris from './uris';
import type * as urisWeb from './uris.web';
import type * as nodeFeatures from '../nodeFeatures';
import type * as nodeFeaturesWeb from '../nodeFeatures.web';

type Replaces<Desktop, Web extends Desktop> = [Desktop, Web];

export type Checks = [
  Replaces<typeof files, typeof filesWeb>,
  Replaces<Omit<typeof uris, 'IS_WEB'>, Omit<typeof urisWeb, 'IS_WEB'>>,
  Replaces<typeof nodeFeatures, typeof nodeFeaturesWeb>,
];
