// Verify a shipment's custody package against pinned custodian keys and the raw logger data.
//
// package: { shipmentId, spec: { minC, maxC, budgetMinutes, intervalMs }, handoffs: [...],
//            legs: [...], release, corrections?: [...], estimates?: [...] }
// custodianPubs: { custodianId: publicKey }   the verifier's own pinned keys
// logs: Map loggerId -> samples [[t, c], ...]  the logger exports the verifier holds
//
// Checks: every record is intact and signed by the pinned key of the custodian it names;
// handoffs chain from the origin to the final receiver with one unit set; each custodian's
// leg covers its custody window and matches the raw logger data exactly (fingerprint and
// re-computed analysis); custody time not covered by any leg is reported; the release
// decision follows from the re-computed totals. Excursions and gaps are attributed to the
// custodian that held the shipment at the time.
//
// Corrections: a leg can be declared wrong by its own author, optionally naming the leg
// that replaces it. The wrong leg stays in the package and in `history`; it just stops
// counting. Only the author can correct a leg.
//
// Two views: the release is judged against what had been RECORDED by the time of the
// decision (asKnown: records and corrections with recordedAt <= release.at). The `current`
// view uses everything. If later evidence would change the decision, that is reported as a
// finding, not hidden and not held against the release.
//
// Estimates: modelled temperatures for a logger gap are listed under `modelled`, kept apart
// from observations, and never reduce gap time.
import { verifyRecord } from "../lib/receipt.mjs";
import { windowOf, fingerprint, analyse } from "./logger.mjs";

const canon = (x) => JSON.stringify(x);
const round1 = (x) => Math.round(x * 10) / 10;
const known = (rec, asOf) => rec.recordedAt === undefined || rec.recordedAt <= asOf;

export function verifyShipment(pkg, { custodianPubs, logs }) {
  const problems = [];
  const findings = [];
  const bad = (reason, detail = {}) => problems.push({ reason, ...detail });
  const signedBy = (r, custodian) => {
    const v = verifyRecord(r);
    if (!v.ok) { bad(v.reason, { claimId: r?.claimId, kind: r?.kind }); return false; }
    if (!custodianPubs[custodian]) { bad("custodian_not_pinned", { custodian }); return false; }
    if (v.signer !== custodianPubs[custodian]) { bad("signer_not_pinned_custodian_key", { custodian, kind: r.kind }); return false; }
    if (r.shipmentId !== pkg.shipmentId) { bad("wrong_shipment", { claimId: r.claimId }); return false; }
    return true;
  };
  // A record cannot have been written before the thing it describes happened.
  const recordedAfter = (r, eventAt) => {
    if (r.recordedAt !== undefined && r.recordedAt < eventAt) bad("recorded_before_event", { claimId: r.claimId, kind: r.kind });
  };

  // 1. Handoff chain: receiver signs, each names the previous, one unit set throughout.
  const hs = pkg.handoffs || [];
  if (!hs.length) bad("no_handoffs");
  hs.forEach((h, i) => {
    signedBy(h, h.to);
    recordedAfter(h, h.at);
    if (i === 0 && h.prev !== null) bad("first_handoff_has_prev");
    if (i > 0) {
      if (h.prev !== hs[i - 1].claimId) bad("handoff_chain_break", { index: i });
      if (h.from !== hs[i - 1].to) bad("handoff_custodian_mismatch", { index: i });
      if (h.at < hs[i - 1].at) bad("handoff_time_regression", { index: i });
      if (h.unitsRoot !== hs[0].unitsRoot || h.unitCount !== hs[0].unitCount || h.unitsScheme !== hs[0].unitsScheme) bad("units_changed_in_transit", { index: i, at: h.to });
    }
  });

  // Custody windows: custodian of handoff i holds from its handoff until the next one.
  const windows = hs.slice(0, -1).map((h, i) => ({ custodian: h.to, from: h.at, to: hs[i + 1].at }));

  // 2. Legs: signed by the custodian, inside its window, matching the raw logger data.
  // Every leg is checked, superseded or not: the history has to be intact too.
  const legs = new Map(); // claimId -> { leg, analysis }
  for (const l of pkg.legs || []) {
    if (!signedBy(l, l.custodian)) continue;
    recordedAfter(l, l.to);
    const w = windows.find((x) => x.custodian === l.custodian && l.from >= x.from && l.to <= x.to);
    if (!w) { bad("leg_outside_custody_window", { custodian: l.custodian }); continue; }
    const samples = logs.get(l.loggerId);
    if (!samples) { bad("logger_data_missing", { loggerId: l.loggerId }); continue; }
    const win = windowOf(samples, l.from, l.to);
    if (fingerprint(win) !== l.fingerprint) { bad("logger_data_does_not_match_leg", { custodian: l.custodian, loggerId: l.loggerId }); continue; }
    const again = analyse(win, { ...pkg.spec, from: l.from, to: l.to });
    if (canon(again) !== canon(l.analysis)) { bad("leg_analysis_misstated", { custodian: l.custodian }); continue; }
    legs.set(l.claimId, { leg: l, analysis: again });
  }

  // 3. Corrections: by the author of the corrected leg, naming a real replacement if any.
  const corrections = [];
  for (const c of pkg.corrections || []) {
    if (!signedBy(c, c.by)) continue;
    if (c.kind !== "pharma.correction/1") { bad("not_a_correction", { claimId: c.claimId }); continue; }
    const target = (pkg.legs || []).find((l) => l.claimId === c.corrects);
    if (!target) { bad("correction_target_missing", { corrects: c.corrects }); continue; }
    if (target.custodian !== c.by) { bad("correction_not_by_author", { corrects: c.corrects, by: c.by }); continue; }
    if (c.recordedAt === undefined || (target.recordedAt !== undefined && c.recordedAt < target.recordedAt)) { bad("correction_before_target", { claimId: c.claimId }); continue; }
    if (c.replacedBy !== null) {
      const repl = (pkg.legs || []).find((l) => l.claimId === c.replacedBy);
      if (!repl || repl.claimId === c.corrects) { bad("replacement_missing", { replacedBy: c.replacedBy }); continue; }
      if (repl.custodian !== c.by) { bad("replacement_wrong_custodian", { replacedBy: c.replacedBy }); continue; }
    }
    corrections.push(c);
  }
  const replacements = new Set(corrections.map((c) => c.replacedBy).filter(Boolean));

  // 4. One view of the evidence as of a time.
  const view = (asOf) => {
    const cs = corrections.filter((c) => c.recordedAt <= asOf);
    const superseded = new Set(cs.map((c) => c.corrects));
    const liveReplacements = new Set(cs.map((c) => c.replacedBy).filter(Boolean));
    const effective = [...legs.values()].filter(({ leg: l }) =>
      known(l, asOf) && !superseded.has(l.claimId) && (!replacements.has(l.claimId) || liveReplacements.has(l.claimId)));
    const attributed = [];
    let excursionMinutes = 0, gapMinutes = 0, overlapping = false;
    for (const { leg: l, analysis } of effective) {
      excursionMinutes += analysis.excursionMinutes;
      gapMinutes += analysis.gapMinutes;
      for (const e of analysis.excursions) attributed.push({ type: "excursion", custodian: l.custodian, ...e });
      for (const g of analysis.gaps) attributed.push({ type: "logger_gap", custodian: l.custodian, ...g });
    }
    for (const a of effective) for (const b of effective) {
      if (a !== b && a.leg.custodian === b.leg.custodian && a.leg.from < b.leg.to && b.leg.from < a.leg.to) overlapping = true;
    }
    // Custody time with no leg at all is itself a finding.
    for (const w of windows) {
      const covered = effective.filter(({ leg: l }) => l.custodian === w.custodian).reduce((a, { leg: l }) => a + (l.to - l.from), 0);
      const missing = w.to - w.from - covered;
      if (missing > 60000) attributed.push({ type: "unaccounted_custody", custodian: w.custodian, start: w.from, end: w.to, minutes: round1(missing / 60000) });
    }
    excursionMinutes = round1(excursionMinutes);
    gapMinutes = round1(gapMinutes);
    // Logger gaps are unknown temperature. By default (spec.gapsCount !== false) they count
    // against the excursion budget, the conservative choice; custody time with no leg at
    // all always forces quarantine.
    const charged = round1(excursionMinutes + (pkg.spec.gapsCount === false ? 0 : gapMinutes));
    const expected = charged <= pkg.spec.budgetMinutes && !attributed.some((a) => a.type === "unaccounted_custody") ? "release" : "quarantine";
    return { excursionMinutes, gapMinutes, chargedMinutes: charged, expected, attributed, overlapping, legIds: effective.map(({ leg: l }) => l.claimId), superseded: [...superseded] };
  };

  // 5. Release: signed by the final receiver, judged on what was recorded by its decision time.
  const r = pkg.release;
  if (!r) bad("no_release");
  const decisionAt = r ? r.at : Infinity;
  const asKnown = view(decisionAt);
  const current = view(Infinity);
  if (asKnown.overlapping || current.overlapping) bad("overlapping_legs");
  let decision = null;
  if (r && signedBy(r, hs.at(-1)?.to)) {
    recordedAfter(r, r.at);
    decision = r.decision;
    if (r.excursionMinutes !== asKnown.excursionMinutes) bad("release_misstates_excursion_time", { stated: r.excursionMinutes, actual: asKnown.excursionMinutes });
    if (r.decision !== asKnown.expected) bad("release_decision_inconsistent", { stated: r.decision, expected: asKnown.expected });
    if (Array.isArray(r.legs) && canon([...r.legs].sort()) !== canon([...asKnown.legIds].sort())) bad("release_lists_wrong_legs");
  }
  if (r && current.expected !== asKnown.expected) {
    findings.push({ type: "decision_changed_by_later_evidence", atDecision: asKnown.expected, now: current.expected });
  }

  // 6. Estimates: modelled, inside a stretch with no observations, reported apart.
  const unknownStretches = current.attributed.filter((a) => a.type === "logger_gap" || a.type === "unaccounted_custody");
  const modelled = [];
  for (const e of pkg.estimates || []) {
    if (!signedBy(e, e.custodian)) continue;
    if (e.basis !== "modelled") { bad("estimate_not_labelled_modelled", { claimId: e.claimId }); continue; }
    const inside = unknownStretches.some((g) => g.custodian === e.custodian && e.from >= g.start && e.to <= g.end);
    if (!inside) { bad("estimate_overlaps_observed_data", { claimId: e.claimId }); continue; }
    modelled.push({ custodian: e.custodian, start: e.from, end: e.to, minC: e.minC, maxC: e.maxC, method: e.method, claimId: e.claimId });
  }

  const history = corrections.map((c) => ({ type: "superseded", leg: c.corrects, replacedBy: c.replacedBy, reason: c.reason, by: c.by, recordedAt: c.recordedAt, knownAtDecision: c.recordedAt <= decisionAt }));

  return {
    ok: problems.length === 0, problems, findings, decision,
    expected: asKnown.expected, excursionMinutes: asKnown.excursionMinutes, gapMinutes: asKnown.gapMinutes,
    chargedMinutes: asKnown.chargedMinutes, budgetMinutes: pkg.spec.budgetMinutes, attributed: asKnown.attributed,
    current: { expected: current.expected, excursionMinutes: current.excursionMinutes, gapMinutes: current.gapMinutes, chargedMinutes: current.chargedMinutes, attributed: current.attributed },
    history, modelled,
  };
}
