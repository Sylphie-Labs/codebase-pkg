/**
 * change-logger.ts -- Create Change nodes from git commit metadata.
 *
 * After a sync run, this module records a Change node in the codebase PKG
 * and links CHANGED_IN edges from every Function and Type node in the
 * modified files.
 */

import { execSync } from 'child_process';
import { getDriver } from '../mcp-server/neo4j-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

function readCommitInfo(commitHash: string): CommitInfo {
  const format = '%H|%h|%an|%aI|%s';
  const raw = execSync(
    `git log -1 --format="${format}" ${commitHash}`,
    { cwd: REPO_ROOT, encoding: 'utf-8' }
  ).trim();

  const parts = raw.split('|');
  if (parts.length < 5) {
    throw new Error(`Unexpected git log output: ${raw}`);
  }

  return {
    hash: parts[0],
    shortHash: parts[1],
    author: parts[2],
    date: parts[3],
    message: parts[4],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function logChange(
  changedFilePaths: string[],
  commitHash?: string
): Promise<void> {
  if (changedFilePaths.length === 0) {
    console.log('[change-logger] No changed files — skipping Change node creation.');
    return;
  }

  const hash = commitHash ?? execSync('git rev-parse HEAD', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();

  let commitInfo: CommitInfo;
  try {
    commitInfo = readCommitInfo(hash);
  } catch (err) {
    console.warn(`[change-logger] Could not read commit info for ${hash}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const normalised = changedFilePaths.map(p => p.replace(/\\/g, '/'));

  const driver = getDriver();
  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    await tx.run(
      `
      MERGE (c:Change {hash: $hash})
      SET c.shortHash   = $shortHash,
          c.author      = $author,
          c.date        = $date,
          c.message     = $message,
          c.fileCount   = $fileCount,
          c.recordedAt  = timestamp()
      `,
      {
        hash: commitInfo.hash,
        shortHash: commitInfo.shortHash,
        author: commitInfo.author,
        date: commitInfo.date,
        message: commitInfo.message,
        fileCount: normalised.length,
      }
    );

    await tx.run(
      `
      MATCH (f:Function)
      WHERE f.filePath IN $filePaths
      MATCH (c:Change {hash: $hash})
      MERGE (f)-[:CHANGED_IN]->(c)
      `,
      { filePaths: normalised, hash: commitInfo.hash }
    );

    await tx.run(
      `
      MATCH (t:Type)
      WHERE t.filePath IN $filePaths
      MATCH (c:Change {hash: $hash})
      MERGE (t)-[:CHANGED_IN]->(c)
      `,
      { filePaths: normalised, hash: commitInfo.hash }
    );

    await tx.run(
      `
      MATCH (m:Module)
      WHERE m.filePath IN $filePaths
      MATCH (c:Change {hash: $hash})
      MERGE (m)-[:CHANGED_IN]->(c)
      `,
      { filePaths: normalised, hash: commitInfo.hash }
    );

    await tx.commit();

    console.log(
      `[change-logger] Recorded Change node ${commitInfo.shortHash} (${commitInfo.message.slice(0, 60)}) ` +
      `linked to ${normalised.length} file(s).`
    );
  } catch (err) {
    await tx.rollback();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[change-logger] Failed to record Change node: ${msg}`);
  } finally {
    await session.close();
  }
}

export async function getRecentChanges(limit = 10): Promise<CommitInfo[]> {
  const { runQuery } = await import('../mcp-server/neo4j-client.js');
  const records = await runQuery(
    `
    MATCH (c:Change)
    RETURN c.hash AS hash, c.shortHash AS shortHash,
           c.author AS author, c.date AS date, c.message AS message
    ORDER BY c.recordedAt DESC
    LIMIT $limit
    `,
    { limit }
  );

  return records.map(r => ({
    hash: r.get('hash') as string,
    shortHash: r.get('shortHash') as string,
    author: r.get('author') as string,
    date: r.get('date') as string,
    message: r.get('message') as string,
  }));
}
