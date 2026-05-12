/**
 * setup.ts -- `codebase-pkg setup` command.
 *
 * Bootstraps a consumer's project to use codebase-pkg. Runs from the consumer's
 * cwd (the repo root) and installs:
 *
 *   1. Skill templates from <pkg>/template/.claude/skills/ into <cwd>/.claude/skills/
 *   2. The codebase-pkg MCP server stanza into <cwd>/.mcp.json (preserves other servers)
 *   3. constraints.json from the example, if not already present
 *   4. (optional, --docker) docker-compose.codebase-pkg.yml for the Neo4j service
 *
 * Idempotent: skips any file that already exists at the destination, unless --force
 * is passed. With --dry-run, prints what would happen without writing anything.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

type Flags = {
  dryRun: boolean;
  force: boolean;
  docker: boolean;
  skillsOnly: boolean;
  mcpOnly: boolean;
};

function parseFlags(args: string[]): Flags {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    docker: args.includes('--docker'),
    skillsOnly: args.includes('--skills-only'),
    mcpOnly: args.includes('--mcp-only'),
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
  // dist/cli/setup.js → ../../  is the package root that contains template/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
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

function copyFile(src: string, dest: string, flags: Flags): 'wrote' | 'skipped' | 'would-write' {
  if (fs.existsSync(dest) && !flags.force) return 'skipped';
  if (flags.dryRun) return 'would-write';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return 'wrote';
}

function installSkills(cwd: string, flags: Flags): void {
  const templateRoot = path.join(getPackageRoot(), 'template', '.claude', 'skills');
  if (!fs.existsSync(templateRoot)) {
    process.stderr.write(`[setup] no skill templates bundled (looked at ${templateRoot}); skipping.\n`);
    return;
  }
  const files = listFilesRecursive(templateRoot);
  if (files.length === 0) {
    process.stderr.write(`[setup] template/.claude/skills is empty; skipping.\n`);
    return;
  }
  process.stdout.write(`[setup] skills:\n`);
  for (const src of files) {
    const rel = path.relative(templateRoot, src);
    const dest = path.join(cwd, '.claude', 'skills', rel);
    const result = copyFile(src, dest, flags);
    process.stdout.write(`  ${result.padEnd(12)} .claude/skills/${rel}\n`);
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

function installMcp(cwd: string, flags: Flags): void {
  const mcpPath = path.join(cwd, '.mcp.json');
  const stanza: McpStanza = {
    command: 'npx',
    args: ['-y', '@anthrorg-infra/codebase-pkg', 'mcp-server'],
    env: {
      // Empty by default — consumer sets CODEBASE_PKG_* env vars themselves
      // or via their shell. Documented in README.
    },
  };

  let existing: McpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      process.stderr.write(`[setup] could not parse existing .mcp.json; refusing to overwrite. Edit manually.\n`);
      return;
    }
  }
  existing.mcpServers = existing.mcpServers ?? {};

  if (existing.mcpServers['codebase-pkg'] && !flags.force) {
    process.stdout.write(`[setup] mcp: skipped .mcp.json (codebase-pkg server already registered; use --force to overwrite)\n`);
    return;
  }

  existing.mcpServers['codebase-pkg'] = stanza;
  const out = JSON.stringify(existing, null, 2) + '\n';

  if (flags.dryRun) {
    process.stdout.write(`[setup] mcp: would-write .mcp.json with codebase-pkg server stanza\n`);
    return;
  }
  fs.writeFileSync(mcpPath, out, 'utf8');
  process.stdout.write(`[setup] mcp: wrote .mcp.json with codebase-pkg server stanza\n`);
}

function installConstraints(cwd: string, flags: Flags): void {
  const examplePath = path.join(getPackageRoot(), 'constraints.example.json');
  const destPath = path.join(cwd, 'constraints.json');

  if (!fs.existsSync(examplePath)) {
    process.stderr.write(`[setup] no constraints.example.json bundled; skipping.\n`);
    return;
  }
  if (fs.existsSync(destPath) && !flags.force) {
    process.stdout.write(`[setup] constraints: skipped constraints.json (already exists)\n`);
    return;
  }
  if (flags.dryRun) {
    process.stdout.write(`[setup] constraints: would-write constraints.json from example\n`);
    return;
  }
  fs.copyFileSync(examplePath, destPath);
  process.stdout.write(`[setup] constraints: wrote constraints.json from example\n`);
}

function installDocker(cwd: string, flags: Flags): void {
  const destPath = path.join(cwd, 'docker-compose.codebase-pkg.yml');
  const content =
    `# Generated by 'codebase-pkg setup --docker'. Edit as needed.\n` +
    `services:\n` +
    `  codebase-pkg-neo4j:\n` +
    `    image: neo4j:5-community\n` +
    `    container_name: codebase-pkg-neo4j\n` +
    `    ports:\n` +
    `      - "7474:7474"   # HTTP browser\n` +
    `      - "7687:7687"   # Bolt protocol\n` +
    `    environment:\n` +
    `      NEO4J_AUTH: neo4j/codebase-pkg-local\n` +
    `      NEO4J_PLUGINS: '["apoc"]'\n` +
    `      NEO4J_server_memory_heap_initial__size: 512m\n` +
    `      NEO4J_server_memory_heap_max__size: 2G\n` +
    `      NEO4J_server_memory_pagecache_size: 1G\n` +
    `    volumes:\n` +
    `      - codebase_pkg_neo4j_data:/data\n` +
    `      - codebase_pkg_neo4j_logs:/logs\n` +
    `    restart: unless-stopped\n` +
    `\n` +
    `volumes:\n` +
    `  codebase_pkg_neo4j_data:\n` +
    `  codebase_pkg_neo4j_logs:\n`;

  if (fs.existsSync(destPath) && !flags.force) {
    process.stdout.write(`[setup] docker: skipped docker-compose.codebase-pkg.yml (already exists)\n`);
    return;
  }
  if (flags.dryRun) {
    process.stdout.write(`[setup] docker: would-write docker-compose.codebase-pkg.yml\n`);
    return;
  }
  fs.writeFileSync(destPath, content, 'utf8');
  process.stdout.write(`[setup] docker: wrote docker-compose.codebase-pkg.yml\n`);
}

function printNextSteps(pm: string, didDocker: boolean): void {
  process.stdout.write(`\n[setup] Done.\n\n`);
  process.stdout.write(`Next steps:\n`);
  if (didDocker) {
    process.stdout.write(`  1. docker compose -f docker-compose.codebase-pkg.yml up -d\n`);
    process.stdout.write(`  2. Edit constraints.json with your architecture's invariants\n`);
    process.stdout.write(`  3. npx codebase-pkg seed\n`);
    process.stdout.write(`  4. Start a Claude Code session; the MCP tools are available\n`);
  } else {
    process.stdout.write(`  1. Ensure Neo4j is running on bolt://localhost:7687 (override via CODEBASE_PKG_NEO4J_URI)\n`);
    process.stdout.write(`  2. Edit constraints.json with your architecture's invariants\n`);
    process.stdout.write(`  3. npx codebase-pkg seed\n`);
    process.stdout.write(`  4. Start a Claude Code session; the MCP tools are available\n`);
  }
  if (pm === 'unknown') {
    process.stdout.write(`\nNote: could not detect your package manager from lockfiles.\n`);
  } else {
    process.stdout.write(`\nDetected package manager: ${pm}\n`);
  }
}

export async function runSetup(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const cwd = process.cwd();
  const pm = detectPackageManager(cwd);

  process.stdout.write(`[setup] codebase-pkg ${flags.dryRun ? '(dry-run)' : ''} in ${cwd}\n\n`);

  const runSkills = !flags.mcpOnly;
  const runMcp = !flags.skillsOnly;
  const runConstraints = !flags.mcpOnly && !flags.skillsOnly;

  if (runSkills) installSkills(cwd, flags);
  if (runMcp) installMcp(cwd, flags);
  if (runConstraints) installConstraints(cwd, flags);
  if (flags.docker) installDocker(cwd, flags);

  if (!flags.dryRun) printNextSteps(pm, flags.docker);

  return 0;
}
