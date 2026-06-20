/**
 * mutation-builder.ts -- Convert a graph diff changeset into executable Cypher.
 *
 * Takes the structured Changeset from graph-differ and produces an array of
 * {cypher, params} pairs that can be run inside a single Neo4j write transaction.
 *
 * Conventions:
 * - MERGE on (filePath, name) for Function and Type nodes — idempotent.
 * - DETACH DELETE for removals — cleans up dangling edges automatically.
 * - MERGE for IMPORTS edges keyed on (fromFile, moduleSpecifier).
 * - All property values are passed as params, never interpolated.
 */

import * as path from 'path';
import type { Changeset, NodeDelete, EdgeAdd, EdgeRemove } from './graph-differ.js';
import type { ParsedFunction, ParsedType, ParsedFile } from './ast-parser.js';
import {
  resolveImportTarget,
  resolvePythonImportTarget,
  packageNameForDir,
} from './import-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CypherStatement {
  cypher: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Function node mutations
// ---------------------------------------------------------------------------

function buildFunctionCreate(fn: ParsedFunction, importedNames: ReadonlySet<string>): CypherStatement[] {
  const stmts: CypherStatement[] = [];
  const dirPath = path.dirname(fn.filePath).replace(/\\/g, '/');

  stmts.push({
    cypher: `
      MERGE (f:Function {filePath: $filePath, name: $name})
      SET f.lineNumber   = $lineNumber,
          f.endLine      = $endLine,
          f.returnType   = $returnType,
          f.jsDoc        = $jsDoc,
          f.isExported   = $isExported,
          f.isAsync      = $isAsync,
          f.domain       = coalesce(f.domain, 'unclassified'),
          f.args         = $args,
          f.decorators   = $decorators,
          f.httpMethod   = $httpMethod,
          f.routePath    = $routePath,
          f.contentHash  = $contentHash,
          f.updatedAt    = timestamp()
      WITH f
      MERGE (m:Module {filePath: $dirPath})
      ON CREATE SET m.name        = $dirName,
                    m.packageName = $pkgName,
                    m.updatedAt   = timestamp()
      MERGE (m)-[:CONTAINS]->(f)
      WITH f
      MATCH (file:File {filePath: $filePath})
      MERGE (file)-[:DEFINES]->(f)
    `.trim(),
    params: {
      filePath: fn.filePath,
      dirPath,
      dirName: path.basename(dirPath),
      pkgName: packageNameForDir(dirPath),
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
    },
  });

  if (fn.bodyText) {
    stmts.push({
      cypher: `
        MATCH (f:Function {filePath: $filePath, name: $name})
        MERGE (f)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
        SET cb.bodyText  = $bodyText,
            cb.updatedAt = timestamp()
      `.trim(),
      params: {
        filePath: fn.filePath,
        name: fn.name,
        bodyText: fn.bodyText.slice(0, 8000),
      },
    });
  }

  stmts.push(...buildCallsEdges(fn.filePath, fn.name, fn.callees, importedNames));
  stmts.push(...buildUsesTypeEdges(fn.filePath, fn.name, fn.typeRefs));

  return stmts;
}

function buildFunctionUpdate(fn: ParsedFunction, _changedFields: string[], importedNames: ReadonlySet<string>): CypherStatement[] {
  return buildFunctionCreate(fn, importedNames);
}

// ---------------------------------------------------------------------------
// Type node mutations
// ---------------------------------------------------------------------------

function buildTypeCreate(ty: ParsedType): CypherStatement[] {
  const stmts: CypherStatement[] = [];
  const dirPath = path.dirname(ty.filePath).replace(/\\/g, '/');

  stmts.push({
    cypher: `
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
      MERGE (m:Module {filePath: $dirPath})
      ON CREATE SET m.name        = $dirName,
                    m.packageName = $pkgName,
                    m.updatedAt   = timestamp()
      MERGE (m)-[:CONTAINS]->(t)
      WITH t
      MATCH (file:File {filePath: $filePath})
      MERGE (file)-[:DEFINES]->(t)
    `.trim(),
    params: {
      filePath: ty.filePath,
      dirPath,
      dirName: path.basename(dirPath),
      pkgName: packageNameForDir(dirPath),
      name: ty.name,
      lineNumber: ty.lineNumber,
      kind: ty.kind,
      properties: JSON.stringify(ty.properties),
      comment: ty.comment,
      decorators: ty.decorators.length > 0 ? JSON.stringify(ty.decorators) : null,
      extendsType: ty.extends ?? null,
      implementsTypes: ty.implements.length > 0 ? JSON.stringify(ty.implements) : null,
      contentHash: ty.contentHash,
    },
  });

  if (ty.bodyText) {
    stmts.push({
      cypher: `
        MATCH (t:Type {filePath: $filePath, name: $name})
        MERGE (t)-[:HAS_CODE]->(cb:CodeBlock {filePath: $filePath, functionName: $name})
        SET cb.bodyText  = $bodyText,
            cb.updatedAt = timestamp()
      `.trim(),
      params: {
        filePath: ty.filePath,
        name: ty.name,
        bodyText: ty.bodyText.slice(0, 8000),
      },
    });
  }

  // EXTENDS edge
  if (ty.extends) {
    stmts.push({
      cypher: `
        MATCH (child:Type {filePath: $filePath, name: $childName})
        MATCH (parent:Type {name: $parentName})
        MERGE (child)-[:EXTENDS]->(parent)
      `.trim(),
      params: {
        filePath: ty.filePath,
        childName: ty.name,
        parentName: ty.extends,
      },
    });
  }

  // IMPLEMENTS edges
  for (const ifaceName of ty.implements) {
    stmts.push({
      cypher: `
        MATCH (cls:Type {filePath: $filePath, name: $className})
        MATCH (iface:Type {name: $ifaceName})
        MERGE (cls)-[:IMPLEMENTS]->(iface)
      `.trim(),
      params: {
        filePath: ty.filePath,
        className: ty.name,
        ifaceName,
      },
    });
  }

  // INJECTS edges
  for (const param of ty.constructorParams) {
    const targetType = param.injectToken ?? param.type;
    if (targetType === 'unknown' || targetType.length > 80) continue;
    stmts.push({
      cypher: `
        MATCH (cls:Type {filePath: $filePath, name: $className})
        MATCH (dep:Type {name: $depName})
        MERGE (cls)-[r:INJECTS]->(dep)
        SET r.paramName = $paramName
      `.trim(),
      params: {
        filePath: ty.filePath,
        className: ty.name,
        depName: targetType,
        paramName: param.name,
      },
    });
  }

  return stmts;
}

function buildTypeUpdate(ty: ParsedType, _changedFields: string[]): CypherStatement[] {
  return buildTypeCreate(ty);
}

// ---------------------------------------------------------------------------
// Relationship edge builders
// ---------------------------------------------------------------------------

/**
 * Build CALLS edges for a function, scoped to prevent phantom cross-service edges.
 *
 * Resolution order (first match wins):
 *   1. Same-file call — callee lives in the same filePath as the caller.
 *   2. Imported call  — callee name appears in the set of names the caller's
 *      file explicitly imports (importedNames collected from all ParsedImports).
 *
 * Without scope, a bare name like "normalize" would match the first Function
 * node in the graph with that name, regardless of package — creating phantom
 * cross-service edges where no IMPORTS path connects the two modules.
 */
function buildCallsEdges(
  filePath: string,
  callerName: string,
  callees: string[],
  importedNames: ReadonlySet<string>,
): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  stmts.push({
    cypher: `
      MATCH (caller:Function {filePath: $filePath, name: $name})-[r:CALLS]->()
      DELETE r
    `.trim(),
    params: { filePath, name: callerName },
  });

  for (const callee of callees) {
    // Bare name match: accepted when same-file OR name is in the import list.
    // Method suffix (e.g. "this.normalize" → calleeSuffix ".normalize") is
    // already stripped in ast-parser, so we only need the bare name here.
    const isImported = importedNames.has(callee);

    if (isImported) {
      // Cross-file: callee must appear in the caller's import list to avoid
      // landing on a same-named function in an unrelated package.
      stmts.push({
        cypher: `
          MATCH (caller:Function {filePath: $filePath, name: $callerName})
          MATCH (callee:Function)
          WHERE (callee.name = $calleeName OR callee.name ENDS WITH $calleeSuffix)
            AND callee.filePath <> $filePath
          WITH caller, callee LIMIT 1
          MERGE (caller)-[:CALLS]->(callee)
        `.trim(),
        params: {
          filePath,
          callerName,
          calleeName: callee,
          calleeSuffix: '.' + callee,
        },
      });
    } else {
      // Same-file only: callee is not in the import list, so it must be a
      // local function defined in the same file.
      stmts.push({
        cypher: `
          MATCH (caller:Function {filePath: $filePath, name: $callerName})
          MATCH (callee:Function {filePath: $filePath})
          WHERE callee.name = $calleeName
             OR callee.name ENDS WITH $calleeSuffix
          WITH caller, callee LIMIT 1
          MERGE (caller)-[:CALLS]->(callee)
        `.trim(),
        params: {
          filePath,
          callerName,
          calleeName: callee,
          calleeSuffix: '.' + callee,
        },
      });
    }
  }

  return stmts;
}

function buildUsesTypeEdges(filePath: string, funcName: string, typeRefs: string[]): CypherStatement[] {
  const stmts: CypherStatement[] = [];

  stmts.push({
    cypher: `
      MATCH (f:Function {filePath: $filePath, name: $name})-[r:USES_TYPE]->()
      DELETE r
    `.trim(),
    params: { filePath, name: funcName },
  });

  for (const typeName of typeRefs) {
    stmts.push({
      cypher: `
        MATCH (f:Function {filePath: $filePath, name: $funcName})
        MATCH (t:Type {name: $typeName})
        WITH f, t LIMIT 1
        MERGE (f)-[:USES_TYPE]->(t)
      `.trim(),
      params: { filePath, funcName, typeName },
    });
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// File node mutations
// ---------------------------------------------------------------------------

export function buildFileCreate(file: ParsedFile): CypherStatement[] {
  const dirPath = path.dirname(file.filePath).replace(/\\/g, '/');
  return [{
    cypher: `
      MERGE (f:File {filePath: $filePath})
      SET f.fileName   = $fileName,
          f.extension  = $extension,
          f.lineCount  = $lineCount,
          f.updatedAt  = timestamp()
      WITH f
      MERGE (m:Module {filePath: $dirPath})
      ON CREATE SET m.name        = $dirName,
                    m.packageName = $pkgName,
                    m.updatedAt   = timestamp()
      MERGE (m)-[:CONTAINS_FILE]->(f)
    `.trim(),
    params: {
      filePath: file.filePath,
      dirPath,
      dirName: path.basename(dirPath),
      pkgName: packageNameForDir(dirPath),
      fileName: file.fileName,
      extension: file.extension,
      lineCount: file.lineCount,
    },
  }];
}

// ---------------------------------------------------------------------------
// Delete mutations
// ---------------------------------------------------------------------------

function buildNodeDelete(del: NodeDelete): CypherStatement {
  const label = del.kind === 'function' ? 'Function' : 'Type';
  // Also delete the node's CodeBlock — otherwise it is stranded until the
  // whole file is deleted.
  return {
    cypher: `
      MATCH (n:${label} {filePath: $filePath, name: $name})
      OPTIONAL MATCH (n)-[:HAS_CODE]->(cb:CodeBlock {functionName: $name})
      DETACH DELETE n, cb
    `.trim(),
    params: { filePath: del.filePath, name: del.name },
  };
}

function buildDeletedFileNodes(filePath: string): CypherStatement[] {
  return [
    {
      cypher: `MATCH (cb:CodeBlock {filePath: $filePath}) DETACH DELETE cb`.trim(),
      params: { filePath },
    },
    {
      cypher: `MATCH (n:Function {filePath: $filePath}) DETACH DELETE n`.trim(),
      params: { filePath },
    },
    {
      cypher: `MATCH (n:Type {filePath: $filePath}) DETACH DELETE n`.trim(),
      params: { filePath },
    },
    {
      cypher: `MATCH (n:File {filePath: $filePath}) DETACH DELETE n`.trim(),
      params: { filePath },
    },
    {
      cypher: `MATCH (n:Module {filePath: $filePath}) DETACH DELETE n`.trim(),
      params: { filePath },
    },
  ];
}

// ---------------------------------------------------------------------------
// Edge mutations
// ---------------------------------------------------------------------------

/**
 * IMPORTS edges connect directory-keyed Module nodes:
 *   (sourceDir:Module)-[:IMPORTS {moduleSpecifier, fromFile}]->(targetDir:Module)
 * matching the shape the initial seed creates. External-package specifiers
 * resolve to null and produce NO statement (returns null; filtered out in
 * buildMutations).
 */
function buildEdgeAdd(edge: EdgeAdd): CypherStatement | null {
  if (edge.kind !== 'IMPORTS') return null;

  const fromFile = edge.fromFile.replace(/\\/g, '/');
  const moduleSpecifier = edge.moduleSpecifier ?? '';
  const dirPath = path.dirname(fromFile).replace(/\\/g, '/');

  const targetPath = fromFile.endsWith('.py')
    ? resolvePythonImportTarget(dirPath, moduleSpecifier)
    : resolveImportTarget(dirPath, moduleSpecifier);
  if (!targetPath) return null;

  return {
    cypher: `
      MERGE (source:Module {filePath: $dirPath})
      ON CREATE SET source.name        = $sourceName,
                    source.packageName = $sourcePkg,
                    source.updatedAt   = timestamp()
      MERGE (target:Module {filePath: $targetPath})
      ON CREATE SET target.name        = $targetName,
                    target.packageName = $targetPkg,
                    target.updatedAt   = timestamp()
      MERGE (source)-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->(target)
      SET e.importedNames = $importedNames,
          e.fromFile      = $fromFile,
          e.updatedAt     = timestamp()
    `.trim(),
    params: {
      dirPath,
      targetPath,
      sourceName: path.basename(dirPath),
      sourcePkg: packageNameForDir(dirPath),
      targetName: path.basename(targetPath),
      targetPkg: packageNameForDir(targetPath),
      moduleSpecifier,
      importedNames: edge.importedNames ?? [],
      fromFile,
    },
  };
}

function buildEdgeRemove(edge: EdgeRemove): CypherStatement {
  // The edge lives on a directory-keyed Module; the source file is on e.fromFile.
  return {
    cypher: `
      MATCH (:Module)-[e:IMPORTS {moduleSpecifier: $moduleSpecifier}]->()
      WHERE e.fromFile = $fromFile
      DELETE e
    `.trim(),
    params: {
      fromFile: edge.fromFile,
      moduleSpecifier: edge.moduleSpecifier,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a map from filePath → set of all names explicitly imported by that
 * file.  Used to scope CALLS edge resolution so we never create a cross-service
 * edge to a same-named function in a package the caller never imports.
 */
function buildImportedNamesIndex(parsedFiles: ParsedFile[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of parsedFiles) {
    const names = new Set<string>();
    for (const imp of file.imports) {
      for (const name of imp.importedNames) {
        // Strip "* as ns" namespace imports — they resolve at the call site
        // via a property access we can't easily scope here, so skip them.
        if (!name.startsWith('* as ')) {
          names.add(name);
        }
      }
    }
    index.set(file.filePath, names);
  }
  return index;
}

export function buildMutations(changeset: Changeset): CypherStatement[] {
  const statements: CypherStatement[] = [];

  // Pre-build the importedNames index so CALLS resolution can scope callees to
  // names the caller's file actually imports — avoiding phantom cross-service edges.
  const importedNamesIndex = buildImportedNamesIndex(changeset.parsedFiles);
  const emptySet: ReadonlySet<string> = new Set();

  // 1. Deleted files
  for (const filePath of changeset.deletedFiles) {
    statements.push(...buildDeletedFileNodes(filePath));
  }

  // 2. Individual node deletions
  for (const del of changeset.nodesToDelete) {
    statements.push(buildNodeDelete(del));
  }

  // 3. Stale edge removals
  for (const edge of changeset.edgesToRemove) {
    statements.push(buildEdgeRemove(edge));
  }

  // 3.5. File nodes (must exist before Function/Type nodes reference them)
  for (const file of changeset.parsedFiles) {
    statements.push(...buildFileCreate(file));
  }

  // 4. Creates and updates
  for (const create of changeset.nodesToCreate) {
    if (create.kind === 'function') {
      const fn = create.data as ParsedFunction;
      const importedNames = importedNamesIndex.get(fn.filePath) ?? emptySet;
      statements.push(...buildFunctionCreate(fn, importedNames));
    } else {
      statements.push(...buildTypeCreate(create.data as ParsedType));
    }
  }

  for (const update of changeset.nodesToUpdate) {
    if (update.kind === 'function') {
      const fn = update.data as ParsedFunction;
      const importedNames = importedNamesIndex.get(fn.filePath) ?? emptySet;
      statements.push(...buildFunctionUpdate(fn, update.changedFields, importedNames));
    } else {
      statements.push(...buildTypeUpdate(update.data as ParsedType, update.changedFields));
    }
  }

  // 5. New edges (unresolvable / external imports produce no statement)
  for (const edge of changeset.edgesToAdd) {
    const stmt = buildEdgeAdd(edge);
    if (stmt) statements.push(stmt);
  }

  return statements;
}

export async function applyMutations(
  statements: CypherStatement[],
  driver: import('neo4j-driver').Driver
): Promise<number> {
  if (statements.length === 0) return 0;

  const session = driver.session({ defaultAccessMode: 'WRITE' });
  const tx = session.beginTransaction();

  try {
    for (const { cypher, params } of statements) {
      await tx.run(cypher, params);
    }
    await tx.commit();
    return statements.length;
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await session.close();
  }
}
