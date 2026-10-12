// Signed records for a pharmaceutical shipment's chain of custody.
//
//   pharma.handoff/1  signed by the RECEIVING custodian: "at this time I received this
//                     shipment from that custodian, these units, in this condition". Each
//                     handoff names the previous one, forming a chain.
//   pharma.leg/1      signed by a custodian for the time it held the shipment: the logger,
//                     the window, a fingerprint of exactly the samples in that window,
//                     and what they show (range, excursions, gaps).
//   pharma.release/1  signed by the final receiver's quality function: cumulative
//                     excursion time against the product's stability budget, logger gaps,
//                     and the decision (release or quarantine).
//   pharma.correction/1  signed by the author of an earlier leg: "that leg was wrong, for
//                     this reason, and this leg replaces it". The wrong leg is never
//                     edited or deleted; it stays in the package, marked superseded.
//                     Modelled on the GS1 EPCIS 2.0 ErrorDeclaration: a correction of the
//                     record is not the same thing as a new event in the world.
//   pharma.estimate/1 signed by a custodian: a MODELLED temperature range for a stretch
//                     where its logger was silent. Labelled as modelled, reported apart
//                     from observations, and never used to shrink a logger gap.
//
// Every record carries two times: when the thing happened (at, or a leg's to) and when it
// was recorded (recordedAt). The verifier judges the release against what had been
// recorded by the time of the decision, so evidence that arrives later is reported as
// later evidence instead of silently rewriting what the decision-maker knew.
//
// Units are identified as DSCSA product identifiers (GTIN, serial, lot, expiry). The set of
// units in a shipment is committed as a Merkle root over SALTED leaves, so any single pack
// can be proven part of the shipment without revealing the rest. Without the salt, a proof
// would hand over the neighbouring packs' leaf hashes, and sequential serials make those
// easy to guess. Each pack's salt stays with the shipper and goes only to whoever holds
// that pack; leaves are ordered by their salted hash, so a pack's position says nothing
// about its serial.
import { randomBytes } from "node:crypto";
import { signRecord } from "../lib/receipt.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

export const UNITS_SCHEME = "salted-leaf/1";
export const unitKey = (u) => `${u.gtin}|${u.serial}|${u.lot}|${u.expiry}`;
const unitLeaf = (salt, unit) => leafHash(Buffer.from(`${salt}|${unitKey(unit)}`, "utf8"));
const SALT_RE = /^[0-9a-f]{32}$/;

// saltOf(key) can be supplied to make a commitment reproducible (tests, or salts derived
// from a shipper secret); by default every pack gets 16 fresh random bytes.
export function commitUnits(units, { saltOf = () => randomBytes(16).toString("hex") } = {}) {
  const byKey = new Map(units.map((u) => [unitKey(u), u]));
  if (byKey.size === 0) throw new Error("commitUnits: no units");
  const entries = [...byKey].map(([key, u]) => {
    const salt = saltOf(key);
    if (!SALT_RE.test(salt)) throw new Error("commitUnits: salt must be 32 lowercase hex characters");
    return { key, salt, leaf: unitLeaf(salt, u) };
  }).sort((a, b) => (a.leaf < b.leaf ? -1 : a.leaf > b.leaf ? 1 : 0));
  const tree = buildTree(entries.map((e) => e.leaf));
  return { root: tree.root, count: entries.length, scheme: UNITS_SCHEME, entries, tree };
}
// The proof for one pack: its salt, position and branch. Hand it only to that pack's holder.
export function unitProof(commitment, unit) {
  const i = commitment.entries.findIndex((e) => e.key === unitKey(unit));
  return i < 0 ? null : { index: i, salt: commitment.entries[i].salt, branch: proof(commitment.tree, i) };
}
export const unitInShipment = (root, count, unit, p) => !!p && SALT_RE.test(p.salt) && p.index >= 0 && p.index < count && verifyProof(unitLeaf(p.salt, unit), p.branch, p.index, root);

export function handoff(kp, { shipmentId, from, to, at, recordedAt = at, unitsRoot, unitCount, unitsScheme = UNITS_SCHEME, prev = null, receivedTempC = null }) {
  return signRecord(kp, { kind: "pharma.handoff/1", shipmentId, from, to, at, recordedAt, unitsRoot, unitCount, unitsScheme, prev, receivedTempC });
}

export function leg(kp, { shipmentId, custodian, loggerId, from, to, recordedAt = to, spec, fingerprint, analysis }) {
  return signRecord(kp, { kind: "pharma.leg/1", shipmentId, custodian, loggerId, from, to, recordedAt, spec, fingerprint, analysis });
}

export function release(kp, { shipmentId, by, at, recordedAt = at, budgetMinutes, excursionMinutes, gapMinutes, decision, legs }) {
  return signRecord(kp, { kind: "pharma.release/1", shipmentId, by, at, recordedAt, budgetMinutes, excursionMinutes, gapMinutes, decision, legs });
}

// corrects: claimId of the wrong leg. replacedBy: claimId of the leg that replaces it, or
// null when the leg is simply withdrawn.
export function correction(kp, { shipmentId, by, corrects, replacedBy = null, reason, recordedAt }) {
  return signRecord(kp, { kind: "pharma.correction/1", shipmentId, by, corrects, replacedBy, reason, recordedAt });
}

export function estimate(kp, { shipmentId, custodian, from, to, minC, maxC, method, recordedAt }) {
  return signRecord(kp, { kind: "pharma.estimate/1", basis: "modelled", shipmentId, custodian, from, to, minC, maxC, method, recordedAt });
}
