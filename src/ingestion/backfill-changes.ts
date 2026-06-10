/**
 * backfill-changes.ts -- One-shot backfill of Change nodes from git log history.
 *
 * Reads the last 30 commits from the current git repo, creates a Change node
 * for each commit, and wires CHANGED_IN edges from any Function or Type node
 * whose filePath matches files touched by that commit.
 *
 * Idempotent: skips commits whose Change node already exists.
 *
 * Entry point: `npm run backfill-changes`
 */

import { execSync } from 'child_process';
import neo4j, { Integer as Neo4jInteger, Session } from 'neo4j-driver';
import { getDriver, closeDriver } from '../mcp-server/neo4j-client.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const NEO4J_URI = process.env.CODEBASE_PKG_NEO4J_URI ?? 'bolt://localhost:7687';
const COMMIT_LIMIT = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommitMeta {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getRecentCommits(repoRoot: string, limit: number): CommitMeta[] {
  const format = '%H\x1F%h\x1F%an\x1F%aI\x1F%s';
  const raw = execSync(
    `git -C "${repoRoot}" log -${limit} --format="${format}"`,
    { encoding: 'utf8' }
  ).trim();

  if (!raw) return [];

  return raw.split('\n').map((line) => {
    const parts = line.split('\x1F');
    if (parts.length < 5) {
      throw new Error(`Unexpected git log line format: ${line}`);
    }
    return {
      hash: parts[0].trim(),
      shortHash: parts[1].trim(),
      author: parts[2].trim(),
      date: parts[3].trim(),
      message: parts[4].trim(),
    };
  });
}

function getChangedFiles(repoRoot: string, hash: string): string[] {
  try {
    const raw = execSync(
      `git -C "${repoRoot}" diff --name-only ${hash}~1 ${hash}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return raw ? raw.split('\n').map((f) => f.trim()).filter(Boolean) : [];
  } catch {
    try {
      const raw = execSync(
        `git -C "${repoRoot}" show --name-only --format="" ${hash}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      return raw ? raw.split('\n').map((f) => f.trim()).filter(Boolean) : [];
    } catch {
      console.warn(`  [warn] Could not get changed files for ${hash} — skipping file edges`);
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Neo4j helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number {
  if (value instanceof Neo4jInteger) return value.toNumber();
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

// ---------------------------------------------------------------------------
// Neo4j writes
// ---------------------------------------------------------------------------

async function ensureConstraint(session: Session): Promise<void> {
  await session.run(
    `CREATE CONSTRAINT change_hash_unique IF NOT EXISTS
     FOR (c:Change) REQUIRE c.hash IS UNIQUE`
  );
}

async function changeExists(session: Session, hash: string): Promise<boolean> {
  const result = await session.run(
    `OPTIONAL MATCH (c:Change { hash: $hash }) RETURN c IS NOT NULL AS exists`,
    { hash }
  );
  const record = result.records[0];
  return record ? Boolean(record.get('exists')) : false;
}

async function createChangeNode(
  session: Session,
  commit: CommitMeta,
  fileCount: number,
  recordedAt: string
): Promise<void> {
  await session.run(
    `CREATE (c:Change {
       hash:       $hash,
       shortHash:  $shortHash,
       author:     $author,
       date:       $date,
       message:    $message,
       fileCount:  $fileCount,
       recordedAt: $recordedAt
     })`,
    {
      hash: commit.hash,
      shortHash: commit.shortHash,
      author: commit.author,
      date: commit.date,
      message: commit.message,
      fileCount,
      recordedAt,
    }
  );
}

async function wireChangedInEdges(
  session: Session,
  commitHash: string,
  relativePaths: string[]
): Promise<number> {
  if (relativePaths.length === 0) return 0;

  const normalized = relativePaths.map((p) => p.replace(/\\/g, '/'));

  const result = await session.run(
    `MATCH (n) WHERE (n:Function OR n:Type)
       AND n.filePath IS NOT NULL
       AND ANY(rp IN $paths WHERE replace(n.filePath, '\\\\', '/') ENDS WITH rp)
     WITH n
     MATCH (c:Change { hash: $hash })
     MERGE (n)-[:CHANGED_IN]->(c)
     RETURN count(n) AS wired`,
    { hash: commitHash, paths: normalized }
  );

  const record = result.records[0];
  return record ? toNumber(record.get('wired')) : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runBackfillChanges(): Promise<void> {
  console.log('=== Codebase PKG — Change node backfill ===');
  console.log(`Repo:    ${REPO_ROOT}`);
  console.log(`Neo4j:   ${NEO4J_URI}`);
  console.log(`Commits: last ${COMMIT_LIMIT}`);
  console.log('');

  console.log('Reading git log...');
  const commits = getRecentCommits(REPO_ROOT, COMMIT_LIMIT);
  console.log(`Found ${commits.length} commits.\n`);

  const driver = getDriver();

  try {
    await driver.verifyConnectivity();
    console.log('Neo4j connection verified.\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to connect to Neo4j at ${NEO4J_URI}: ${msg}`);
    await closeDriver();
    process.exit(1);
  }

  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    console.log('Ensuring Change.hash uniqueness constraint...');
    await ensureConstraint(session);
    console.log('Constraint ready.\n');

    const recordedAt = new Date().toISOString();
    let created = 0;
    let skipped = 0;
    let totalEdges = 0;

    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i];
      const prefix = `[${String(i + 1).padStart(2, '0')}/${commits.length}]`;

      const exists = await changeExists(session, commit.hash);
      if (exists) {
        console.log(`${prefix} SKIP  ${commit.shortHash}  ${commit.message.slice(0, 60)}`);
        skipped++;
        continue;
      }

      const changedFiles = getChangedFiles(REPO_ROOT, commit.hash);
      await createChangeNode(session, commit, changedFiles.length, recordedAt);

      let edgeCount = 0;
      if (changedFiles.length > 0) {
        edgeCount = await wireChangedInEdges(session, commit.hash, changedFiles);
        totalEdges += edgeCount;
      }

      console.log(
        `${prefix} CREATE ${commit.shortHash}  ${commit.message.slice(0, 55).padEnd(55)}  ` +
        `files=${String(changedFiles.length).padStart(3)}  edges=${String(edgeCount).padStart(3)}`
      );
      created++;
    }

    console.log('');
    console.log('=== Backfill complete ===');
    console.log(`  Change nodes created : ${created}`);
    console.log(`  Change nodes skipped : ${skipped} (already existed)`);
    console.log(`  CHANGED_IN edges     : ${totalEdges}`);
  } finally {
    await session.close();
    await closeDriver();
  }
}

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBackfillChanges().catch((err) => {
    console.error('Backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
