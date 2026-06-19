/**
 * init.ts -- `codebase-pkg init` command.
 *
 * Bootstraps a consumer's project to use codebase-pkg. Installs the skill
 * templates, patches `.mcp.json`, writes a starter `constraints.json` from
 * the bundled example, optionally writes a `docker-compose.codebase-pkg.yml`
 * for the Neo4j service.
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
  findFreePort,
  type Neo4jInstanceConfig,
} from './neo4j-config.js';

/** Subset of Neo4jInstanceConfig persisted to state.json (no user/password). */
type DockerInstanceConfig = Pick<
  Neo4jInstanceConfig,
  'uri' | 'containerName' | 'httpPort' | 'boltPort' | 'slug'
>;

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
  skillsOnly: boolean;
  mcpOnly: boolean;
  installMode: InstallMode;
};

function parseFlags(args: string[]): Flags {
  const local = args.includes('--local');
  const global = args.includes('--global');
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    docker: args.includes('--docker'),
    skillsOnly: args.includes('--skills-only'),
    mcpOnly: args.includes('--mcp-only'),
    installMode: local ? 'local' : global ? 'global' : 'global',
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

async function installDocker(
  cwd: string,
  flags: Flags,
  managed: ManagedFile[],
): Promise<DockerInstanceConfig> {
  const destRel = 'docker-compose.codebase-pkg.yml';
  const destPath = path.join(cwd, destRel);

  // Derive a per-instance slug, then deterministic base ports, then scan for
  // free host ports so multiple repos can run their own Neo4j side by side.
  const slug = deriveInstanceSlug(cwd);
  const base = deriveBasePorts(slug);
  const httpPort = await findFreePort(base.http);
  let boltPort = await findFreePort(base.bolt);
  // The two scans run independently and could land on the same port; bump bolt.
  if (boltPort === httpPort) boltPort = await findFreePort(boltPort + 1);

  const containerName = `codebase-pkg-neo4j-${slug}`;
  const projectName = `codebase-pkg-${slug}`;
  const volSlug = slug.replace(/-/g, '_');
  const dataVolume = `codebase_pkg_neo4j_data_${volSlug}`;
  const logsVolume = `codebase_pkg_neo4j_logs_${volSlug}`;

  const content =
    `# Generated by 'codebase-pkg init --docker'. Edit as needed.\n` +
    `name: ${projectName}\n` +
    `services:\n` +
    `  codebase-pkg-neo4j:\n` +
    `    image: neo4j:5-community\n` +
    `    container_name: ${containerName}\n` +
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
    `\n` +
    `volumes:\n` +
    `  ${dataVolume}:\n` +
    `  ${logsVolume}:\n`;

  const result = writeFileContent(destPath, content, flags);
  process.stdout.write(`[init] docker: ${result} ${destRel}\n`);
  if (result === 'wrote' || (result === 'skipped' && fs.existsSync(destPath))) {
    managed.push({ path: destRel, installedHash: hashFile(destPath) });
  }

  return {
    uri: `bolt://localhost:${boltPort}`,
    containerName,
    httpPort,
    boltPort,
    slug,
  };
}

function printNextSteps(
  pm: string,
  mode: InstallMode,
  docker: DockerInstanceConfig | null,
): void {
  process.stdout.write(`\n[init] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  let n = 1;
  if (docker) {
    process.stdout.write(`  ${n++}. docker compose -f docker-compose.codebase-pkg.yml up -d\n`);
    process.stdout.write(
      `     Neo4j Bolt → ${docker.uri}  |  ` +
        `Browser → http://localhost:${docker.httpPort}  |  ` +
        `container ${docker.containerName}\n`,
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
  const cwd = process.cwd();
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
    };
    if (dockerConfig) state.neo4j = dockerConfig;
    writeState(cwd, state);
    process.stdout.write(`[init] wrote .codebase-pkg/state.json (tracks ${managed.length} managed file${managed.length === 1 ? '' : 's'})\n`);
  }

  if (!flags.dryRun) printNextSteps(pm, flags.installMode, dockerConfig);

  return 0;
}
