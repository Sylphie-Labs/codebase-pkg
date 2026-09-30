/**
 * Tests for the free-text secret redaction module (dist/session/secrets.js).
 *
 * PURE logic only -- no DB, no model. Covers every pattern in the doc's
 * scope (MCP-SERVER-IMPROVEMENTS.md #2): url-password, sk-, AKIA, GOCSPX-,
 * ghp_/gho_, JWT -- plus the "ordinary prose is left alone" negative case,
 * which is the false-positive risk that matters most for a redact-in-place
 * default.
 *
 * Run after `npm run build`:
 *   node --test test/session-secrets.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  redactSecrets,
  redactOptional,
  redactList,
  mergeFindings,
  formatRedactionNotice,
} from '../dist/session/secrets.js';

// ---------------------------------------------------------------------------
// redactSecrets -- one pattern per test, matching the doc's own examples.
// ---------------------------------------------------------------------------

test('redacts a Postgres DSN password, keeping user + host visible', () => {
  const r = redactSecrets('connect via postgresql://user:hunter2@localhost:5432/db');
  assert.equal(r.text, 'connect via postgresql://user:****@localhost:5432/db');
  assert.equal(r.redacted, true);
  assert.deepEqual(r.findings, ['url-password']);
});

test('redacts a mysql:// DSN password too', () => {
  const r = redactSecrets('mysql://root:s3cr3t@db.internal:3306/app');
  assert.equal(r.text, 'mysql://root:****@db.internal:3306/app');
  assert.deepEqual(r.findings, ['url-password']);
});

test('redacts an OpenAI-style sk- key', () => {
  const r = redactSecrets('key is sk-ABCDEFGHIJ1234567890 do not share');
  assert.equal(r.text, 'key is sk-**** do not share');
  assert.deepEqual(r.findings, ['openai-style-key']);
});

test('redacts an AWS access key id', () => {
  const r = redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
  assert.equal(r.text, 'AWS_ACCESS_KEY_ID=AKIA****');
  assert.deepEqual(r.findings, ['aws-access-key']);
});

test('redacts a Google OAuth client secret', () => {
  const r = redactSecrets('secret: GOCSPX-abc123XYZ789def456');
  assert.equal(r.text, 'secret: GOCSPX-****');
  assert.deepEqual(r.findings, ['google-oauth-secret']);
});

test('redacts a GitHub personal access token (ghp_) preserving the prefix', () => {
  const r = redactSecrets('token ghp_1234567890abcdefghijklmnopqrstuvwx');
  assert.equal(r.text, 'token ghp_****');
  assert.deepEqual(r.findings, ['github-token']);
});

test('redacts a GitHub OAuth token (gho_)', () => {
  const r = redactSecrets('token gho_1234567890abcdefghijklmnopqrstuvwx');
  assert.equal(r.text, 'token gho_****');
  assert.deepEqual(r.findings, ['github-token']);
});

test('redacts a JWT shape', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const r = redactSecrets(`Authorization: Bearer ${jwt}`);
  assert.equal(r.text, 'Authorization: Bearer eyJ****');
  assert.deepEqual(r.findings, ['jwt']);
});

test('redacts multiple distinct secrets in one string, reporting both findings', () => {
  const r = redactSecrets('dsn=postgresql://u:p@host/db key=sk-ABCDEFGHIJKLMN');
  assert.match(r.text, /postgresql:\/\/u:\*\*\*\*@host\/db/);
  assert.match(r.text, /sk-\*\*\*\*/);
  assert.deepEqual(r.findings.sort(), ['openai-style-key', 'url-password']);
});

test('leaves ordinary prose untouched -- no false positives', () => {
  const prose =
    'the function truncates at 1000 rows because the LIMIT clause defaults low; ' +
    'see PR #42 and the skate-park analogy in the design doc.';
  const r = redactSecrets(prose);
  assert.equal(r.text, prose);
  assert.equal(r.redacted, false);
  assert.deepEqual(r.findings, []);
});

test('a short "sk-" prefix that is not key-shaped (too short) is left alone', () => {
  const r = redactSecrets('the sk-8 rating on this skateboard is high');
  assert.equal(r.redacted, false);
});

// ---------------------------------------------------------------------------
// redactOptional
// ---------------------------------------------------------------------------

test('redactOptional passes null/undefined through unchanged', () => {
  assert.deepEqual(redactOptional(undefined), { text: undefined, redacted: false, findings: [] });
  assert.deepEqual(redactOptional(null), { text: undefined, redacted: false, findings: [] });
});

test('redactOptional redacts a given string like redactSecrets', () => {
  const r = redactOptional('sk-ABCDEFGHIJKLMN');
  assert.equal(r.text, 'sk-****');
  assert.equal(r.redacted, true);
});

// ---------------------------------------------------------------------------
// redactList
// ---------------------------------------------------------------------------

test('redactList maps over an array, merging findings across entries', () => {
  const r = redactList(['clean caveat', 'leaked sk-ABCDEFGHIJKLMN here', 'also postgresql://u:p@h/d']);
  assert.equal(r.items[0], 'clean caveat');
  assert.match(r.items[1], /sk-\*\*\*\*/);
  assert.match(r.items[2], /postgresql:\/\/u:\*\*\*\*@h\/d/);
  assert.equal(r.redacted, true);
  assert.deepEqual(r.findings.sort(), ['openai-style-key', 'url-password']);
});

test('redactList tolerates undefined/empty input', () => {
  assert.deepEqual(redactList(undefined), { items: [], redacted: false, findings: [] });
  assert.deepEqual(redactList([]), { items: [], redacted: false, findings: [] });
});

// ---------------------------------------------------------------------------
// mergeFindings / formatRedactionNotice
// ---------------------------------------------------------------------------

test('mergeFindings dedupes across multiple field-level finding lists', () => {
  assert.deepEqual(
    mergeFindings(['url-password'], ['openai-style-key', 'url-password'], []),
    ['url-password', 'openai-style-key'],
  );
});

test('formatRedactionNotice is empty for no findings, else names the count + patterns', () => {
  assert.equal(formatRedactionNotice([]), '');
  assert.match(formatRedactionNotice(['url-password']), /Redacted 1 potential secret pattern\(s\)/);
  assert.match(formatRedactionNotice(['url-password']), /url-password/);
  assert.match(formatRedactionNotice(['url-password', 'jwt']), /Redacted 2 potential secret pattern\(s\)/);
});
