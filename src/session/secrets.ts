/**
 * secrets.ts -- cheap pattern-based secret detection + in-place redaction for
 * the session-capture free-text fields (MCP-SERVER-IMPROVEMENTS.md #2).
 *
 * Nothing previously filtered `query` / `summary` / `caveats` / `content` /
 * `context` / `decision` / `insteadOf` before they were embedded and written
 * to Postgres -- a key-shaped string in any of those fields was persisted
 * verbatim and then replayed into future model contexts indefinitely via
 * recallSimilar. This module runs a single pattern pass over each field at
 * record time (see SessionStore.record{Event,Decision,Learning} in
 * ./store.ts, which calls it before embedding or inserting anything).
 *
 * Default posture is REDACT-IN-PLACE + NOTE, not refuse: a refusal on a
 * session-capture write silently loses the whole record when the calling
 * agent does not retry (unlike e.g. SettingsStore's SecretStr refusal, which
 * blocks a config load the caller controls and can immediately fix).
 *
 * Deliberately narrow scope -- key-SHAPED strings only (high-precision
 * patterns), not a general secrets scanner. False negatives on exotic key
 * formats are expected and acceptable; false positives that mangle ordinary
 * prose are not, so every pattern requires a structural marker (a known
 * prefix, a fixed length run, or a password-in-URL shape) rather than
 * heuristics like "looks random".
 */

export interface RedactionResult {
  /** The input with any matched spans replaced by a masked placeholder. */
  text: string;
  /** True iff at least one pattern fired. */
  redacted: boolean;
  /** Deduplicated pattern names that fired, in pattern-definition order. */
  findings: string[];
}

interface SecretPattern {
  /** Short machine name surfaced in the redaction notice, e.g. "aws-access-key". */
  name: string;
  /** Must be a global regex -- reused via String#replace per call, never `exec`'d statefully. */
  regex: RegExp;
  /** Given one matched span, return its masked replacement. */
  redact: (match: string) => string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    // scheme://user:PASSWORD@host -- only the password segment is masked, so
    // `postgresql://user:pass@host` becomes `postgresql://user:****@host`.
    // The doc's own example DSN motivated this pattern directly.
    name: 'url-password',
    regex:
      /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:)([^\s@]+)(@)/gi,
    redact: (match) =>
      match.replace(
        /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s:/@]+:)([^\s@]+)(@)/i,
        '$1****$3',
      ),
  },
  {
    // OpenAI / OpenAI-compatible secret keys (`sk-...`, `sk-proj-...`, etc.).
    name: 'openai-style-key',
    regex: /\bsk-[A-Za-z0-9_-]{10,}\b/g,
    redact: () => 'sk-****',
  },
  {
    // AWS access key id -- fixed 16-char uppercase-alnum suffix after AKIA.
    name: 'aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    redact: () => 'AKIA****',
  },
  {
    // Google OAuth client secret.
    name: 'google-oauth-secret',
    regex: /\bGOCSPX-[A-Za-z0-9_-]{10,}\b/g,
    redact: () => 'GOCSPX-****',
  },
  {
    // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
    // ghs_ (server-to-server), ghr_ (refresh).
    name: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    redact: (match) => `${match.slice(0, 4)}****`,
  },
  {
    // JWT shape: three base64url segments separated by dots, starting with
    // the near-universal `eyJ` header prefix (base64 of `{"`).
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    redact: () => 'eyJ****',
  },
];

/** Run every pattern once over `text`, in pattern-definition order. */
export function redactSecrets(text: string): RedactionResult {
  let out = text;
  const findings: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const before = out;
    out = out.replace(pattern.regex, (m) => pattern.redact(m));
    if (out !== before) findings.push(pattern.name);
  }
  return { text: out, redacted: findings.length > 0, findings };
}

/**
 * Same as {@link redactSecrets} but tolerant of `null`/`undefined` (the
 * common shape of an optional free-text field like `insteadOf`/`context`) --
 * passes the nullish value through unchanged rather than coercing it to `''`.
 */
export function redactOptional(
  text: string | null | undefined,
): { text: string | undefined; redacted: boolean; findings: string[] } {
  if (text == null) return { text: undefined, redacted: false, findings: [] };
  const r = redactSecrets(text);
  return { text: r.text, redacted: r.redacted, findings: r.findings };
}

/** Map {@link redactSecrets} over a string array (e.g. `caveats`), merging findings. */
export function redactList(
  items: string[] | undefined,
): { items: string[]; redacted: boolean; findings: string[] } {
  if (!items || items.length === 0) return { items: items ?? [], redacted: false, findings: [] };
  const findingSet = new Set<string>();
  let redacted = false;
  const out = items.map((item) => {
    const r = redactSecrets(item);
    if (r.redacted) {
      redacted = true;
      for (const f of r.findings) findingSet.add(f);
    }
    return r.text;
  });
  return { items: out, redacted, findings: [...findingSet] };
}

/** Dedupe + flatten findings lists from multiple fields on the same record. */
export function mergeFindings(...lists: string[][]): string[] {
  return [...new Set(lists.flat())];
}

/** Human-readable one-line notice for a tool result, or `''` if nothing fired. */
export function formatRedactionNotice(findings: string[]): string {
  if (findings.length === 0) return '';
  return `Redacted ${findings.length} potential secret pattern(s) before recording: ${findings.join(', ')}.`;
}
