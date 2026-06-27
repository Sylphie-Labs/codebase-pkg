/**
 * 0.3.0-to-0.4.0.ts -- Installs the new /map-pkg-from-root skill.
 *
 * 0.4.0 adds a top-down mapping skill at
 * `.claude/skills/map-pkg-from-root/SKILL.md`. Existing installs do not receive
 * new template files automatically, so this migration copies it into the
 * consumer repo and tracks it in managedFiles. It is idempotent and respects
 * drift: a user-modified or pre-existing untracked file is left alone unless
 * `--force` is passed (which backs the existing file up to `.bak`).
 *
 * No Neo4j schema migration is needed -- the skill writes schemaless REACHES
 * edges and root annotations at runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectDrift, getManagedFiles, hashFile, normalizePath } from '../state.js';
import type { Migration, MigrationContext, MigrationResult } from './types.js';

const SKILL_REL = '.claude/skills/map-pkg-from-root/SKILL.md';

const migration: Migration = {
  from: '0.3.0',
  to: '0.4.0',
  severity: 'minor',
  description: 'add the /map-pkg-from-root top-down mapping skill',
  notes:
    'Installs .claude/skills/map-pkg-from-root/SKILL.md, the top-down counterpart ' +
    'to /infer-pkg-connections. If you already have a file at that path it is left ' +
    'untouched unless you pass --force (which backs the existing file up to .bak). ' +
    'No Neo4j migration or new indexes -- the skill writes schemaless REACHES edges ' +
    'and root annotations at runtime.',
  async apply(ctx: MigrationContext): Promise<MigrationResult> {
    const src = path.join(ctx.packageRoot, 'template', SKILL_REL);
    const dest = path.join(ctx.cwd, SKILL_REL);
    const managedFiles = [...getManagedFiles(ctx.state).files];
    const changedFiles: string[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(src)) {
      warnings.push(`bundled template missing at ${src}; skill not installed.`);
      return { managedFiles, changedFiles, warnings };
    }

    const tracked = managedFiles.find((m) => m.path === SKILL_REL);
    const exists = fs.existsSync(dest);

    // Respect drift: don't clobber a file the user changed, or a pre-existing
    // untracked one, unless --force.
    if (exists && !ctx.force) {
      if (tracked && detectDrift(ctx.cwd, tracked) === 'modified') {
        warnings.push(
          `${SKILL_REL} modified since install; left as-is (use --force to overwrite).`,
        );
        return { managedFiles, changedFiles, warnings };
      }
      if (!tracked) {
        warnings.push(
          `${SKILL_REL} already exists and is untracked; left as-is (use --force to overwrite).`,
        );
        return { managedFiles, changedFiles, warnings };
      }
    }

    if (!ctx.dryRun) {
      if (exists && ctx.force) {
        fs.copyFileSync(dest, `${dest}.bak`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    changedFiles.push(SKILL_REL);

    const entry = {
      path: normalizePath(SKILL_REL),
      installedHash: hashFile(ctx.dryRun ? src : dest),
    };
    if (tracked) tracked.installedHash = entry.installedHash;
    else managedFiles.push(entry);

    return { managedFiles, changedFiles, warnings };
  },
};

export default migration;
