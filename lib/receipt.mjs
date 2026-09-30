// Signed, content-addressed records: the manifest (payload root), per-hop custody
// receipts, and the delivery receipt with its settlement binding. Every record is
// content-addressed (claimId = contentId) and signed; a verifier recomputes the id
// and checks the signature under the carried public key (production recovers it).
import { contentId } from "./canonical.mjs";
import { signClaim, verifySig } from "./keys.mjs";

// Sign any content object -> content + claimId + sig + signerPub.
export function signRecord(kp, content) {
  const claimId = contentId(content);
  return { ...content, claimId, sig: signClaim(kp.priv, claimId), signerPub: kp.pub };
}

// Verify a record is internally consistent and recover (here: read + check) its
// signer. { ok:true, signer } / { ok:false, reason }.
export function verifyRecord(rec) {
  if (rec === null || typeof rec !== "object") return { ok: false, reason: "not_an_object" };
  if (contentId(rec).toLowerCase() !== String(rec.claimId).toLowerCase()) {
    return { ok: false, reason: "claimId_mismatch" };
  }
  if (!rec.signerPub || !rec.sig) return { ok: false, reason: "missing_credential" };
  if (!verifySig(rec.signerPub, rec.claimId, rec.sig)) return { ok: false, reason: "signature_invalid" };
  return { ok: true, signer: rec.signerPub };
}

// ---- Manifest: the signed root of the chunked payload -----------------------------
export function buildManifest({ payloadId, chunkCount, root, meta }) {
  return { kind: "manifest/1", payloadId, chunkCount, root, meta: meta || {} };
}

// ---- Custody receipt: one per hop, forming the custody chain -----------------------
export function custodyReceipt(kp, { payloadId, bundleId, prevHop, thisHop, receivedAt, forwardedAt }) {
  return signRecord(kp, { kind: "custody/1", payloadId, bundleId, prevHop, thisHop, receivedAt, forwardedAt });
}

// Verify a whole bundle's custody chain: each receipt verifies, its signer is the
// pinned key for that hop, the bundleId matches, and prevHop/thisHop link with no
// gap. `hops` is the ordered [{ eid, pub }] the verifier expects.
export function verifyCustodyChain(receipts, { bundleId, hops }) {
  if (!Array.isArray(receipts) || receipts.length === 0) return { ok: false, reason: "empty_chain" };
  if (receipts.length !== hops.length) return { ok: false, reason: "wrong_hop_count" };
  let prevEid = null;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const v = verifyRecord(r);
    if (!v.ok) return { ok: false, reason: v.reason, hop: i };
    if (r.bundleId !== bundleId) return { ok: false, reason: "wrong_bundle", hop: i };
    if (r.thisHop !== hops[i].eid) return { ok: false, reason: "unexpected_hop", hop: i };
    if (v.signer !== hops[i].pub) return { ok: false, reason: "signer_not_pinned_hop_key", hop: i };
    if (prevEid !== null && r.prevHop !== prevEid) return { ok: false, reason: "custody_chain_break", hop: i };
    prevEid = r.thisHop;
  }
  return { ok: true, hops: receipts.length };
}

// ---- Delivery receipt + settlement binding ----------------------------------------
export function deliveryReceipt(kp, { payloadId, root, rail, network, settlementRef, payTo, amountAtomic }) {
  return signRecord(kp, {
    kind: "delivery/1", payloadId, root, rail, network, settlementRef, payTo, amountAtomic,
  });
}

// Bind the delivery to the payment the VERIFIER made. Same rule as bindX402Receipt in
// @bsvkey/x402-bsv-client: settlementRef is REQUIRED (unbound = refuse, not skip), and
// the expected values come from the verifier's own context, never from the receipt.
export function bindDelivery(receipt, expected = {}) {
  if (!expected || typeof expected !== "object" || !expected.settlementRef) {
    return { ok: false, reason: "unbound: verifier must supply the settlementRef it paid" };
  }
  // settlementRef is a hex txid, so case does not matter; payTo is a Base58
  // address, where it does, so that one is compared exactly.
  const hexEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  if (!hexEq(receipt.settlementRef, expected.settlementRef)) return { ok: false, reason: "settlementRef_not_mine" };
  if (expected.payTo !== undefined && String(receipt.payTo) !== String(expected.payTo)) return { ok: false, reason: "payTo_mismatch" };
  if (expected.amountAtomic !== undefined && Number(receipt.amountAtomic) !== Number(expected.amountAtomic)) {
    return { ok: false, reason: "amount_mismatch" };
  }
  return { ok: true };
}
