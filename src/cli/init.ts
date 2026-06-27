/**
 * init.ts -- `codebase-pkg init` command.
 *
 * Bootstraps a consumer's project to use codebase-pkg. Installs the skill
 * templates, patches `.mcp.json`, writes a starter `constraints.json` from
 * the bundled example, optionally writes a `docker-compose.codebase-pkg.yml`
 * for the Neo4j + Postgres (pgvector) services. With `--docker` it also
 * best-effort bootstraps the pgvector schema (once Postgres is reachable) and
 * pre-downloads the embedding model so the first sync runs offline
 * (`--no-model` / CODEBASE_PKG_SKIP_MODEL_PREFETCH=1 skips the prefetch).
 *
 * Records what it did in `.codebase-pkg/state.json` so `status`, `upgrade`,
 * and `uninstall` know which files this package owns and what their hashes
 * were at install time.
 *
 * Idempotent: skips existing files unless `--force`. With `--dry-run`, prints
 * what would happen without writing.
 *
 * Install mode: defaults to `global` (npm i -g). Override with `--local` when
 * the package is installed as a devDependency of the consumer's project.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  hashFile,
  normalizePath,
  readState,
  writeState,
  type InstallMode,
  type InstallState,
  type ManagedFile,
} from '../upgrade/state.js';
import {
  deriveBasePorts,
  deriveInstanceSlug,
  derivePgBasePort,
  findFreePort,
  type Neo4jInstanceConfig,
} from './neo4j-config.js';
import { resolveRoot } from './resolve-root.js';

/** Subset of Neo4jInstanceConfig persisted to state.json (no user/password). */
type DockerInstanceConfig = Pick<
  Neo4jInstanceConfig,
  'uri' | 'containerName' | 'httpPort' | 'boltPort' | 'slug'
>;

/** Per-instance Postgres (pgvector) settings persisted to state.json. */
type PgInstanceConfig = {
  uri: string;
  containerName: string;
  port: number;
  slug: string;
};

/** What installDocker produced: the Neo4j + Postgres instance configs together. */
type DockerProvision = {
  neo4j: DockerInstanceConfig;
  postgres: PgInstanceConfig;
};

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
  skillsOnly: boolean;
  mcpOnly: boolean;
  noModel: boolean;
  installMode: InstallMode;
  /** Explicit Neo4j endpoint from `--neo4j-uri`, persisted to state.neo4j.uri. */
  neo4jUri?: string;
  /** Explicit Postgres endpoint from `--pg-uri`, persisted to state.postgres.uri. */
  pgUri?: string;
};

/**
 * Read a `--flag <value>` (or `--flag=<value>`) string option from `args`.
 * Returns the last occurrence's value, or undefined when absent.
 */
function readStrFlag(args: string[], flag: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      if (args[i + 1] !== undefined) found = args[i + 1];
    } else if (a.startsWith(flag + '=')) {
      found = a.slice(flag.length + 1);
    }
  }
  return found;
}

function parseFlags(args: string[]): Flags {
  const local = args.includes('--local');
  const global = args.includes('--global');
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    docker: args.includes('--docker'),
    skillsOnly: args.includes('--skills-only'),
    mcpOnly: args.includes('--mcp-only'),
    // Skip the embedding-model prefetch either via flag or env var.
    noModel:
      args.includes('--no-model') ||
      process.env.CODEBASE_PKG_SKIP_MODEL_PREFETCH === '1',
    installMode: local ? 'local' : global ? 'global' : 'global',
    neo4jUri: readStrFlag(args, '--neo4j-uri'),
    pgUri: readStrFlag(args, '--pg-uri'),
  };
}

function detectPackageManager(cwd: string): 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown' {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function getPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function getCliAbsolutePath(): string {
  return path.join(getPackageRoot(), 'dist', 'cli', 'codebase-pkg.js');
}

function readPackageVersion(): string {
  const pkgPath = path.join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

type WriteResult = 'wrote' | 'skipped' | 'would-write';

function copyFile(src: string, dest: string, flags: Flags): WriteResult {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 'wrote';
}

function writeFileContent(dest: string, content: string, flags: Flags): WriteResult {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  return 'wrote';
}

function installSkills(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'skills');
  if (!fs.existsSync(templateRoot)) {
    process.stderr.write(`[init] no skill templates bundled at ${templateRoot}; skipping.\n`);
    return;
  }
  const files = listFilesRecursive(templateRoot);
  if (files.length === 0) return;

  process.stdout.write(`[init] skills:\n`);
  for (const src of files) {
    const rel = path.relative(templateRoot, src);
    const destRel = normalizePath(path.join('.claude', 'skills', rel));
    const dest = path.join(cwd, destRel);
    const result = copyFile(src, dest, flags);
    process.stdout.write(`  ${result.padEnd(12)} ${destRel}\n`);
    if (result === 'wrote' || (result === 'skipped' && fs.existsSync(dest))) {
      managed.push({ path: destRel, installedHash: hashFile(dest) });
    }
  }
}

interface McpStanza {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpStanza>;
}

function installMcp(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const mcpRel = '.mcp.json';
  const mcpPath = path.join(cwd, mcpRel);

  const stanza: McpStanza =
    flags.installMode === 'local'
      ? {
          command: 'node',
          args: ['./node_modules/@sylphie-labs/codebase-pkg/dist/mcp-server/index.js'],
          env: {},
        }
      : {
          command: 'npx',
          args: ['-y', '--package', '@sylphie-labs/codebase-pkg', 'codebase-pkg-mcp'],
          env: {},
        };

  let existing: McpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      process.stderr.write(`[init] could not parse existing .mcp.json; refusing to overwrite. Edit manually.\n`);
      return;
    }
  }
  existing.mcpServers = existing.mcpServers ?? {};

  if (existing.mcpServers['codebase-pkg'] && !flags.force) {
    process.stdout.write(`[init] mcp: skipped ${mcpRel} (codebase-pkg server already registered; --force to overwrite)\n`);
    if (fs.existsSync(mcpPath)) {
      managed.push({ path: mcpRel, installedHash: hashFile(mcpPath) });
    }
    return;
  }

  existing.mcpServers['codebase-pkg'] = stanza;
  const out = JSON.stringify(existing, null, 2) + '\n';

  if (flags.dryRun) {
    process.stdout.write(`[init] mcp: would-write ${mcpRel} with codebase-pkg server stanza\n`);
    return;
  }
  fs.writeFileSync(mcpPath, out, 'utf8');
  process.stdout.write(`[init] mcp: wrote ${mcpRel} with codebase-pkg server stanza\n`);
  managed.push({ path: mcpRel, installedHash: hashFile(mcpPath) });
}

function installConstraints(cwd: string, flags: Flags, managed: ManagedFile[]): void {
  const examplePath = path.join(getPackageRoot(), 'constraints.example.json');
  const destRel = 'constraints.json';
  const destPath = path.join(cwd, destRel);

  if (!fs.existsSync(examplePath)) {
    process.stderr.write(`[init] no constraints.example.json bundled; skipping.\n`);
    return;
  }
  if (fs.existsSync(destPath) && !flags.force) {
    process.stdout.write(`[init] constraints: skipped ${destRel} (already exists)\n`);
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
    return;
  }
  if (flags.dryRun) {
    process.stdout.write(`[init] constraints: would-write ${destRel} from example\n`);
    return;
  }
  fs.copyFileSync(examplePath, destPath);
  process.stdout.write(`[init] constraints: wrote ${destRel} from example\n`);
  managed.push({ path: destRel, installedHash: hashFile(destPath) });
}

/** Inputs needed to render the docker-compose file (all host ports resolved). */
interface ComposePorts {
  slug: string;
  httpPort: number;
  boltPort: number;
  pgPort: number;
}

/**
 * Render the `docker-compose.codebase-pkg.yml` content: a Neo4j service and a
 * Postgres (pgvector) service under one compose project. Pure (no I/O) so it can
 * be unit-tested directly. The Postgres credentials/db MUST match the default
 * DSN in src/conformity/pg-client.ts so resolvePgConfig connects without
 * further config.
 */
export function renderComposeFile(ports: ComposePorts): string {
  const { slug, httpPort, boltPort, pgPort } = ports;
  const projectName = `codebase-pkg-${slug}`;
  const neo4jContainer = `codebase-pkg-neo4j-${slug}`;
  const pgContainer = `codebase-pkg-postgres-${slug}`;
  const volSlug = slug.replace(/-/g, '_');
  const dataVolume = `codebase_pkg_neo4j_data_${volSlug}`;
  const logsVolume = `codebase_pkg_neo4j_logs_${volSlug}`;
  const pgVolume = `codebase_pkg_pg_data_${volSlug}`;

  return (
    `# Generated by 'codebase-pkg init --docker'. Edit as needed.\n` +
    `name: ${projectName}\n` +
    `services:\n` +
    `  codebase-pkg-neo4j:\n` +
    `    image: neo4j:5-community\n` +
    `    container_name: ${neo4jContainer}\n` +
    `    ports:\n` +
    `      - "${httpPort}:7474"\n` +
    `      - "${boltPort}:7687"\n` +
    `    environment:\n` +
    `      NEO4J_AUTH: neo4j/codebase-pkg-local\n` +
    `      NEO4J_PLUGINS: '["apoc"]'\n` +
    `      NEO4J_server_memory_heap_initial__size: 512m\n` +
    `      NEO4J_server_memory_heap_max__size: 2G\n` +
    `      NEO4J_server_memory_pagecache_size: 1G\n` +
    `    volumes:\n` +
    `      - ${dataVolume}:/data\n` +
    `      - ${logsVolume}:/logs\n` +
    `    restart: unless-stopped\n` +
    `  codebase-pkg-postgres:\n` +
    `    image: pgvector/pgvector:pg16\n` +
    `    container_name: ${pgContainer}\n` +
    `    ports:\n` +
    `      - "${pgPort}:5432"\n` +
    `    environment:\n` +
    `      POSTGRES_USER: codebase-pkg\n` +
    `      POSTGRES_PASSWORD: codebase-pkg-local\n` +
    `      POSTGRES_DB: codebase_pkg\n` +
    `    volumes:\n` +
    `      - ${pgVolume}:/var/lib/postgresql/data\n` +
    `    restart: unless-stopped\n` +
    `\n` +
    `volumes:\n` +
    `  ${dataVolume}:\n` +
    `  ${logsVolume}:\n` +
    `  ${pgVolume}:\n`
  );
}

async function installDocker(
  cwd: string,
  flags: Flags,
  managed: ManagedFile[],
): Promise<DockerProvision> {
  const destRel = 'docker-compose.codebase-pkg.yml';
  const destPath = path.join(cwd, destRel);

  // Derive a per-instance slug, then deterministic base ports, then scan for
  // free host ports so multiple repos can run their own Neo4j + Postgres pair
  // side by side without clashing.
  const slug = deriveInstanceSlug(cwd);
  const base = deriveBasePorts(slug);
  const httpPort = await findFreePort(base.http);
  let boltPort = await findFreePort(base.bolt);
  // The two scans run independently and could land on the same port; bump bolt.
  if (boltPort === httpPort) boltPort = await findFreePort(boltPort + 1);
  // Postgres lives in its own port range (see derivePgBasePort), but the
  // free-port scan could in theory walk into a port we just claimed; bump past
  // any collision so all three host ports are distinct.
  let pgPort = await findFreePort(derivePgBasePort(slug));
  while (pgPort === httpPort || pgPort === boltPort) {
    pgPort = await findFreePort(pgPort + 1);
  }

  const content = renderComposeFile({ slug, httpPort, boltPort, pgPort });

  const result = writeFileContent(destPath, content, flags);
  process.stdout.write(`[init] docker: ${result} ${destRel}\n`);
  if (result === 'wrote' || (result === 'skipped' && fs.existsSync(destPath))) {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  }

  return {
    neo4j: {
      uri: `bolt://localhost:${boltPort}`,
      containerName: `codebase-pkg-neo4j-${slug}`,
      httpPort,
      boltPort,
      slug,
    },
    postgres: {
      uri: `postgres://codebase-pkg:codebase-pkg-local@localhost:${pgPort}/codebase_pkg`,
      containerName: `codebase-pkg-postgres-${slug}`,
      port: pgPort,
      slug,
    },
  };
}

/**
 * Wait for Postgres at `uri` to answer `SELECT 1`, then ensure the conformity
 * schema (pgvector extension + cfm_vectors table + indexes) and the HNSW ANN
 * index used by the cold store's `<=>` cosine search.
 *
 * Best-effort: `codebase-pkg init` writes the compose file but does not itself
 * run `docker compose up`, so Postgres may not be reachable yet. If the
 * readiness wait times out we WARN and return false (so the human knows to run
 * the bootstrap after starting the stack) rather than failing init. A dedicated,
 * short-lived Pool is used and closed here so init's own teardown is unaffected.
 */
async function bootstrapPgSchema(uri: string, timeoutMs = 30000): Promise<boolean> {
  const { Pool } = await import('pg');
  const { ensureSchema, VECTORS_TABLE } = await import('../conformity/schema.js');

  const pool = new Pool({ connectionString: uri, max: 1, connectionTimeoutMillis: 3000 });
  const runner = {
    query: async (text: string, params?: unknown[]) => {
      const r = await pool.query(text, params as unknown[]);
      return { rows: r.rows };
    },
  };

  const deadline = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    // Readiness wait: retry SELECT 1 until it succeeds or we hit the deadline.
    let ready = false;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1');
        ready = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        await sleep(1000);
      }
    }
    if (!ready) {
      process.stderr.write(
        `[init] postgres: not reachable within ${Math.round(timeoutMs / 1000)}s ` +
          `(${lastErr}); skipping schema bootstrap.\n` +
          `       Start the stack, then run schema bootstrap on first sync.\n`,
      );
      return false;
    }

    await ensureSchema(runner);
    // HNSW + cosine ANN index, matching the store's `<=>` operator. Idempotent.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS cfm_vectors_embedding_hnsw ` +
        `ON ${VECTORS_TABLE} USING hnsw (embedding vector_cosine_ops);`,
    );
    process.stdout.write(`[init] postgres: schema + HNSW index ready\n`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[init] postgres: schema bootstrap failed — ${msg}\n`);
    return false;
  } finally {
    await pool.end().catch(() => {
      // best-effort close
    });
  }
}

/**
 * Pre-download the embedding model weights so the first sync runs fully offline.
 * Triggers the one-time weight fetch by embedding a trivial input. Best-effort:
 * a failure WARNS (e.g. offline at init time) but never fails init. Skipped when
 * `--no-model` is passed or CODEBASE_PKG_SKIP_MODEL_PREFETCH=1.
 */
async function prefetchModel(flags: Flags): Promise<void> {
  if (flags.noModel) {
    process.stdout.write(`[init] model: prefetch skipped (--no-model / CODEBASE_PKG_SKIP_MODEL_PREFETCH)\n`);
    return;
  }
  process.stdout.write(`[init] model: prefetching embedding weights (one-time download)…\n`);
  try {
    const { embed, CHOSEN_MODEL } = await import('../conformity/embed.js');
    await embed(['warmup']);
    process.stdout.write(`[init] model: ready${CHOSEN_MODEL ? ` (${CHOSEN_MODEL})` : ''}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[init] model: prefetch failed — ${msg}\n` +
        `       Continuing; the model will download on first sync (requires network then).\n`,
    );
  }
}

function printNextSteps(
  pm: string,
  mode: InstallMode,
  docker: DockerProvision | null,
): void {
  process.stdout.write(`\n[init] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  let n = 1;
  if (docker) {
    process.stdout.write(`  ${n++}. docker compose -f docker-compose.codebase-pkg.yml up -d\n`);
    process.stdout.write(
      `     Neo4j Bolt → ${docker.neo4j.uri}  |  ` +
        `Browser → http://localhost:${docker.neo4j.httpPort}  |  ` +
        `container ${docker.neo4j.containerName}\n`,
    );
    process.stdout.write(
      `     Postgres → ${docker.postgres.uri}  |  ` +
        `container ${docker.postgres.containerName}\n`,
    );
  } else {
    process.stdout.write(`  ${n++}. Ensure Neo4j is running on bolt://localhost:7687 (override via CODEBASE_PKG_NEO4J_URI)\n`);
  }
  process.stdout.write(`  ${n++}. Edit constraints.json with your architecture's invariants\n`);
  if (mode === 'local') {
    process.stdout.write(`  ${n++}. npx codebase-pkg seed\n`);
  } else {
    process.stdout.write(`  ${n++}. codebase-pkg seed\n`);
  }
  process.stdout.write(`  ${n++}. Start a Claude Code session; the MCP tools are available\n`);
  process.stdout.write(`\nInstall mode: ${mode}${pm !== 'unknown' ? `   |   package manager: ${pm}` : ''}\n`);
}

export async function runInit(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  // Install into the resolved root (--path/--root/CODEBASE_PKG_ROOT/cwd). Create
  // it if needed so init can target a directory that does not exist yet
  // (consistent with how init already creates the state dir). Skip creation on
  // dry-run so a preview never touches the filesystem.
  const cwd = resolveRoot(args);
  if (!flags.dryRun && !fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }
  const pm = detectPackageManager(cwd);

  process.stdout.write(`[init] codebase-pkg ${flags.dryRun ? '(dry-run) ' : ''}in ${cwd}\n\n`);

  // If a state file already exists, warn that init may not be the right command.
  const existing = readState(cwd);
  if (existing && !flags.force) {
    process.stderr.write(
      `[init] state.json already exists for this repo (version ${existing.version}).\n` +
        `       Use 'codebase-pkg upgrade' to update an existing install, or pass --force to re-init.\n`,
    );
    return 1;
  }

  const managed: ManagedFile[] = [];

  const runSkills = !flags.mcpOnly;
  const runMcp = !flags.skillsOnly;
  const runConstraints = !flags.mcpOnly && !flags.skillsOnly;

  if (runSkills) installSkills(cwd, flags, managed);
  if (runMcp) installMcp(cwd, flags, managed);
  if (runConstraints) installConstraints(cwd, flags, managed);
  const dockerConfig = flags.docker ? await installDocker(cwd, flags, managed) : null;

  if (!flags.dryRun) {
    const now = new Date().toISOString();
    const state: InstallState = {
      version: readPackageVersion(),
      installedAt: now,
      lastUpgradedAt: now,
      installMode: flags.installMode,
      cliPathAtInstall: getCliAbsolutePath(),
      managedFiles: managed,
      // Record the absolute install root so later teardown can warn if a
      // different root is resolved.
      root: cwd,
    };
    if (dockerConfig) {
      state.neo4j = dockerConfig.neo4j;
      state.postgres = dockerConfig.postgres;
    }
    // Explicit DB endpoints persist their `uri` so later teardown reuses them
    // without re-specifying. These override any docker-derived uri above, but
    // leave the docker-only sub-fields (containerName/ports/slug) as-is /
    // absent (they're optional). The override URI takes precedence.
    if (flags.neo4jUri) {
      state.neo4j = { ...(state.neo4j ?? {}), uri: flags.neo4jUri } as InstallState['neo4j'];
    }
    if (flags.pgUri) {
      state.postgres = { ...(state.postgres ?? {}), uri: flags.pgUri } as InstallState['postgres'];
    }
    writeState(cwd, state);
    process.stdout.write(`[init] wrote .codebase-pkg/state.json (tracks ${managed.length} managed file${managed.length === 1 ? '' : 's'})\n`);
  }

  // Bootstrap the conformity vector store schema once Postgres is reachable, and
  // pre-download the embedding model. Both are best-effort and skipped on
  // dry-run. Postgres bootstrap only attempts when we provisioned a DSN; init
  // does not start the container itself, so it may simply warn that the stack
  // isn't up yet.
  if (!flags.dryRun) {
    if (dockerConfig) await bootstrapPgSchema(dockerConfig.postgres.uri);
    await prefetchModel(flags);
  }

  if (!flags.dryRun) printNextSteps(pm, flags.installMode, dockerConfig);

  return 0;
}
