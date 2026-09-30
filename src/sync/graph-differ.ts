/**
 * graph-differ.ts -- Compare AST output against current graph state.
 *
 * Queries the codebase PKG for existing Function and Type nodes in the
 * changed files, then diffs them against the freshly parsed AST output
 * to produce a changeset: what to create, update, and delete.
 *
 * Change detection uses SHA-256 content hashes.
 */

import { runQuery } from '../mcp-server/neo4j-client.js';
import type { ParsedFile, ParsedFunction, ParsedType, ParsedConstant, ParsedImport } from './ast-parser.js';

// ---------------------------------------------------------------------------
// Graph state types
// ---------------------------------------------------------------------------

export interface GraphNode {
  name: string;
  filePath: string;
  contentHash: string | null;
}

interface GraphImportEdge {
  fromFile: string;
  moduleSpecifier: string;
  importedNames: string[];
}

// ---------------------------------------------------------------------------
// Changeset types
// ---------------------------------------------------------------------------

export interface NodeCreate {
  kind: 'function' | 'type' | 'const';
  data: ParsedFunction | ParsedType | ParsedConstant;
}

export interface NodeUpdate {
  kind: 'function' | 'type' | 'const';
  data: ParsedFunction | ParsedType | ParsedConstant;
  changedFields: string[];
}

export interface NodeDelete {
  kind: 'function' | 'type' | 'const';
  name: string;
  filePath: string;
}

export interface EdgeAdd {
  kind: 'IMPORTS' | 'USES_TYPE' | 'BELONGS_TO';
  fromFile: string;
  toFile?: string;
  moduleSpecifier?: string;
  importedNames?: string[];
  functionName?: string;
  modulePath?: string;
}

export interface EdgeRemove {
  kind: 'IMPORTS';
  fromFile: string;
  moduleSpecifier: string;
}

export interface Changeset {
  nodesToCreate: NodeCreate[];
  nodesToUpdate: NodeUpdate[];
  nodesToDelete: NodeDelete[];
  edgesToAdd: EdgeAdd[];
  edgesToRemove: EdgeRemove[];
  deletedFiles: string[];
  /** Parsed files for File node creation/update */
  parsedFiles: ParsedFile[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchGraphFunctions(
  filePaths: string[]
): Promise<Map<string, GraphNode>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (f:Function)
     WHERE f.filePath IN $filePaths
     RETURN f.name AS name, f.filePath AS filePath, f.contentHash AS contentHash`,
    { filePaths }
  );

  const map = new Map<string, GraphNode>();
  for (const r of records) {
    const node: GraphNode = {
      name: r.get('name') as string,
      filePath: r.get('filePath') as string,
      contentHash: (r.get('contentHash') as string) ?? null,
    };
    map.set(`${node.filePath}::${node.name}`, node);
  }
  return map;
}

async function fetchGraphTypes(
  filePaths: string[]
): Promise<Map<string, GraphNode>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (t:Type)
     WHERE t.filePath IN $filePaths
     RETURN t.name AS name, t.filePath AS filePath, t.contentHash AS contentHash`,
    { filePaths }
  );

  const map = new Map<string, GraphNode>();
  for (const r of records) {
    const node: GraphNode = {
      name: r.get('name') as string,
      filePath: r.get('filePath') as string,
      contentHash: (r.get('contentHash') as string) ?? null,
    };
    map.set(`${node.filePath}::${node.name}`, node);
  }
  return map;
}

async function fetchGraphConstants(
  filePaths: string[]
): Promise<Map<string, GraphNode>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (c:Constant)
     WHERE c.filePath IN $filePaths
     RETURN c.name AS name, c.filePath AS filePath, c.contentHash AS contentHash`,
    { filePaths }
  );

  const map = new Map<string, GraphNode>();
  for (const r of records) {
    const node: GraphNode = {
      name: r.get('name') as string,
      filePath: r.get('filePath') as string,
      contentHash: (r.get('contentHash') as string) ?? null,
    };
    map.set(`${node.filePath}::${node.name}`, node);
  }
  return map;
}

async function fetchGraphImports(
  filePaths: string[]
): Promise<Map<string, GraphImportEdge>> {
  if (filePaths.length === 0) return new Map();

  // IMPORTS edges live on directory-keyed Module nodes; the source FILE is
  // recorded on the edge itself as e.fromFile (see initial-seed writeParsedBatch).
  const records = await runQuery(
    `MATCH (:Module)-[e:IMPORTS]->(:Module)
     WHERE e.fromFile IN $filePaths
     RETURN e.fromFile AS fromFile, e.moduleSpecifier AS moduleSpecifier,
            e.importedNames AS importedNames`,
    { filePaths }
  );

  const map = new Map<string, GraphImportEdge>();
  for (const r of records) {
    const edge: GraphImportEdge = {
      fromFile: r.get('fromFile') as string,
      moduleSpecifier: r.get('moduleSpecifier') as string,
      importedNames: (r.get('importedNames') as string[]) ?? [],
    };
    map.set(`${edge.fromFile}::${edge.moduleSpecifier}`, edge);
  }
  return map;
}

function sameImportedNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure diff of one file's parsed module-level constants against the existing
 * graph `Constant` nodes for that same file. Mirrors the create/update/delete
 * rule already used inline for Function and Type nodes in
 * {@link computeChangeset}: a name with no existing node -> create; an
 * existing node whose `contentHash` differs from the freshly parsed one ->
 * update; an existing node whose name is no longer present in the parse ->
 * delete.
 *
 * Deliberately takes a plain `Map<string, GraphNode>` (keyed `filePath::name`,
 * the same convention {@link fetchGraphConstants} produces) rather than
 * hitting Neo4j itself, so the diffing RULE can be unit-tested without a
 * database -- callers build the map however they like (a live query result,
 * or a hand-built fixture in a test).
 */
export function diffConstantsForFile(
  filePath: string,
  constants: ParsedConstant[],
  graphConstants: Map<string, GraphNode>,
): { creates: NodeCreate[]; updates: NodeUpdate[]; deletes: NodeDelete[] } {
  const creates: NodeCreate[] = [];
  const updates: NodeUpdate[] = [];
  const deletes: NodeDelete[] = [];
  const parsedKeys = new Set<string>();

  for (const c of constants) {
    const key = `${filePath}::${c.name}`;
    parsedKeys.add(key);

    const existing = graphConstants.get(key);
    if (!existing) {
      creates.push({ kind: 'const', data: c });
    } else if (existing.contentHash !== c.contentHash) {
      updates.push({ kind: 'const', data: c, changedFields: ['full'] });
    }
  }

  for (const [key, c] of graphConstants.entries()) {
    if (c.filePath === filePath && !parsedKeys.has(key)) {
      deletes.push({ kind: 'const', name: c.name, filePath: c.filePath });
    }
  }

  return { creates, updates, deletes };
}

export async function computeChangeset(
  parsedFiles: ParsedFile[],
  deletedFiles: string[] = []
): Promise<Changeset> {
  const changeset: Changeset = {
    nodesToCreate: [],
    nodesToUpdate: [],
    nodesToDelete: [],
    edgesToAdd: [],
    edgesToRemove: [],
    deletedFiles,
    parsedFiles,
  };

  const allFilePaths = [
    ...parsedFiles.map(f => f.filePath),
    ...deletedFiles,
  ];

  const [graphFunctions, graphTypes, graphConstants, graphImports] = await Promise.all([
    fetchGraphFunctions(allFilePaths),
    fetchGraphTypes(allFilePaths),
    fetchGraphConstants(allFilePaths),
    fetchGraphImports(allFilePaths),
  ]);

  // Handle deleted files
  for (const filePath of deletedFiles) {
    for (const [key, fn] of graphFunctions.entries()) {
      if (fn.filePath === filePath) {
        changeset.nodesToDelete.push({ kind: 'function', name: fn.name, filePath });
        graphFunctions.delete(key);
      }
    }
    for (const [key, ty] of graphTypes.entries()) {
      if (ty.filePath === filePath) {
        changeset.nodesToDelete.push({ kind: 'type', name: ty.name, filePath });
        graphTypes.delete(key);
      }
    }
    for (const [key, c] of graphConstants.entries()) {
      if (c.filePath === filePath) {
        changeset.nodesToDelete.push({ kind: 'const', name: c.name, filePath });
        graphConstants.delete(key);
      }
    }
  }

  // Diff each parsed file against graph state
  for (const parsedFile of parsedFiles) {
    const { filePath, functions, types, imports, constants } = parsedFile;

    // --- Functions ---
    const parsedFunctionKeys = new Set<string>();

    for (const fn of functions) {
      const key = `${filePath}::${fn.name}`;
      parsedFunctionKeys.add(key);

      const existing = graphFunctions.get(key);
      if (!existing) {
        changeset.nodesToCreate.push({ kind: 'function', data: fn });
      } else if (existing.contentHash !== fn.contentHash) {
        changeset.nodesToUpdate.push({ kind: 'function', data: fn, changedFields: ['full'] });
      }
    }

    for (const [key, fn] of graphFunctions.entries()) {
      if (fn.filePath === filePath && !parsedFunctionKeys.has(key)) {
        changeset.nodesToDelete.push({ kind: 'function', name: fn.name, filePath: fn.filePath });
      }
    }

    // --- Types ---
    const parsedTypeKeys = new Set<string>();

    for (const ty of types) {
      const key = `${filePath}::${ty.name}`;
      parsedTypeKeys.add(key);

      const existing = graphTypes.get(key);
      if (!existing) {
        changeset.nodesToCreate.push({ kind: 'type', data: ty });
      } else if (existing.contentHash !== ty.contentHash) {
        changeset.nodesToUpdate.push({ kind: 'type', data: ty, changedFields: ['full'] });
      }
    }

    for (const [key, ty] of graphTypes.entries()) {
      if (ty.filePath === filePath && !parsedTypeKeys.has(key)) {
        changeset.nodesToDelete.push({ kind: 'type', name: ty.name, filePath: ty.filePath });
      }
    }

    // --- Constants (module-level, non-function top-level declarations) ---
    const constantDiff = diffConstantsForFile(filePath, constants, graphConstants);
    changeset.nodesToCreate.push(...constantDiff.creates);
    changeset.nodesToUpdate.push(...constantDiff.updates);
    changeset.nodesToDelete.push(...constantDiff.deletes);

    // --- Imports ---
    const parsedImportKeys = new Set<string>();

    for (const imp of imports) {
      const key = `${filePath}::${imp.moduleSpecifier}`;
      parsedImportKeys.add(key);

      const existing = graphImports.get(key);
      // Re-add when missing OR when importedNames drifted — the add is a
      // MERGE+SET, so it updates the existing edge in place.
      if (!existing || !sameImportedNames(existing.importedNames, imp.importedNames)) {
        changeset.edgesToAdd.push({
          kind: 'IMPORTS',
          fromFile: filePath,
          moduleSpecifier: imp.moduleSpecifier,
          importedNames: imp.importedNames,
        });
      }
    }

    for (const [key, edge] of graphImports.entries()) {
      if (edge.fromFile === filePath && !parsedImportKeys.has(key)) {
        changeset.edgesToRemove.push({
          kind: 'IMPORTS',
          fromFile: edge.fromFile,
          moduleSpecifier: edge.moduleSpecifier,
        });
      }
    }
  }

  return changeset;
}
