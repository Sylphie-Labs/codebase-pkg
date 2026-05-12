/**
 * initial-seed.ts -- One-time full codebase parse and PKG bootstrap.
 *
 * Walks the entire monorepo, extracts all TypeScript functions/types/imports,
 * creates the full node and edge set in the codebase PKG, then runs
 * integrity checks.
 *
 * Entry point: `npm run seed-pkg`
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseFiles, clearProjectCache } from '../sync/ast-parser.js';
import { runIntegrityChecks } from '../sync/integrity-checker.js';
import { writeLastSyncCommit } from '../sync/git-diff.js';
import { getDriver, closeDriver } from '../mcp-server/neo4j-client.js';
import type { ParsedFile, ParsedImport } from '../sync/ast-parser.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

/**
 * Packages to index. Defaults auto-detect common layouts: `src/` if it exists
 * at the repo root (single-package projects), and any direct subdirectories of
 * `apps/` and `packages/` (monorepos). Override via the CODEBASE_PKG_PACKAGES
 * env var (JSON array of {name, dir} objects) to specify exactly which package
 * roots to scan.
 */
function getWatchedPackages(): Array<{ name: string; dir: string }> {
  const envJson = process.env.CODEBASE_PKG_PACKAGES;
  if (envJson) {
    try {
      return JSON.parse(envJson);
    } catch {
      console.warn('[seed] CODEBASE_PKG_PACKAGES JSON invalid; falling back to auto-detect.');
    }
  }

  const detected: Array<{ name: string; dir: string }> = [];

  // Single-package layout: <repo>/src/
  if (fs.existsSync(path.join(REPO_ROOT, 'src'))) {
    detected.push({ name: 'app', dir: 'src' });
  }

  // Monorepo layout: <repo>/apps/* and <repo>/packages/*
  for (const parent of ['apps', 'packages']) {
    const parentPath = path.join(REPO_ROOT, parent);
    if (!fs.existsSync(parentPath)) continue;
    try {
      for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subSrc = path.join(parentPath, entry.name, 'src');
        if (fs.existsSync(subSrc)) {
          detected.push({ name: entry.name, dir: `${parent}/${entry.name}/src` });
        }
      }
    } catch {
      // ignore unreadable parent
    }
  }

  if (detected.length === 0) {
    // Last-ditch fallback: scan the repo root itself.
    detected.push({ name: 'root', dir: '.' });
  }
  return detected;
}

const WATCHED_PACKAGES: Array<{ name: string; dir: string }> = getWatchedPackages();

const EXCLUDE_PATTERNS = [
  /node_modules/,
  /\/dist\//,
  /\.d\.ts$/,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.spec\.tsx$/,
  /\.test\.tsx$/,
];

const BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name).replace(/\\/g, '/');
      const relativePath = fullPath.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === '.git' ||
          entry.name === '.cache'
        ) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const isTs = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
        if (!isTs) continue;
        if (EXCLUDE_PATTERNS.some(rx => rx.test(relativePath))) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

/**
 * Workspace package → source directory map. Built from WATCHED_PACKAGES.
 * Set CODEBASE_PKG_WORKSPACE_SCOPE (e.g. "@your-org") to resolve scoped
 * intra-monorepo imports; leave unset for non-workspace repos.
 */
const WORKSPACE_SCOPE: string | null = process.env.CODEBASE_PKG_WORKSPACE_SCOPE ?? null;
const PACKAGE_SOURCE_DIRS: Record<string, string> = WORKSPACE_SCOPE
  ? Object.fromEntries(WATCHED_PACKAGES.map(p => [`${WORKSPACE_SCOPE}/${p.name}`, p.dir]))
  : {};

function resolveImportTarget(sourceDir: string, moduleSpecifier: string): string | null {
  const repoRoot = REPO_ROOT.replace(/\\/g, '/');

  // Handle workspace-scoped imports when a scope is configured.
  if (WORKSPACE_SCOPE && moduleSpecifier.startsWith(`${WORKSPACE_SCOPE}/`)) {
    const sortedKeys = Object.keys(PACKAGE_SOURCE_DIRS).sort((a, b) => b.length - a.length);
    for (const pkg of sortedKeys) {
      if (moduleSpecifier === pkg || moduleSpecifier.startsWith(pkg + '/')) {
        const basePath = `${repoRoot}/${PACKAGE_SOURCE_DIRS[pkg]}`;
        const subPath = moduleSpecifier.slice(pkg.length + 1);
        if (subPath) {
          const fullPath = `${basePath}/${subPath}`;
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
            return fullPath;
          }
          const parentDir = path.dirname(`${basePath}/${subPath}`).replace(/\\/g, '/');
          if (fs.existsSync(parentDir)) return parentDir;
        }
        return basePath;
      }
    }
    return null;
  }

  // Handle relative imports
  if (moduleSpecifier.startsWith('.')) {
    const resolved = path.resolve(sourceDir, moduleSpecifier).replace(/\\/g, '/');
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    const targetDir = path.dirname(resolved).replace(/\\/g, '/');
    if (targetDir !== sourceDir && fs.existsSync(targetDir)) {
      return targetDir;
    }
    return null;
  }

  // External package — skip
  return null;
}

// ---------------------------------------------------------------------------
// Graph schema setup
// ---------------------------------------------------------------------------

async function createSchemaIndexes(driver: import('neo4j-driver').Driver): Promise<void> {
  console.log('[seed] Creating schema indexes and constraints...');

  const session = driver.session({ defaultAccessMode: 'WRITE' });

  const statements = [
    'CREATE CONSTRAINT service_name_unique IF NOT EXISTS FOR (s:Service) REQUIRE s.name IS UNIQUE',
    'CREATE CONSTRAINT module_filepath_unique IF NOT EXISTS FOR (m:Module) REQUIRE m.filePath IS UNIQUE',
    'CREATE CONSTRAINT file_filepath_unique IF NOT EXISTS FOR (f:File) REQUIRE f.filePath IS UNIQUE',
    'CREATE CONSTRAINT change_hash_unique IF NOT EXISTS FOR (c:Change) REQUIRE c.hash IS UNIQUE',

    'CREATE INDEX function_filepath_name IF NOT EXISTS FOR (f:Function) ON (f.filePath, f.name)',
    'CREATE INDEX type_filepath_name IF NOT EXISTS FOR (t:Type) ON (t.filePath, t.name)',

    'CREATE INDEX function_domain IF NOT EXISTS FOR (f:Function) ON (f.domain)',
    'CREATE INDEX function_name IF NOT EXISTS FOR (f:Function) ON (f.name)',
    'CREATE INDEX type_name IF NOT EXISTS FOR (t:Type) ON (t.name)',
    'CREATE INDEX type_kind IF NOT EXISTS FOR (t:Type) ON (t.kind)',
    'CREATE INDEX module_package IF NOT EXISTS FOR (m:Module) ON (m.packageName)',
    'CREATE INDEX function_hash IF NOT EXISTS FOR (f:Function) ON (f.contentHash)',
    'CREATE INDEX type_hash IF NOT EXISTS FOR (t:Type) ON (t.contentHash)',
    'CREATE INDEX file_name IF NOT EXISTS FOR (f:File) ON (f.fileName)',
    'CREATE INDEX file_extension IF NOT EXISTS FOR (f:File) ON (f.extension)',
  ];

  for (const stmt of statements) {
    try {
      await session.run(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists') && !msg.includes('An equivalent')) {
        process.stderr.write(`[seed] WARNING: schema stmt failed — ${msg}\n`);
      }
    }
  }

  await session.close();
  console.log('[seed] Schema indexes ready.');
}

// ---------------------------------------------------------------------------
// Node creation helpers
// ---------------------------------------------------------------------------

async function createServiceNodes(driver: import('neo4j-driver').Driver): Promise<void> {
  console.log('[seed] Creating Service nodes...');
  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const pkg of WATCHED_PACKAGES) {
      await tx.run(
        `
        MERGE (s:Service {name: $name})
        SET s.directory = $directory,
            s.updatedAt = timestamp()
        `,
        { name: pkg.name, directory: pkg.dir }
      );
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }

  console.log(`[seed] Created ${WATCHED_PACKAGES.length} Service nodes.`);
}

async function createModuleNodes(
  allFiles: string[],
  driver: import('neo4j-driver').Driver
): Promise<void> {
  console.log('[seed] Creating Module nodes...');

  const dirSet = new Set<string>();
  for (const f of allFiles) {
    dirSet.add(path.dirname(f).replace(/\\/g, '/'));
  }

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  let created = 0;

  for (const dir of dirSet) {
    const relativePath = dir.replace(REPO_ROOT.replace(/\\/g, '/') + '/', '');
    const dirName = path.basename(dir);

    const pkg = WATCHED_PACKAGES.find(p =>
      relativePath.startsWith(p.dir + '/') || relativePath === p.dir
    );
    const packageName = pkg?.name ?? 'unknown';

    const tx = session.beginTransaction();
    try {
      await tx.run(
        `
        MERGE (m:Module {filePath: $filePath})
        SET m.name        = $name,
            m.packageName = $packageName,
            m.updatedAt   = timestamp()
        `,
        { filePath: dir, name: dirName, packageName }
      );

      if (pkg) {
        await tx.run(
          `
          MATCH (m:Module {filePath: $filePath})
          MATCH (s:Service {name: $packageName})
          MERGE (m)-[:BELONGS_TO]->(s)
          `,
          { filePath: dir, packageName }
        );
      }

      await tx.commit();
      created++;
    } catch (err) {
      await tx.rollback();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[seed] WARNING: Module node failed for ${dir} — ${msg}\n`);
    }
  }

  await session.close();
  console.log(`[seed] Created ${created} Module nodes.`);
}

async function writeParsedBatch(
  batch: ParsedFile[],
  driver: import('neo4j-driver').Driver
): Promise<{ functions: number; types: number; errors: number }> {
  let functions = 0;
  let types = 0;
  let errors = 0;

  const session = driver.session({ defaultAccessMode: 'WRITE' });

  for (const parsedFile of batch) {
    const dirPath = path.dirname(parsedFile.filePath).replace(/\\/g, '/');
    const tx = session.beginTransaction();

    try {
      await tx.run(
        `MERGE (m:Module {filePath: $filePath}) SET m.updatedAt = timestamp()`,
        { filePath: dirPath }
      );

      // Create File node and link to Module
      await tx.run(
        `
        MERGE (f:File {filePath: $filePath})
        SET f.fileName   = $fileName,
            f.extension  = $extension,
            f.lineCount  = $lineCount,
            f.updatedAt  = timestamp()
        WITH f
        MATCH (m:Module {filePath: $dirPath})
        MERGE (m)-[:CONTAINS_FILE]->(f)
        `,
        {
          filePath: parsedFile.filePath,
          dirPath,
          fileName: parsedFile.fileName,
          extension: parsedFile.extension,
          lineCount: parsedFile.lineCount,
        }
      );

      for (const fn of parsedFile.functions) {
        await tx.run(
          `
          MERGE (f:Function {filePath: $filePath, name: $name})
          SET f.lineNumber  = $lineNumber,
              f.endLine     = $endLine,
              f.returnType  = $returnType,
              f.jsDoc       = $jsDoc,
              f.isExported  = $isExported,
              f.isAsync     = $isAsync,
              f.args        = $args,
              f.decorators  = $decorators,
              f.httpMethod  = $httpMethod,
              f.routePath    = $routePath,
              f.contentHash  = $contentHash,
              f.domain       = coalesce(f.domain, 'unclassified'),
              f.updatedAt    = timestamp()
          WITH f
          MATCH (m:Module {filePath: $dirPath})
          MERGE (m)-[:CONTAINS]->(f)
          WITH f
          MATCH (file:File {filePath: $filePath})
          MERGE (file)-[:DEFINES]->(f)
          `,
          {
            filePath: fn.filePath,
            name: fn.name,
            lineNumber: fn.lineNumber,
            endLine: fn.endLine,
            returnType: fn.returnType,
            jsDoc: fn.jsDoc,
            isExported: fn.isExported,
            isAsync: fn.isAsync,
            args: JSON.stringify(fn.args),
            decorators: fn.decorators.length > 0 ? JSON.stringify(fn.decorators) : null,
            httpMethod: fn.httpMethod ?? null,
            routePath: fn.routePath ?? null,
            contentHash: fn.contentHash,
            dirPath,
          }
        );

        if (fn.bodyText) {
          await tx.run(
            `
            MATCH (f:Function {filePath: $filePath, name: $name})
            MERGE (f)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
            SET cb.bodyText  = $bodyText,
                cb.updatedAt = timestamp()
            `,
            { filePath: fn.filePath, name: fn.name, bodyText: fn.bodyText.slice(0, 8000) }
          );
        }

        functions++;
      }

      for (const ty of parsedFile.types) {
        await tx.run(
          `
          MERGE (t:Type {filePath: $filePath, name: $name})
          SET t.lineNumber       = $lineNumber,
              t.kind             = $kind,
              t.properties       = $properties,
              t.comment          = $comment,
              t.decorators       = $decorators,
              t.extendsType      = $extendsType,
              t.implementsTypes  = $implementsTypes,
              t.contentHash      = $contentHash,
              t.updatedAt        = timestamp()
          WITH t
          MATCH (m:Module {filePath: $dirPath})
          MERGE (m)-[:CONTAINS]->(t)
          WITH t
          MATCH (file:File {filePath: $filePath})
          MERGE (file)-[:DEFINES]->(t)
          `,
          {
            filePath: ty.filePath,
            name: ty.name,
            lineNumber: ty.lineNumber,
            kind: ty.kind,
            properties: JSON.stringify(ty.properties),
            comment: ty.comment,
            decorators: ty.decorators.length > 0 ? JSON.stringify(ty.decorators) : null,
            extendsType: ty.extends ?? null,
            implementsTypes: ty.implements.length > 0 ? JSON.stringify(ty.implements) : null,
            contentHash: ty.contentHash,
            dirPath,
          }
        );

        if (ty.bodyText) {
          await tx.run(
            `
            MATCH (t:Type {filePath: $filePath, name: $name})
            MERGE (t)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
            SET cb.bodyText  = $bodyText,
                cb.updatedAt = timestamp()
            `,
            { filePath: ty.filePath, name: ty.name, bodyText: ty.bodyText.slice(0, 8000) }
          );
        }
        types++;
      }

      // IMPORTS edges
      for (const imp of parsedFile.imports) {
        const targetPath = resolveImportTarget(dirPath, imp.moduleSpecifier);
        if (!targetPath) continue;

        await tx.run(
          `
          MATCH (source:Module {filePath: $dirPath})
          MATCH (target:Module {filePath: $targetPath})
          MERGE (source)-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->(target)
          SET e.importedNames = $importedNames,
              e.fromFile      = $fromFile,
              e.updatedAt     = timestamp()
          `,
          {
            dirPath,
            targetPath,
            moduleSpecifier: imp.moduleSpecifier,
            importedNames: imp.importedNames,
            fromFile: parsedFile.filePath,
          }
        );
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[seed] WARNING: batch write failed for ${parsedFile.filePath} — ${msg}\n`);
      errors++;
    }
  }

  await session.close();
  return { functions, types, errors };
}

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------

async function runSeed(): Promise<void> {
  const startTime = Date.now();
  const driver = getDriver();

  console.log('='.repeat(60));
  console.log('[seed] Codebase PKG initial seed starting');
  console.log('='.repeat(60));

  // Step 1: Schema
  await createSchemaIndexes(driver);

  // Step 2: Discover files
  console.log('\n[seed] Step 2/8: Discovering TypeScript files...');
  const allFiles: string[] = [];
  for (const pkg of WATCHED_PACKAGES) {
    const pkgDir = path.join(REPO_ROOT, pkg.dir).replace(/\\/g, '/');
    if (!fs.existsSync(pkgDir)) {
      console.warn(`[seed] Package directory not found, skipping: ${pkgDir}`);
      continue;
    }
    const files = collectTsFiles(pkgDir);
    console.log(`       ${pkg.name.padEnd(25)} ${files.length} files`);
    allFiles.push(...files);
  }
  console.log(`\n       Total files: ${allFiles.length}`);

  // Step 3: Service + Module nodes
  console.log('\n[seed] Step 3/8: Creating structural nodes (Service, Module)...');
  await createServiceNodes(driver);
  await createModuleNodes(allFiles, driver);

  // Step 4: Parse all files in batches
  console.log('\n[seed] Step 4/8: Parsing TypeScript files...');
  const parseStart = Date.now();
  let totalFunctions = 0;
  let totalTypes = 0;
  let totalErrors = 0;
  let filesProcessed = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allFiles.length / BATCH_SIZE);
    const pct = Math.round((i / allFiles.length) * 100);

    process.stdout.write(
      `\r       Batch ${batchNum}/${totalBatches} (${pct}%) — ${filesProcessed} files done...`
    );

    const parsedFiles = parseFiles(batch);
    const writeResult = await writeParsedBatch(parsedFiles, driver);
    totalFunctions += writeResult.functions;
    totalTypes += writeResult.types;
    totalErrors += writeResult.errors;
    filesProcessed += batch.length;

    if (batchNum % 5 === 0) clearProjectCache();
  }

  clearProjectCache();
  process.stdout.write('\n');

  console.log(`       Files parsed:        ${allFiles.length}`);
  console.log(`       Functions created:   ${totalFunctions}`);
  console.log(`       Types created:       ${totalTypes}`);
  console.log(`       File errors:         ${totalErrors}`);
  console.log(`       Parse time:          ${((Date.now() - parseStart) / 1000).toFixed(1)}s`);

  // Step 5: Relationship edges
  console.log('\n[seed] Step 5/8: Creating relationship edges (CALLS, USES_TYPE, EXTENDS, IMPLEMENTS, INJECTS)...');
  const relStart = Date.now();
  let callsCreated = 0;
  let usesTypeCreated = 0;
  let hierarchyCreated = 0;
  let injectsCreated = 0;

  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const parsedFiles = parseFiles(batch);

    for (const parsedFile of parsedFiles) {
      const session2 = driver.session({ defaultAccessMode: 'WRITE' });
      const tx2 = session2.beginTransaction();
      try {
        for (const fn of parsedFile.functions) {
          for (const callee of fn.callees) {
            try {
              const res = await tx2.run(
                `MATCH (caller:Function {filePath: $filePath, name: $callerName})
                 MATCH (callee:Function)
                 WHERE callee.name = $calleeName OR callee.name ENDS WITH $calleeSuffix
                 WITH caller, callee LIMIT 1
                 MERGE (caller)-[:CALLS]->(callee)
                 RETURN count(*) AS c`,
                { filePath: fn.filePath, callerName: fn.name, calleeName: callee, calleeSuffix: '.' + callee }
              );
              callsCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip unresolvable */ }
          }
          for (const typeName of fn.typeRefs) {
            try {
              const res = await tx2.run(
                `MATCH (f:Function {filePath: $filePath, name: $funcName})
                 MATCH (t:Type {name: $typeName})
                 WITH f, t LIMIT 1
                 MERGE (f)-[:USES_TYPE]->(t)
                 RETURN count(*) AS c`,
                { filePath: fn.filePath, funcName: fn.name, typeName }
              );
              usesTypeCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
        }

        for (const ty of parsedFile.types) {
          if (ty.extends) {
            try {
              const res = await tx2.run(
                `MATCH (child:Type {filePath: $filePath, name: $childName})
                 MATCH (parent:Type {name: $parentName})
                 WITH child, parent LIMIT 1
                 MERGE (child)-[:EXTENDS]->(parent)
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, childName: ty.name, parentName: ty.extends }
              );
              hierarchyCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
          for (const ifaceName of ty.implements) {
            try {
              const res = await tx2.run(
                `MATCH (cls:Type {filePath: $filePath, name: $className})
                 MATCH (iface:Type {name: $ifaceName})
                 WITH cls, iface LIMIT 1
                 MERGE (cls)-[:IMPLEMENTS]->(iface)
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, className: ty.name, ifaceName }
              );
              hierarchyCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
          for (const param of ty.constructorParams) {
            const targetType = param.injectToken ?? param.type;
            if (targetType === 'unknown' || targetType.length > 80) continue;
            try {
              const res = await tx2.run(
                `MATCH (cls:Type {filePath: $filePath, name: $className})
                 MATCH (dep:Type {name: $depName})
                 WITH cls, dep LIMIT 1
                 MERGE (cls)-[r:INJECTS]->(dep)
                 SET r.paramName = $paramName
                 RETURN count(*) AS c`,
                { filePath: ty.filePath, className: ty.name, depName: targetType, paramName: param.name }
              );
              injectsCreated += res.records[0]?.get('c')?.toNumber?.() ?? 0;
            } catch { /* skip */ }
          }
        }

        await tx2.commit();
      } catch (err) {
        await tx2.rollback();
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[seed] WARNING: relationship pass failed for ${parsedFile.filePath} — ${msg}\n`);
      }
      await session2.close();
    }

    clearProjectCache();
  }

  console.log(`       CALLS edges:         ${callsCreated}`);
  console.log(`       USES_TYPE edges:     ${usesTypeCreated}`);
  console.log(`       Hierarchy edges:     ${hierarchyCreated}`);
  console.log(`       INJECTS edges:       ${injectsCreated}`);
  console.log(`       Relationship time:   ${((Date.now() - relStart) / 1000).toFixed(1)}s`);

  // Step 6: Integrity check
  console.log('\n[seed] Step 6/8: Running integrity checks...');
  const integrityResult = await runIntegrityChecks();

  // Step 7: Write .last-sync-commit
  console.log('\n[seed] Step 7/8: Recording sync cursor...');
  const currentCommit = execSync('git rev-parse HEAD', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
  writeLastSyncCommit(currentCommit);

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('[seed] Initial seed complete');
  console.log('='.repeat(60));
  console.log(`       Commit:              ${currentCommit.slice(0, 8)}`);
  console.log(`       Total functions:     ${totalFunctions}`);
  console.log(`       Total types:         ${totalTypes}`);
  console.log(`       Parse errors:        ${totalErrors}`);
  console.log(`       Integrity passed:    ${integrityResult.passed}`);
  console.log(`       Total time:          ${totalTime.toFixed(1)}s`);

  if (!integrityResult.passed) {
    console.error('\n[seed] WARNING: integrity checks did not fully pass. See above for details.');
  }

  await closeDriver();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed().catch(err => {
    console.error('[seed] Fatal error:', err instanceof Error ? err.message : String(err));
    closeDriver().finally(() => process.exit(1));
  });
}

export { runSeed };
