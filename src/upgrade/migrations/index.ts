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
import migration_0_2_1_to_0_3_0 from './0.2.1-to-0.3.0.js';
import migration_0_3_0_to_0_4_0 from './0.3.0-to-0.4.0.js';
import migration_0_4_0_to_0_5_0 from './0.4.0-to-0.5.0.js';
import migration_0_5_0_to_0_5_1 from './0.5.0-to-0.5.1.js';
import migration_0_5_1_to_0_5_2 from './0.5.1-to-0.5.2.js';
import migration_0_5_2_to_0_5_3 from './0.5.2-to-0.5.3.js';
import migration_0_5_3_to_0_5_4 from './0.5.3-to-0.5.4.js';

export const MIGRATIONS: Migration[] = [
  migration_0_1_0_to_0_2_0,
  migration_0_2_0_to_0_2_1,
  migration_0_2_1_to_0_3_0,
  migration_0_3_0_to_0_4_0,
  migration_0_4_0_to_0_5_0,
  migration_0_5_0_to_0_5_1,
  migration_0_5_1_to_0_5_2,
  migration_0_5_2_to_0_5_3,
  migration_0_5_3_to_0_5_4,
];

export type { Migration, MigrationContext, MigrationResult, MigrationSeverity } from './types.js';
