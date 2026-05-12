/**
 * getLogContext.ts -- Search actual log files on disk for matching entries.
 *
 * Reads log files from the project's logs/ directory and searches for lines
 * matching the provided filters (query text, service name, severity level,
 * and time window). Returns the last 20 matching lines with file and context.
 *
 * Log format assumed: `YYYY-MM-DD HH:mm:ss [service] level: message` (adjust
 * extractors below if your logger emits a different shape).
 *
 * Target response size: 500-2,000 tokens.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const REPO_ROOT = process.cwd();
const LOGS_DIR = process.env.CODEBASE_PKG_LOGS_DIR ?? path.join(REPO_ROOT, 'logs');
const MAX_RESULTS = 20;

export interface GetLogContextInput {
  query?: string;
  service?: string;
  severity?: string;
  since?: string;
}

interface LogMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

/**
 * Handle the getLogContext tool call.
 */
export async function handleGetLogContext(input: GetLogContextInput): Promise<string> {
  const { query, service, severity } = input;
  const since = input.since ?? defaultSince();

  if (!fs.existsSync(LOGS_DIR)) {
    return (
      `No logs directory found at ${LOGS_DIR}.\n\n` +
      `Expected log files at this path when a running service emits them. ` +
      `Set CODEBASE_PKG_LOGS_DIR to override the default.`
    );
  }

  let logFiles: string[];
  try {
    logFiles = fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .map((f) => path.join(LOGS_DIR, f));
  } catch (err) {
    return `Failed to read logs directory at ${LOGS_DIR}: ${String(err)}`;
  }

  if (logFiles.length === 0) {
    return (
      `Logs directory exists at ${LOGS_DIR} but contains no .log files.\n\n` +
      `Expected files named like \`combined-YYYY-MM-DD.log\` or \`error-YYYY-MM-DD.log\`.`
    );
  }

  // Build filter predicates
  const queryRe = query ? new RegExp(escapeRegex(query), 'i') : null;
  const serviceRe = service ? new RegExp(escapeRegex(service), 'i') : null;
  const severityRe = severity ? new RegExp(`\\b${escapeRegex(severity)}\\b`, 'i') : null;
  const sincePrefix = since;

  const allMatches: LogMatch[] = [];

  for (const filePath of logFiles) {
    const fileBasename = path.basename(filePath);
    const fileDateMatch = fileBasename.match(/(\d{4}-\d{2}-\d{2})/);
    if (fileDateMatch) {
      const fileDate = fileDateMatch[1];
      if (fileDate < sincePrefix) {
        continue;
      }
    }

    const fileMatches = await searchFile(
      filePath,
      queryRe,
      serviceRe,
      severityRe,
      sincePrefix
    );
    allMatches.push(...fileMatches);
  }

  if (allMatches.length === 0) {
    const filterDesc = buildFilterDescription(query, service, severity, since);
    const fileList = logFiles.map((f) => `  ${path.basename(f)}`).join('\n');
    return (
      `No log lines found${filterDesc ? ` matching ${filterDesc}` : ''}.\n\n` +
      `Searched ${logFiles.length} file(s) in ${LOGS_DIR}:\n${fileList}`
    );
  }

  const results = allMatches.slice(-MAX_RESULTS);

  // Format output
  const lines: string[] = [];
  const filterDesc = buildFilterDescription(query, service, severity, since);
  lines.push(`LOG CONTEXT${filterDesc ? `: ${filterDesc}` : ''}`);
  lines.push('='.repeat(60));
  lines.push(
    `${results.length} line(s) shown` +
      (allMatches.length > MAX_RESULTS
        ? ` (${allMatches.length} total matches — showing last ${MAX_RESULTS})`
        : '') +
      '\n'
  );

  let lastFile = '';
  for (const match of results) {
    const relPath = path.relative(REPO_ROOT, match.filePath);
    if (match.filePath !== lastFile) {
      lines.push(`--- ${relPath} ---`);
      lastFile = match.filePath;
    }
    lines.push(`  L${match.lineNumber}: ${match.line}`);
  }

  lines.push('');
  lines.push(`Log files scanned: ${logFiles.length} file(s) in ${LOGS_DIR}`);

  return lines.join('\n');
}

async function searchFile(
  filePath: string,
  queryRe: RegExp | null,
  serviceRe: RegExp | null,
  severityRe: RegExp | null,
  sincePrefix: string
): Promise<LogMatch[]> {
  const matches: LogMatch[] = [];

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  } catch {
    return matches;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;

    if (!line.trim()) continue;

    if (line.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(line)) {
      if (line.slice(0, 10) < sincePrefix) {
        continue;
      }
    }

    if (serviceRe) {
      const serviceToken = extractServiceToken(line);
      if (!serviceToken || !serviceRe.test(serviceToken)) {
        continue;
      }
    }

    if (severityRe) {
      const sev = extractSeverity(line);
      if (!sev || !severityRe.test(sev)) {
        continue;
      }
    }

    if (queryRe && !queryRe.test(line)) {
      continue;
    }

    matches.push({ filePath, lineNumber, line });
  }

  return matches;
}

function extractServiceToken(line: string): string | null {
  const match = line.match(/\[([^\]]+)\]/);
  return match ? match[1] : null;
}

function extractSeverity(line: string): string | null {
  const match = line.match(/\]\s+(\w+):/);
  return match ? match[1] : null;
}

function buildFilterDescription(
  query: string | undefined,
  service: string | undefined,
  severity: string | undefined,
  since: string
): string {
  const parts: string[] = [];
  if (query) parts.push(`query="${query}"`);
  if (service) parts.push(`service="${service}"`);
  if (severity) parts.push(`severity="${severity}"`);
  parts.push(`since ${since}`);
  return parts.join(', ');
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
