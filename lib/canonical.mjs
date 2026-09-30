// Canonical JSON + content addressing, byte-identical route to the BSVKey receipts:
// recursive key-sort + JSON.stringify, then sha256, id = '0x' + hex. Rail-neutral.
import { createHash } from "node:crypto";

const MAX_DEPTH = 32;

function sortKeysDeep(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`nesting exceeds max depth ${MAX_DEPTH}`);
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k], depth + 1);
    return out;
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value, 0));
}

export function sha256hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

// Content address of an object over its content fields (everything except the
// credential fields claimId/sig/signerPub, which are added after hashing).
const CREDENTIAL_FIELDS = new Set(["claimId", "sig", "signerPub"]);
export function pickContent(obj) {
  const c = {};
  for (const k of Object.keys(obj)) if (!CREDENTIAL_FIELDS.has(k)) c[k] = obj[k];
  return c;
}
export function contentId(obj) {
  return "0x" + sha256hex(canonicalize(pickContent(obj)));
}
