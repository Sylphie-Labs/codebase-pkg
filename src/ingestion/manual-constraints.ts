/**
 * manual-constraints.ts -- CLI tool for adding Constraint nodes to the PKG.
 *
 * Reads a constraints.json file and creates Constraint nodes in the codebase
 * PKG, linked via CONSTRAINED_BY edges to the Module or Function nodes they
 * apply to.
 *
 * Usage:
 *   npm run add-constraint                          # reads codebase-pkg/constraints.json
 *   npm run add-constraint -- path/to/file.json     # custom file
 *   npm run add-constraint -- --validate            # validate only, no writes
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDriver, closeDriver } from '../mcp-server/neo4j-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const DEFAULT_CONSTRAINTS_FILE = path.join(
  REPO_ROOT,
  'packages',
  'codebase-pkg',
  'constraints.json'
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConstraintSeverity = 'must' | 'should' | 'prefer';
export type ConstraintScopeType = 'module' | 'function' | 'service';

export interface ConstraintDefinition {
  id: string;
  description: string;
  scope: string;
  scopeType: ConstraintScopeType;
  source: string;
  severity: ConstraintSeverity;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConstraint(raw: unknown, index: number): ConstraintDefinition {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Constraint at index ${index} is not an object`);
  }

  const c = raw as Record<string, unknown>;

  const requiredFields = ['id', 'description', 'scope', 'scopeType', 'source', 'severity'];
  for (const field of requiredFields) {
    if (!c[field]) {
      throw new Error(`Constraint at index ${index} is missing required field: ${field}`);
    }
  }

  const validSeverities: ConstraintSeverity[] = ['must', 'should', 'prefer'];
  if (!validSeverities.includes(c.severity as ConstraintSeverity)) {
    throw new Error(
      `Constraint "${c.id}" has invalid severity "${c.severity}". Must be: ${validSeverities.join(', ')}`
    );
  }

  const validScopeTypes: ConstraintScopeType[] = ['module', 'function', 'service'];
  if (!validScopeTypes.includes(c.scopeType as ConstraintScopeType)) {
    throw new Error(
      `Constraint "${c.id}" has invalid scopeType "${c.scopeType}". Must be: ${validScopeTypes.join(', ')}`
    );
  }

  return {
    id: c.id as string,
    description: c.description as string,
    scope: c.scope as string,
    scopeType: c.scopeType as ConstraintScopeType,
    source: c.source as string,
    severity: c.severity as ConstraintSeverity,
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
  };
}

export function loadConstraints(filePath: string): ConstraintDefinition[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Constraints file not found: ${filePath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse constraints file: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error(`Constraints file must contain a JSON array at the root level`);
  }

  return raw.map((item, i) => validateConstraint(item, i));
}

// ---------------------------------------------------------------------------
// Graph operations
// ---------------------------------------------------------------------------

function buildScopeMatch(constraint: ConstraintDefinition): {
  cypher: string;
  params: Record<string, string>;
} {
  const normalised = constraint.scope.replace(/\\/g, '/');

  switch (constraint.scopeType) {
    case 'service':
      return {
        cypher: 'MATCH (target:Service {name: $scope})',
        params: { scope: normalised },
      };

    case 'module': {
      const absScope = normalised.startsWith('/')
        ? normalised
        : path.join(REPO_ROOT, normalised).replace(/\\/g, '/');
      return {
        cypher: 'MATCH (target:Module) WHERE target.filePath STARTS WITH $scope',
        params: { scope: absScope },
      };
    }

    case 'function': {
      const sep = normalised.lastIndexOf('::');
      if (sep === -1) {
        throw new Error(
          `Function-scoped constraint "${constraint.id}" scope must be "filePath::functionName", got: ${constraint.scope}`
        );
      }
      const filePath = normalised.slice(0, sep);
      const fnName = normalised.slice(sep + 2);
      return {
        cypher: 'MATCH (target:Function {filePath: $filePath, name: $fnName})',
        params: { filePath, fnName } as Record<string, string>,
      };
    }
  }
}

async function writeConstraint(
  constraint: ConstraintDefinition,
  driver: import('neo4j-driver').Driver
): Promise<{ linked: number }> {
  const { cypher: matchCypher, params: matchParams } = buildScopeMatch(constraint);

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    await tx.run(
      `
      MERGE (c:Constraint {id: $id})
      SET c.description = $description,
          c.scope       = $scope,
          c.scopeType   = $scopeType,
          c.source      = $source,
          c.severity    = $severity,
          c.tags        = $tags,
          c.updatedAt   = toString(datetime())
      `,
      {
        id: constraint.id,
        description: constraint.description,
        scope: constraint.scope,
        scopeType: constraint.scopeType,
        source: constraint.source,
        severity: constraint.severity,
        tags: (constraint.tags ?? []).length > 0 ? constraint.tags! : ['general'],
      }
    );

    const linkCypher = `
      ${matchCypher}
      MATCH (c:Constraint {id: $constraintId})
      MERGE (target)-[:CONSTRAINED_BY]->(c)
      RETURN count(target) AS linked
    `;

    const result = await tx.run(linkCypher, {
      ...matchParams,
      constraintId: constraint.id,
    });

    const rawLinked = result.records[0]?.get('linked');
    const linked = typeof rawLinked === 'number' ? rawLinked
      : rawLinked?.toNumber?.() ?? Number(rawLinked ?? 0);

    await tx.commit();
    return { linked };
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAddConstraints(options: {
  filePath: string;
  validateOnly: boolean;
}): Promise<void> {
  console.log(`[constraints] Loading from: ${options.filePath}`);

  const constraints = loadConstraints(options.filePath);
  console.log(`[constraints] Found ${constraints.length} constraint(s) to process.`);

  for (const c of constraints) {
    console.log(`  [${c.severity.toUpperCase()}] ${c.id}: ${c.description.slice(0, 70)}`);
    console.log(`         scope: ${c.scopeType} = ${c.scope}`);
    console.log(`         source: ${c.source}`);
  }

  if (options.validateOnly) {
    console.log('\n[constraints] --validate flag set — no writes performed.');
    return;
  }

  const driver = getDriver();
  let created = 0;
  let linked = 0;
  const errors: string[] = [];

  for (const constraint of constraints) {
    try {
      const result = await writeConstraint(constraint, driver);
      linked += result.linked;
      created++;
      console.log(
        `[constraints] Wrote "${constraint.id}" — linked to ${result.linked} node(s).`
      );

      if (result.linked === 0) {
        console.warn(
          `  WARNING: No matching nodes found for scope "${constraint.scope}" (${constraint.scopeType}). ` +
          `Run seed first, or check the scope value.`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  ${constraint.id}: ${msg}`);
      console.error(`[constraints] ERROR writing "${constraint.id}": ${msg}`);
    }
  }

  await closeDriver();

  console.log('\n' + '='.repeat(50));
  console.log(`[constraints] Done — ${created} created, ${linked} edges linked, ${errors.length} error(s).`);
  if (errors.length > 0) {
    console.error('Errors:');
    errors.forEach(e => console.error(e));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const validateOnly = args.includes('--validate');
  const fileArg = args.find(a => !a.startsWith('--'));
  const filePath = fileArg
    ? path.resolve(fileArg)
    : DEFAULT_CONSTRAINTS_FILE;

  runAddConstraints({ filePath, validateOnly }).catch(err => {
    console.error('[constraints] Fatal error:', err instanceof Error ? err.message : String(err));
    closeDriver().finally(() => process.exit(1));
  });
}
