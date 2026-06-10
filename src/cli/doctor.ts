/**
 * doctor.ts -- `codebase-pkg doctor` command.
 *
 * Runs a set of structural checks against the consumer's install and prints
 * a clear pass/warn/fail report. Exits 0 when all checks pass or only warn;
 * exits 1 when any check fails.
 *
 * Network-bound checks (Neo4j reachability) are skipped if --no-network is
 * passed — useful in CI or air-gapped review.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectDrift, readState } from '../upgrade/state.js';
import { compareVersions } from '../upgrade/runner.js';

type CheckResult = { name: string; status: 'pass' | 'warn' | 'fail'; message: string };

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function statusGlyph(s: CheckResult['status']): string {
  return s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✗';
}

async function checkStateFile(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) {
    return {
      name: 'state.json',
      status: 'fail',
      message: `.codebase-pkg/state.json missing. Run 'codebase-pkg init' to set up.`,
    };
  }
  return {
    name: 'state.json',
    status: 'pass',
    message: `version ${state.version} installed ${state.installedAt} (${state.installMode})`,
  };
}

async function checkVersionMatch(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) return { name: 'version-match', status: 'warn', message: 'no state file; skipped' };
  const cli = readPackageVersion();
  if (state.version === cli) {
    return { name: 'version-match', status: 'pass', message: `state and CLI both at ${cli}` };
  }
  const cmp = compareVersions(state.version, cli);
  return {
    name: 'version-match',
    status: 'warn',
    message:
      cmp < 0
        ? `state ${state.version} < CLI ${cli}. Run 'codebase-pkg upgrade --plan' to preview migrations.`
        : `state ${state.version} > CLI ${cli}. Upgrade your global install, or run 'init --force' against the current state.`,
  };
}

async function checkManagedFiles(cwd: string): Promise<CheckResult> {
  const state = readState(cwd);
  if (!state) return { name: 'managed-files', status: 'warn', message: 'no state file; skipped' };
  const missing: string[] = [];
  const modified: string[] = [];
  for (const f of state.managedFiles) {
    const d = detectDrift(cwd, f);
    if (d === 'missing') missing.push(f.path);
    else if (d === 'modified') modified.push(f.path);
  }
  if (missing.length === 0 && modified.length === 0) {
    return {
      name: 'managed-files',
      status: 'pass',
      message: `${state.managedFiles.length}/${state.managedFiles.length} files unchanged`,
    };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.length} missing`);
  if (modified.length > 0) parts.push(`${modified.length} modified`);
  return {
    name: 'managed-files',
    status: missing.length > 0 ? 'fail' : 'warn',
    message: `${parts.join(', ')}. Run 'codebase-pkg status' for details.`,
  };
}

async function checkMcpStanza(cwd: string): Promise<CheckResult> {
  const mcpPath = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(mcpPath)) {
    return { name: 'mcp.json', status: 'fail', message: '.mcp.json missing' };
  }
  try {
    const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    if (!j.mcpServers || !j.mcpServers['codebase-pkg']) {
      return { name: 'mcp.json', status: 'fail', message: 'no codebase-pkg server registered' };
    }
    return { name: 'mcp.json', status: 'pass', message: 'codebase-pkg server registered' };
  } catch {
    return { name: 'mcp.json', status: 'fail', message: '.mcp.json is not valid JSON' };
  }
}

async function checkConstraints(cwd: string): Promise<CheckResult> {
  const p = path.join(cwd, 'constraints.json');
  if (!fs.existsSync(p)) {
    return {
      name: 'constraints.json',
      status: 'warn',
      message: 'constraints.json not found. Re-run init or copy from constraints.example.json.',
    };
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!Array.isArray(j)) {
      return {
        name: 'constraints.json',
        status: 'warn',
        message: 'unexpected format: expected a root-level JSON array of constraint objects',
      };
    }
    const count = j.length;
    return {
      name: 'constraints.json',
      status: count > 0 ? 'pass' : 'warn',
      message: `${count} constraint(s) defined`,
    };
  } catch {
    return { name: 'constraints.json', status: 'fail', message: 'constraints.json is not valid JSON' };
  }
}

async function checkNeo4j(): Promise<CheckResult> {
  const uri = process.env.CODEBASE_PKG_NEO4J_URI ?? 'bolt://localhost:7687';
  try {
    const neo4j = (await import('neo4j-driver')).default;
    const driver = neo4j.driver(
      uri,
      neo4j.auth.basic(
        process.env.CODEBASE_PKG_NEO4J_USER ?? 'neo4j',
        process.env.CODEBASE_PKG_NEO4J_PASSWORD ?? 'codebase-pkg-local',
      ),
      { connectionAcquisitionTimeout: 3000 },
    );
    try {
      const session = driver.session();
      try {
        await session.run('RETURN 1 AS ok');
        return { name: 'neo4j', status: 'pass', message: `reachable at ${uri}` };
      } finally {
        await session.close();
      }
    } finally {
      await driver.close();
    }
  } catch (err) {
    return {
      name: 'neo4j',
      status: 'fail',
      message: `cannot reach ${uri}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }
}

export async function runDoctor(args: string[]): Promise<number> {
  const noNetwork = args.includes('--no-network');
  const cwd = process.cwd();

  process.stdout.write(`codebase-pkg doctor — running checks in ${cwd}\n\n`);

  const checks: Array<() => Promise<CheckResult>> = [
    () => checkStateFile(cwd),
    () => checkVersionMatch(cwd),
    () => checkManagedFiles(cwd),
    () => checkMcpStanza(cwd),
    () => checkConstraints(cwd),
  ];
  if (!noNetwork) checks.push(() => checkNeo4j());

  let fails = 0;
  let warns = 0;
  for (const run of checks) {
    let result: CheckResult;
    try {
      result = await run();
    } catch (err) {
      result = { name: 'unknown', status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
    process.stdout.write(
      `  ${statusGlyph(result.status)} ${result.name.padEnd(18)} ${result.message}\n`,
    );
    if (result.status === 'fail') fails++;
    else if (result.status === 'warn') warns++;
  }

  process.stdout.write(`\n${fails} fail, ${warns} warn, ${checks.length - fails - warns} pass.\n`);
  return fails > 0 ? 1 : 0;
}
