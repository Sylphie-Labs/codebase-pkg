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
import type { ParsedFile, ParsedFunction, ParsedType, ParsedImport } from './ast-parser.js';

// ---------------------------------------------------------------------------
// Graph state types
// ---------------------------------------------------------------------------

interface GraphNode {
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
  kind: 'function' | 'type';
  data: ParsedFunction | ParsedType;
}

export interface NodeUpdate {
  kind: 'function' | 'type';
  data: ParsedFunction | ParsedType;
  changedFields: string[];
}

export interface NodeDelete {
  kind: 'function' | 'type';
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

async function fetchGraphImports(
  filePaths: string[]
): Promise<Map<string, GraphImportEdge>> {
  if (filePaths.length === 0) return new Map();

  const records = await runQuery(
    `MATCH (m:Module)-[e:IMPORTS]->(target)
     WHERE m.filePath IN $filePaths
     RETURN m.filePath AS fromFile, e.moduleSpecifier AS moduleSpecifier,
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

  const [graphFunctions, graphTypes, graphImports] = await Promise.all([
    fetchGraphFunctions(allFilePaths),
    fetchGraphTypes(allFilePaths),
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
  }

  // Diff each parsed file against graph state
  for (const parsedFile of parsedFiles) {
    const { filePath, functions, types, imports } = parsedFile;

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

    // --- Imports ---
    const parsedImportKeys = new Set<string>();

    for (const imp of imports) {
      const key = `${filePath}::${imp.moduleSpecifier}`;
      parsedImportKeys.add(key);

      if (!graphImports.has(key)) {
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
