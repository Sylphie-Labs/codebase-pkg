/**
 * Tests for the step-3 conformity wiring: embed-functions.js core + the sync
 * hook's pure selection logic + the Postgres gate.
 *
 * PURE logic only -- NO live Postgres, NO embedding model. A deterministic fake
 * embedder returns canned vectors; a fake store records every upsert/delete; a
 * fake PgRunner drives the gate. Mirrors conformity-store.test.mjs.
 *
 * Run after `npm run build`:
 *   node --test test/conformity-embed-functions.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  embedAndStoreFunctions,
  embedAndStoreChunks,
  EMBED_BATCH_SIZE,
} from '../dist/conformity/embed-functions.js';
import {
  functionsToEmbed,
  deletedFunctionIds,
  chunksToEmbed,
  deletedChunkIds,
  isConformityEnabled,
  runConformityStep,
} from '../dist/conformity/sync-hook.js';
import { EMBEDDING_DIM, nodeIdOf } from '../dist/conformity/index.js';
import {
  categoryOf,
  representationText,
  FUNCTION_BODY,
  TYPE_BODY,
  MODULE_CONST,
} from '../dist/conformity/category.js';

/**
 * Canonical node id, mirroring store.nodeIdOf -- ids are absolute + forward-
 * slashed so backfill (absolute paths) and the judge (relative paths) agree.
 */
function canonId(filePath, name) {
  return nodeIdOf({ filePath, name });
}

// --- Fakes -----------------------------------------------------------------

/** A fake ConformityStore that records upserts and deletes. */
function makeFakeStore() {
  const upserts = [];
  const deletes = [];
  return {
    upserts,
    deletes,
    async upsertVectors(records) {
      upserts.push(records);
    },
    async deleteVectors(ids) {
      deletes.push(ids);
    },
  };
}

/** A deterministic embedder: each text -> a full-length vector seeded by index. */
function makeFakeEmbedder() {
  const calls = [];
  const embedder = async (texts) => {
    calls.push(texts);
    return texts.map((_t, i) => new Array(EMBEDDING_DIM).fill((i + 1) / 100));
  };
  embedder.calls = calls;
  return embedder;
}

/** A minimal ParsedFunction good enough for category/representation derivation. */
function fn(name, filePath, args = [], returnType = 'void', bodyText = '{}') {
  return {
    name,
    filePath,
    lineNumber: 1,
    endLine: 2,
    args: args.map((a) =>
      typeof a === 'string'
        ? { name: a, type: 'string', hasDefault: false }
        : a,
    ),
    returnType,
    jsDoc: '',
    bodyText,
    isExported: true,
    isAsync: false,
    decorators: [],
    callees: [],
    typeRefs: [],
    contentHash: 'h-' + name,
  };
}

/** A minimal ParsedType good enough for category/representation derivation. */
function ty(name, filePath, kind = 'interface', bodyText = `interface ${name} { id: string; }`) {
  return {
    name,
    filePath,
    lineNumber: 1,
    kind,
    properties: [],
    bodyText,
    comment: '',
    decorators: [],
    implements: [],
    constructorParams: [],
    contentHash: 'h-' + name,
  };
}

/** A minimal ParsedConstant good enough for category/representation derivation. */
function ct(name, filePath, bodyText = `${name} = { a: 1 }`) {
  return {
    name,
    filePath,
    lineNumber: 1,
    endLine: 2,
    bodyText,
    isExported: true,
    kind: 'const',
    contentHash: 'h-' + name,
  };
}

// --- embedAndStoreFunctions ------------------------------------------------

test('embedAndStoreFunctions derives category/representation text, nodeIds, and captures model', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();

  const fns = [
    fn('alpha', 'a.ts', ['x', 'y'], 'number', '{ return x + y; }'),
    fn('beta', 'b.ts', [], 'void', '{ doSomething(); }'),
  ];

  const res = await embedAndStoreFunctions(fns, {
    store,
    embedder,
    model: 'test-model',
  });

  assert.equal(res.embedded, 2);
  assert.equal(res.skipped, 0);

  // One batch (both functions fit), embedded with their representation texts
  // (the lightly-normalized whole body), NOT the legacy signature skeleton.
  assert.equal(embedder.calls.length, 1);
  assert.deepEqual(embedder.calls[0], [
    representationText(fns[0]),
    representationText(fns[1]),
  ]);

  // One upsert batch.
  assert.equal(store.upserts.length, 1);
  const recs = store.upserts[0];
  assert.equal(recs.length, 2);

  assert.equal(recs[0].nodeId, canonId('a.ts', 'alpha'));
  assert.equal(recs[1].nodeId, canonId('b.ts', 'beta'));
  assert.equal(recs[0].category, categoryOf(fns[0]));
  assert.equal(recs[0].model, 'test-model');
  assert.equal(recs[1].model, 'test-model');
  assert.equal(recs[0].vector.length, EMBEDDING_DIM);
});

test('embedAndStoreFunctions falls back to a candidate model when none captured', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();

  // No opts.model; the fake embedder never sets CHOSEN_MODEL, so the fallback
  // (MODEL_CANDIDATES[0]) must be stamped instead of null/undefined.
  await embedAndStoreFunctions([fn('only', 'x.ts')], { store, embedder });

  const model = store.upserts[0][0].model;
  assert.equal(typeof model, 'string');
  assert.ok(model.length > 0);
  assert.notEqual(model, 'undefined');
});

test('embedAndStoreFunctions batches at EMBED_BATCH_SIZE', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();

  const count = EMBED_BATCH_SIZE + 5;
  const fns = Array.from({ length: count }, (_v, i) => fn('f' + i, 'file.ts'));

  // nodeIds must be unique for a sane upsert; vary the file so they differ.
  const uniqueFns = fns.map((f, i) => ({ ...f, filePath: `file${i}.ts` }));

  const res = await embedAndStoreFunctions(uniqueFns, { store, embedder, model: 'm' });

  assert.equal(res.embedded, count);
  // Two batches: full + remainder.
  assert.equal(embedder.calls.length, 2);
  assert.equal(embedder.calls[0].length, EMBED_BATCH_SIZE);
  assert.equal(embedder.calls[1].length, 5);
  assert.equal(store.upserts.length, 2);
});

test('embedAndStoreFunctions with empty input does nothing', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();
  const res = await embedAndStoreFunctions([], { store, embedder });
  assert.deepEqual(res, { embedded: 0, skipped: 0 });
  assert.equal(embedder.calls.length, 0);
  assert.equal(store.upserts.length, 0);
});

// --- embedAndStoreChunks: per-kind routing (functions + types) -------------

test('embedAndStoreChunks routes a function to function:body and a type to type:body', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();

  const aFn = fn('alpha', 'a.ts', ['x'], 'number', '{ return x; }');
  const aTy = ty('Widget', 'a.ts', 'interface', 'interface Widget { id: string; }');

  const res = await embedAndStoreChunks([aFn, aTy], { store, embedder, model: 'm' });

  assert.equal(res.embedded, 2);
  assert.equal(res.skipped, 0);

  // Each chunk was embedded with its representation text (lightly-normalized body).
  assert.deepEqual(embedder.calls[0], [
    representationText(aFn),
    representationText(aTy),
  ]);

  const recs = store.upserts.flat();
  const byId = new Map(recs.map((r) => [r.nodeId, r.category]));
  assert.equal(byId.get(canonId('a.ts', 'alpha')), FUNCTION_BODY);
  assert.equal(byId.get(canonId('a.ts', 'Widget')), TYPE_BODY);
});

test('embedAndStoreChunks routes a module constant to module:const', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();

  const aFn = fn('alpha', 'a.ts', ['x'], 'number', '{ return x; }');
  const aTy = ty('Widget', 'a.ts', 'interface', 'interface Widget { id: string; }');
  const aConst = ct('CONFIG', 'a.ts', 'CONFIG = { retries: 3 }');

  const res = await embedAndStoreChunks([aFn, aTy, aConst], { store, embedder, model: 'm' });

  assert.equal(res.embedded, 3);
  assert.equal(res.skipped, 0);

  assert.deepEqual(embedder.calls[0], [
    representationText(aFn),
    representationText(aTy),
    representationText(aConst),
  ]);

  const recs = store.upserts.flat();
  const byId = new Map(recs.map((r) => [r.nodeId, r.category]));
  assert.equal(byId.get(canonId('a.ts', 'alpha')), FUNCTION_BODY);
  assert.equal(byId.get(canonId('a.ts', 'Widget')), TYPE_BODY);
  assert.equal(byId.get(canonId('a.ts', 'CONFIG')), MODULE_CONST);
});

test('embedAndStoreChunks skips a type with an empty body', async () => {
  const store = makeFakeStore();
  const embedder = makeFakeEmbedder();
  const empty = ty('Empty', 'a.ts', 'type', '');
  const res = await embedAndStoreChunks([empty], { store, embedder, model: 'm' });
  assert.equal(res.embedded, 0);
  assert.equal(res.skipped, 1);
  assert.equal(store.upserts.length, 0);
});

// --- sync-hook selection logic ---------------------------------------------

function makeChangeset({ create = [], update = [], del = [] } = {}) {
  return {
    nodesToCreate: create,
    nodesToUpdate: update,
    nodesToDelete: del,
    edgesToAdd: [],
    edgesToRemove: [],
    deletedFiles: [],
    parsedFiles: [],
  };
}

test('functionsToEmbed picks creates + updates of kind function, skips types', () => {
  const fA = fn('a', 'a.ts');
  const fB = fn('b', 'b.ts');
  const cs = makeChangeset({
    create: [
      { kind: 'function', data: fA },
      { kind: 'type', data: { name: 'T', filePath: 'a.ts' } },
    ],
    update: [{ kind: 'function', data: fB, changedFields: ['full'] }],
    del: [{ kind: 'function', name: 'gone', filePath: 'c.ts' }],
  });

  const out = functionsToEmbed(cs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.name), ['a', 'b']);
});

test('deletedFunctionIds (legacy) builds canonical node ids, skips type deletes', () => {
  const cs = makeChangeset({
    del: [
      { kind: 'function', name: 'gone', filePath: 'c.ts' },
      { kind: 'type', name: 'OldType', filePath: 'c.ts' },
      { kind: 'function', name: 'alsoGone', filePath: 'd.ts' },
    ],
  });

  // The legacy helper stays function-only. Deletes must use the SAME canonical id
  // form as upserts so a removed function's stored vector is actually deleted.
  assert.deepEqual(deletedFunctionIds(cs), [
    canonId('c.ts', 'gone'),
    canonId('d.ts', 'alsoGone'),
  ]);
});

test('chunksToEmbed picks creates + updates of kind function AND type', () => {
  const fA = fn('a', 'a.ts');
  const tT = ty('T', 'a.ts');
  const fB = fn('b', 'b.ts');
  const cs = makeChangeset({
    create: [
      { kind: 'function', data: fA },
      { kind: 'type', data: tT },
    ],
    update: [{ kind: 'function', data: fB, changedFields: ['full'] }],
    del: [{ kind: 'function', name: 'gone', filePath: 'c.ts' }],
  });

  const out = chunksToEmbed(cs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.name), ['a', 'T', 'b']);
  // The type routes to type:body, the functions to function:body.
  assert.deepEqual(out.map((c) => categoryOf(c)), [
    FUNCTION_BODY,
    TYPE_BODY,
    FUNCTION_BODY,
  ]);
});

test('deletedChunkIds builds canonical node ids for BOTH functions and types', () => {
  const cs = makeChangeset({
    del: [
      { kind: 'function', name: 'gone', filePath: 'c.ts' },
      { kind: 'type', name: 'OldType', filePath: 'c.ts' },
      { kind: 'function', name: 'alsoGone', filePath: 'd.ts' },
    ],
  });
  assert.deepEqual(deletedChunkIds(cs), [
    canonId('c.ts', 'gone'),
    canonId('c.ts', 'OldType'),
    canonId('d.ts', 'alsoGone'),
  ]);
});

// --- the gate --------------------------------------------------------------

test('isConformityEnabled returns false when CODEBASE_PKG_CONFORMITY=off', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  process.env.CODEBASE_PKG_CONFORMITY = 'off';
  try {
    // Runner must never be queried when disabled by env.
    const runner = { query: async () => { throw new Error('should not be called'); } };
    assert.equal(await isConformityEnabled(runner), false);
  } finally {
    if (prev === undefined) delete process.env.CODEBASE_PKG_CONFORMITY;
    else process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});

test('isConformityEnabled returns false when Postgres probe throws (unconfigured/unreachable)', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  delete process.env.CODEBASE_PKG_CONFORMITY;
  try {
    const runner = { query: async () => { throw new Error('ECONNREFUSED'); } };
    assert.equal(await isConformityEnabled(runner), false);
  } finally {
    if (prev !== undefined) process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});

test('isConformityEnabled returns true when the probe succeeds', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  delete process.env.CODEBASE_PKG_CONFORMITY;
  try {
    const runner = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
    assert.equal(await isConformityEnabled(runner), true);
  } finally {
    if (prev !== undefined) process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});

// --- runConformityStep end-to-end (fakes only) -----------------------------

test('runConformityStep skips gracefully when Postgres is unreachable', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  delete process.env.CODEBASE_PKG_CONFORMITY;
  try {
    const runner = { query: async () => { throw new Error('no pg'); } };
    const store = makeFakeStore();
    const cs = makeChangeset({ create: [{ kind: 'function', data: fn('a', 'a.ts') }] });

    const res = await runConformityStep(cs, { runner, store, embedder: makeFakeEmbedder(), model: 'm' });

    assert.equal(res.skipped, true);
    assert.match(res.reason, /Postgres/);
    // Nothing embedded or deleted on the skip path.
    assert.equal(store.upserts.length, 0);
    assert.equal(store.deletes.length, 0);
  } finally {
    if (prev !== undefined) process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});

test('runConformityStep embeds creates+updates (functions AND types) and deletes removed function + type ids', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  delete process.env.CODEBASE_PKG_CONFORMITY;
  try {
    const runner = { query: async () => ({ rows: [{ ok: 1 }] }) }; // gate passes
    const store = makeFakeStore();
    const embedder = makeFakeEmbedder();

    const cs = makeChangeset({
      create: [
        { kind: 'function', data: fn('a', 'a.ts') },
        { kind: 'type', data: ty('T', 'a.ts') },
      ],
      update: [{ kind: 'function', data: fn('b', 'b.ts'), changedFields: ['full'] }],
      del: [
        { kind: 'function', name: 'gone', filePath: 'c.ts' },
        { kind: 'type', name: 'OldType', filePath: 'c.ts' },
      ],
    });

    const res = await runConformityStep(cs, { runner, store, embedder, model: 'm' });

    assert.equal(res.skipped, false);
    // Two functions + one type are now all embedded through the same pipeline.
    assert.equal(res.embedded, 3);
    // BOTH the removed function and the removed type are deleted now.
    assert.equal(res.deleted, 2);

    // Upserted node ids are the two functions plus the one type.
    const upsertedIds = store.upserts.flat().map((r) => r.nodeId).sort();
    assert.deepEqual(
      upsertedIds,
      [canonId('a.ts', 'a'), canonId('b.ts', 'b'), canonId('a.ts', 'T')].sort(),
    );
    // The type was routed to type:body, the functions to function:body.
    const byId = new Map(store.upserts.flat().map((r) => [r.nodeId, r.category]));
    assert.equal(byId.get(canonId('a.ts', 'T')), TYPE_BODY);
    assert.equal(byId.get(canonId('a.ts', 'a')), FUNCTION_BODY);

    // Deleted both the removed function and the removed type id.
    assert.deepEqual(store.deletes, [
      [canonId('c.ts', 'gone'), canonId('c.ts', 'OldType')],
    ]);
  } finally {
    if (prev !== undefined) process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});

test('runConformityStep does not call deleteVectors when there are no deletes', async () => {
  const prev = process.env.CODEBASE_PKG_CONFORMITY;
  delete process.env.CODEBASE_PKG_CONFORMITY;
  try {
    const runner = { query: async () => ({ rows: [{ ok: 1 }] }) };
    const store = makeFakeStore();
    const cs = makeChangeset({ create: [{ kind: 'function', data: fn('a', 'a.ts') }] });

    await runConformityStep(cs, { runner, store, embedder: makeFakeEmbedder(), model: 'm' });

    assert.equal(store.deletes.length, 0);
  } finally {
    if (prev !== undefined) process.env.CODEBASE_PKG_CONFORMITY = prev;
  }
});
