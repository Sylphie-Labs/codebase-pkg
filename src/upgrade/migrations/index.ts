/**
 * migrations/index.ts -- Migration registry for codebase-pkg.
 *
 * Each migration is a module that knows how to upgrade a consumer's repo
 * from one specific version to one specific next version. New migrations
 * register themselves here in chronological order.
 *
 * Naming convention: `<from>-to-<to>.ts`, e.g. `0.1.0-to-0.2.0.ts`.
 */

import type { Migration } from './types.js';

// Add migrations here as new versions ship.
import migration_0_1_0_to_0_2_0 from './0.1.0-to-0.2.0.js';
import migration_0_2_0_to_0_2_1 from './0.2.0-to-0.2.1.js';

export const MIGRATIONS: Migration[] = [
  migration_0_1_0_to_0_2_0,
  migration_0_2_0_to_0_2_1,
];

export type { Migration, MigrationContext, MigrationResult, MigrationSeverity } from './types.js';
