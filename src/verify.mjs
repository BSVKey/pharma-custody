// Verify a shipment's custody package against pinned custodian keys and the raw logger data.
//
// package: { shipmentId, spec: { minC, maxC, budgetMinutes, intervalMs }, handoffs: [...],
//            legs: [...], release }
// custodianPubs: { custodianId: publicKey }   the verifier's own pinned keys
// logs: Map loggerId -> samples [[t, c], ...]  the logger exports the verifier holds
//
// Checks: every record is intact and signed by the pinned key of the custodian it names;
// handoffs chain from the origin to the final receiver with one unit set; each custodian's
// leg covers its custody window and matches the raw logger data exactly (fingerprint and
// re-computed analysis); custody time not covered by any leg is reported; the release
// decision follows from the re-computed totals. Excursions and gaps are attributed to the
// custodian that held the shipment at the time.
import { verifyRecord } from "../lib/receipt.mjs";
import { windowOf, fingerprint, analyse } from "./logger.mjs";

const canon = (x) => JSON.stringify(x);

export function verifyShipment(pkg, { custodianPubs, logs }) {
  const problems = [];
  const bad = (reason, detail = {}) => problems.push({ reason, ...detail });
  const signedBy = (r, custodian) => {
    const v = verifyRecord(r);
    if (!v.ok) { bad(v.reason, { claimId: r?.claimId, kind: r?.kind }); return false; }
    if (!custodianPubs[custodian]) { bad("custodian_not_pinned", { custodian }); return false; }
    if (v.signer !== custodianPubs[custodian]) { bad("signer_not_pinned_custodian_key", { custodian, kind: r.kind }); return false; }
    if (r.shipmentId !== pkg.shipmentId) { bad("wrong_shipment", { claimId: r.claimId }); return false; }
    return true;
  };

  // 1. Handoff chain: receiver signs, each names the previous, one unit set throughout.
  const hs = pkg.handoffs || [];
  if (!hs.length) bad("no_handoffs");
  hs.forEach((h, i) => {
    signedBy(h, h.to);
    if (i === 0 && h.prev !== null) bad("first_handoff_has_prev");
    if (i > 0) {
      if (h.prev !== hs[i - 1].claimId) bad("handoff_chain_break", { index: i });
      if (h.from !== hs[i - 1].to) bad("handoff_custodian_mismatch", { index: i });
      if (h.at < hs[i - 1].at) bad("handoff_time_regression", { index: i });
      if (h.unitsRoot !== hs[0].unitsRoot || h.unitCount !== hs[0].unitCount) bad("units_changed_in_transit", { index: i, at: h.to });
    }
  });

  // Custody windows: custodian of handoff i holds from its handoff until the next one.
  const windows = hs.slice(0, -1).map((h, i) => ({ custodian: h.to, from: h.at, to: hs[i + 1].at }));

  // 2. Legs: signed by the custodian, inside its window, matching the raw logger data.
  const attributed = [];
  let excursionMinutes = 0, gapMinutes = 0;
  for (const l of pkg.legs || []) {
    if (!signedBy(l, l.custodian)) continue;
    const w = windows.find((x) => x.custodian === l.custodian && l.from >= x.from && l.to <= x.to);
    if (!w) { bad("leg_outside_custody_window", { custodian: l.custodian }); continue; }
    const samples = logs.get(l.loggerId);
    if (!samples) { bad("logger_data_missing", { loggerId: l.loggerId }); continue; }
    const win = windowOf(samples, l.from, l.to);
    if (fingerprint(win) !== l.fingerprint) { bad("logger_data_does_not_match_leg", { custodian: l.custodian, loggerId: l.loggerId }); continue; }
    const again = analyse(win, { ...pkg.spec, from: l.from, to: l.to });
    if (canon(again) !== canon(l.analysis)) { bad("leg_analysis_misstated", { custodian: l.custodian }); continue; }
    excursionMinutes += again.excursionMinutes;
    gapMinutes += again.gapMinutes;
    for (const e of again.excursions) attributed.push({ type: "excursion", custodian: l.custodian, ...e });
    for (const g of again.gaps) attributed.push({ type: "logger_gap", custodian: l.custodian, ...g });
  }

  // 3. Custody time with no leg at all is itself a finding.
  for (const w of windows) {
    const covered = (pkg.legs || []).filter((l) => l.custodian === w.custodian).reduce((a, l) => a + (l.to - l.from), 0);
    const missing = w.to - w.from - covered;
    if (missing > 60000) attributed.push({ type: "unaccounted_custody", custodian: w.custodian, start: w.from, end: w.to, minutes: Math.round((missing / 60000) * 10) / 10 });
  }

  // 4. Release: signed by the final receiver; decision must follow from the recomputed totals.
  const r = pkg.release;
  let decision = null;
  excursionMinutes = Math.round(excursionMinutes * 10) / 10;
  gapMinutes = Math.round(gapMinutes * 10) / 10;
  // Logger gaps are unknown temperature. By default (spec.gapsCount !== false) they count
  // against the excursion budget, the conservative choice; custody time with no leg at
  // all always forces quarantine.
  const charged = excursionMinutes + (pkg.spec.gapsCount === false ? 0 : gapMinutes);
  const expected = charged <= pkg.spec.budgetMinutes && !attributed.some((a) => a.type === "unaccounted_custody") ? "release" : "quarantine";
  if (!r) bad("no_release");
  else if (signedBy(r, hs.at(-1)?.to)) {
    decision = r.decision;
    if (r.excursionMinutes !== excursionMinutes) bad("release_misstates_excursion_time", { stated: r.excursionMinutes, actual: excursionMinutes });
    if (r.decision !== expected) bad("release_decision_inconsistent", { stated: r.decision, expected });
  }

  return { ok: problems.length === 0, problems, decision, expected, excursionMinutes, gapMinutes, chargedMinutes: Math.round(charged * 10) / 10, budgetMinutes: pkg.spec.budgetMinutes, attributed };
}
