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
//
// Units are identified as DSCSA product identifiers (GTIN, serial, lot, expiry). The set of
// units in a shipment is committed as a Merkle root, so any single pack can later be proven
// part of the shipment without revealing the rest.
import { signRecord } from "../lib/receipt.mjs";
import { leafHash, buildTree, proof, verifyProof } from "../lib/merkle.mjs";

export const unitKey = (u) => `${u.gtin}|${u.serial}|${u.lot}|${u.expiry}`;

export function commitUnits(units) {
  const keys = [...new Set(units.map(unitKey))].sort();
  if (keys.length === 0) throw new Error("commitUnits: no units");
  const tree = buildTree(keys.map((k) => leafHash(Buffer.from(k, "utf8"))));
  return { root: tree.root, count: keys.length, keys, tree };
}
export function unitProof(commitment, unit) {
  const i = commitment.keys.indexOf(unitKey(unit));
  return i < 0 ? null : { index: i, branch: proof(commitment.tree, i) };
}
export const unitInShipment = (root, count, unit, p) => !!p && p.index >= 0 && p.index < count && verifyProof(leafHash(Buffer.from(unitKey(unit), "utf8")), p.branch, p.index, root);

export function handoff(kp, { shipmentId, from, to, at, unitsRoot, unitCount, prev = null, receivedTempC = null }) {
  return signRecord(kp, { kind: "pharma.handoff/1", shipmentId, from, to, at, unitsRoot, unitCount, prev, receivedTempC });
}

export function leg(kp, { shipmentId, custodian, loggerId, from, to, spec, fingerprint, analysis }) {
  return signRecord(kp, { kind: "pharma.leg/1", shipmentId, custodian, loggerId, from, to, spec, fingerprint, analysis });
}

export function release(kp, { shipmentId, by, at, budgetMinutes, excursionMinutes, gapMinutes, decision, legs }) {
  return signRecord(kp, { kind: "pharma.release/1", shipmentId, by, at, budgetMinutes, excursionMinutes, gapMinutes, decision, legs });
}
