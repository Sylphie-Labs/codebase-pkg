/**
 * migrations/index.ts -- Migration registry for codebase-pkg.
 *
 * Each migration is a module that knows how to upgrade a consumer's repo
 * from one specific version to one specific next version. New migrations
 * register themselves here in chronological order.
 *
 * As of 0.1.0 (initial release) the registry is empty — there is nothing to
 * migrate from. The first real migration ships when 0.2.0 lands.
 *
 * Naming convention: `<from>-to-<to>.ts`, e.g. `0.1.0-to-0.2.0.ts`.
 */

import type { Migration } from './types.js';

// Add migrations here as new versions ship.
// Example: import migration_0_1_0_to_0_2_0 from './0.1.0-to-0.2.0.js';

export const MIGRATIONS: Migration[] = [
  // migration_0_1_0_to_0_2_0,
];

export type { Migration, MigrationContext, MigrationResult, MigrationSeverity } from './types.js';
