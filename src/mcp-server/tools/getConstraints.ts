/**
 * getConstraints.ts -- Return architectural invariants for a named scope.
 *
 * Finds Constraint nodes linked to the service, module, or function
 * matching the given scope string. Returns constraint descriptions with
 * severity levels so an agent knows what rules apply before making changes.
 *
 * Target response size: 200-500 tokens.
 */

import { runQuery } from '../neo4j-client.js';

export interface GetConstraintsInput {
  scope: string;
}

/**
 * Handle the getConstraints tool call.
 */
export async function handleGetConstraints(input: GetConstraintsInput): Promise<string> {
  const { scope } = input;
  const searchTerm = `(?i).*${escapeRegex(scope)}.*`;

  // Find constraints via CONSTRAINED_BY from any Service, Module, or Function
  const linkedConstraints = await runQuery(
    `
    MATCH (n)-[:CONSTRAINED_BY]->(c:Constraint)
    WHERE (n:Service OR n:Module OR n:Function)
      AND (n.name =~ $pattern OR n.domain =~ $pattern)
    RETURN c.description AS description,
           c.severity AS severity,
           c.source AS source,
           c.area AS area,
           n.name AS ownerName,
           labels(n) AS ownerLabels
    ORDER BY
      CASE c.severity
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      n.name
    LIMIT 30
    `,
    { pattern: searchTerm }
  );

  // Also find constraints whose own name/area matches the scope directly
  const directConstraints = await runQuery(
    `
    MATCH (c:Constraint)
    WHERE c.name =~ $pattern OR c.area =~ $pattern
    RETURN c.description AS description,
           c.severity AS severity,
           c.source AS source,
           c.area AS area,
           null AS ownerName,
           [] AS ownerLabels
    ORDER BY
      CASE c.severity
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END
    LIMIT 10
    `,
    { pattern: searchTerm }
  );

  // Deduplicate by description
  const seen = new Set<string>();
  const allConstraints: Array<{
    description: string;
    severity: string | null;
    source: string | null;
    area: string | null;
    ownerName: string | null;
    ownerLabel: string;
  }> = [];

  for (const r of [...linkedConstraints, ...directConstraints]) {
    const desc = r.get('description') as string;
    if (seen.has(desc)) continue;
    seen.add(desc);

    const ownerLabels = r.get('ownerLabels') as string[] | null;
    allConstraints.push({
      description: desc,
      severity: r.get('severity') as string | null,
      source: r.get('source') as string | null,
      area: r.get('area') as string | null,
      ownerName: r.get('ownerName') as string | null,
      ownerLabel: ownerLabels && ownerLabels.length > 0 ? ownerLabels[0] : '',
    });
  }

  if (allConstraints.length === 0) {
    return (
      `No constraints found for scope "${scope}".\n\n` +
      `Check the CANON (docs/CANON.md) for architectural rules that may not yet be loaded into the PKG.`
    );
  }

  const lines: string[] = [];
  lines.push(`CONSTRAINTS: "${scope}"`);
  lines.push('='.repeat(60));
  lines.push(`${allConstraints.length} constraint(s) found\n`);

  // Group by severity
  const severityOrder = ['critical', 'high', 'medium', 'low', null];
  const grouped = new Map<string | null, typeof allConstraints>();

  for (const c of allConstraints) {
    const key = c.severity?.toLowerCase() ?? null;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  for (const sev of severityOrder) {
    const group = grouped.get(sev);
    if (!group || group.length === 0) continue;

    const label = sev ? sev.toUpperCase() : 'UNKNOWN SEVERITY';
    lines.push(`[${label}]`);

    for (const c of group) {
      lines.push(`  - ${c.description}`);
      const meta: string[] = [];
      if (c.ownerName) meta.push(`applies to: ${c.ownerLabel} ${c.ownerName}`);
      if (c.area) meta.push(`area: ${c.area}`);
      if (c.source) meta.push(`source: ${c.source}`);
      if (meta.length > 0) lines.push(`    (${meta.join(', ')})`);
    }

    lines.push('');
  }

  lines.push('='.repeat(60));
  lines.push(`Always consult docs/CANON.md for the authoritative source of architectural rules.`);

  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
