/**
 * domain-classifier.ts -- Domain labels and write-back for Function nodes.
 *
 * Domain classification is done externally via a local skill, NOT by this
 * pipeline. This module provides:
 *   - The canonical list of domain labels
 *   - writeDomainLabels() to persist labels to the PKG
 *   - isSignificantChange() to detect when re-classification is warranted
 */

import type { Driver } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default domain labels — a generic taxonomy suitable for most TS projects.
 * Override via CODEBASE_PKG_DOMAIN_LABELS (comma-separated) to match your
 * codebase's architecture. The default is intentionally broad; project-specific
 * taxonomies almost always do better.
 *
 * Keep 'unclassified' last — it is the fallback domain set on every new
 * Function node before classification.
 */
const DEFAULT_DOMAIN_LABELS = [
  'application',           // Main application logic / domain code
  'web-api',               // HTTP routes, controllers, request handlers
  'frontend',              // UI components, client-side code
  'database',              // DB clients, migrations, ORM code
  'infrastructure',        // Queues, caches, external service clients
  'shared-utilities',      // Generic helpers, types, logging
  'cli',                   // Command-line entry points
  'testing',               // Test utilities, fixtures
  'unclassified',
] as const;

const envLabels = process.env.CODEBASE_PKG_DOMAIN_LABELS
  ? process.env.CODEBASE_PKG_DOMAIN_LABELS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

export const DOMAIN_LABELS = (envLabels ?? DEFAULT_DOMAIN_LABELS) as readonly string[];

export type DomainLabel = string;

const SIGNIFICANT_CHANGE_FIELDS = new Set(['full', 'jsDoc', 'returnType', 'bodyText', 'args']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  name: string;
  filePath: string;
  domain: DomainLabel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isSignificantChange(changedFields: string[]): boolean {
  return changedFields.some(f => SIGNIFICANT_CHANGE_FIELDS.has(f));
}

export async function writeDomainLabels(
  results: ClassificationResult[],
  driver: Driver
): Promise<void> {
  if (results.length === 0) return;

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const result of results) {
      await tx.run(
        `
        MATCH (f:Function {filePath: $filePath, name: $name})
        SET f.domain = $domain
        `,
        { filePath: result.filePath, name: result.name, domain: result.domain }
      );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}
