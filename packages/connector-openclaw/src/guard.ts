import type { ContentGuard } from "./governance.js";

/**
 * Patterns that close the "you gate the verb, never the payload" critique. Each
 * scans the JSON-serialized params (so it sees nested bodies, headers, attachments)
 * and is deterministic — the same input always blocks. No model, no heuristics that
 * a prompt can argue with.
 */

// Credential shapes. Anchored on the literal prefixes so they don't false-fire on prose.
const API_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/, "an API key (sk-… secret-key shape)"],
  [/mk_[0-9a-f]{32}\b/, "a MakerChecker admin key (mk_… shape)"],
  [/AKIA[0-9A-Z]{16}\b/, "an AWS access key id (AKIA… shape)"],
];

// 13–16 digit runs (optionally space/hyphen grouped) that pass Luhn — i.e. real
// card numbers, not arbitrary long integers like ids or timestamps.
const CARD_CANDIDATE = /\b(?:\d[ -]?){13,16}\b/g;
// US SSN: 3-2-4 with separators (bare 9-digit runs are too noisy to claim as SSNs).
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function hasCardNumber(haystack: string): boolean {
  const matches = haystack.match(CARD_CANDIDATE);
  if (matches === null) return false;
  for (const m of matches) {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 16 && luhnOk(digits)) return true;
  }
  return false;
}

function countEmails(haystack: string): number {
  const matches = haystack.match(EMAIL_PATTERN);
  return matches === null ? 0 : new Set(matches.map((m) => m.toLowerCase())).size;
}

export interface DlpGuardOptions {
  /** Block when the body holds at least this many DISTINCT email addresses (bulk exfil). */
  maxEmails?: number;
  /** Case-insensitive substrings that, if present, block (e.g. "CONFIDENTIAL"). */
  markers?: readonly string[];
}

/**
 * Build a deterministic ContentGuard. It blocks a tool's params (the actual body
 * being sent, not just the recipient) when they carry: a credential, a bulk set of
 * email addresses, a credit-card or SSN shape, or any caller-supplied marker. The
 * first match wins and names itself in the reason. Returns null (pass) on clean
 * content. Same input -> same decision, so it cannot be prompt-engineered open.
 */
export function dlpGuard(opts: DlpGuardOptions = {}): ContentGuard {
  const maxEmails = opts.maxEmails ?? 5;
  const markers = (opts.markers ?? []).map((m) => m.toLowerCase());
  return (_toolName, params) => {
    const body = JSON.stringify(params ?? {});
    const lower = body.toLowerCase();

    for (const marker of markers) {
      if (marker.length > 0 && lower.includes(marker)) {
        return { reason: `body contains a confidential marker ("${marker}")` };
      }
    }
    for (const [re, label] of API_KEY_PATTERNS) {
      if (re.test(body)) {
        return { reason: `body contains ${label}` };
      }
    }
    if (hasCardNumber(body)) {
      return { reason: "body contains a credit-card number (Luhn-valid)" };
    }
    if (SSN_PATTERN.test(body)) {
      return { reason: "body contains a US Social Security Number shape" };
    }
    const emails = countEmails(body);
    if (emails >= maxEmails) {
      return { reason: `body contains ${emails} email addresses (>= ${maxEmails}; bulk recipient leak)` };
    }
    return null;
  };
}
