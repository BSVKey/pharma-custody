import test from "node:test";
import assert from "node:assert/strict";
import { genKeypair } from "../lib/keys.mjs";
import { signRecord } from "../lib/receipt.mjs";
import { parseLoggerCsv, analyse, windowOf } from "../src/logger.mjs";
import { buildShipment } from "../src/shipment.mjs";
import { verifyShipment } from "../src/verify.mjs";
import { unitProof, unitInShipment } from "../src/records.mjs";

const T0 = Date.parse("2026-10-05T06:00:00Z"), MIN = 60000;
const spec = { minC: 2, maxC: 8, budgetMinutes: 30, intervalMs: 5 * MIN };
const series = (from, to, temp, skip = () => false) => { const s = []; for (let t = from; t <= to; t += 5 * MIN) if (!skip(t)) s.push([t, temp(t)]); return s; };

test("logger csv: columns found by name, ISO or epoch times, bad rows counted", () => {
  const { samples, rejected } = parseLoggerCsv("Time,Temperature\n2026-10-05T06:00:00Z,5.0\n1790748300000,5.5\nbad,row\n");
  assert.equal(samples.length, 2);
  assert.equal(rejected, 1);
  assert.throws(() => parseLoggerCsv("a,b\n1,2\n"), /column not found/);
});

test("analysis: excursions run until back in range; gaps include window edges", () => {
  const s = series(T0, T0 + 60 * MIN, (t) => (t >= T0 + 10 * MIN && t < T0 + 25 * MIN ? 9 : 5), (t) => t > T0 + 40 * MIN && t < T0 + 55 * MIN);
  const a = analyse(s, { ...spec, from: T0, to: T0 + 75 * MIN });
  assert.deepEqual(a.excursions.map((e) => [e.minutes, e.direction, e.peakC]), [[15, "high", 9]]);
  assert.deepEqual(a.gaps.map((g) => g.minutes), [15, 15]); // the silent stretch, and the trailing edge
});

function shipment({ gapAtDc = false, excursionMin = 10 } = {}) {
  const [a, b, c] = ["maker", "carrier", "pharmacy"].map((custodian) => ({ custodian, kp: genKeypair() }));
  const logs = new Map([["L1", series(T0, T0 + 4 * 60 * MIN, (t) => (t >= T0 + 90 * MIN && t < T0 + (90 + excursionMin) * MIN ? 11 : 5), (t) => gapAtDc && t > T0 + 150 * MIN && t < T0 + 200 * MIN)]]);
  const units = Array.from({ length: 50 }, (_, i) => ({ gtin: "00312345678906", serial: `S${i}`, lot: "L1", expiry: "2027-01-31" }));
  const built = buildShipment({
    shipmentId: "SHP-1", spec, units, logs,
    route: [{ ...a, at: T0 }, { ...b, at: T0 + 60 * MIN }, { ...c, at: T0 + 240 * MIN }],
    legs: [{ custodian: "maker", loggerId: "L1", from: T0, to: T0 + 60 * MIN }, { custodian: "carrier", loggerId: "L1", from: T0 + 60 * MIN, to: T0 + 240 * MIN }],
  });
  return { package: built.package, committed: built.units, logs, units, parties: { a, b, c }, pins: { maker: a.kp.pub, carrier: b.kp.pub, pharmacy: c.kp.pub } };
}

test("a clean package verifies from raw logger data and attributes the excursion", () => {
  const s = shipment();
  const v = verifyShipment(s.package, { custodianPubs: s.pins, logs: s.logs });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.decision, "release");
  assert.deepEqual(v.attributed.map((x) => [x.type, x.custodian, x.minutes]), [["excursion", "carrier", 10]]);
});

test("unknown temperature counts against the budget and forces quarantine", () => {
  const s = shipment({ gapAtDc: true });
  const v = verifyShipment(s.package, { custodianPubs: s.pins, logs: s.logs });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.decision, "quarantine");
  assert.ok(v.attributed.some((x) => x.type === "logger_gap" && x.custodian === "carrier"));
});

test("tampering with data, legs, handoffs, units or the release is caught", () => {
  const s = shipment();
  const run = (mutate) => { const p = structuredClone(s.package); const logs = new Map(s.logs); mutate(p, logs); return verifyShipment(p, { custodianPubs: s.pins, logs }).problems.map((x) => x.reason); };
  assert.ok(run((p, logs) => logs.set("L1", logs.get("L1").filter(([, c]) => c < 8))).includes("logger_data_does_not_match_leg"));
  assert.ok(run((p) => { p.legs[1].analysis.excursionMinutes = 0; }).includes("claimId_mismatch"));
  assert.ok(run((p) => { const { claimId, sig, signerPub, ...c } = p.legs[1]; p.legs[1] = signRecord(s.parties.b.kp, { ...c, analysis: { ...c.analysis, excursions: [], excursionMinutes: 0 } }); }).includes("leg_analysis_misstated"));
  assert.ok(run((p) => { const { claimId, sig, signerPub, ...c } = p.handoffs[2]; p.handoffs[2] = signRecord(s.parties.c.kp, { ...c, unitCount: 49 }); }).includes("units_changed_in_transit"));
  assert.ok(run((p) => { const { claimId, sig, signerPub, ...c } = p.release; p.release = signRecord(genKeypair(), c); }).includes("signer_not_pinned_custodian_key"));
  assert.ok(run((p) => { p.legs.pop(); }).includes("release_decision_inconsistent"));
});

test("pack-level proof: a real serial is in the shipment, a counterfeit is not", () => {
  const s = shipment();
  const h = s.package.handoffs[0];
  const real = s.units[7], fake = { ...real, serial: "S999" };
  assert.equal(unitInShipment(h.unitsRoot, h.unitCount, real, unitProof(s.committed, real)), true);
  assert.equal(unitProof(s.committed, fake), null);
  assert.equal(unitInShipment(h.unitsRoot, h.unitCount, fake, unitProof(s.committed, real)), false);
});

// --- salted pack commitments ---------------------------------------------------

import { commitUnits, unitKey, correction, estimate, leg } from "../src/records.mjs";
import { leafHash } from "../lib/merkle.mjs";
import { fingerprint } from "../src/logger.mjs";

test("a pack proof does not give away its neighbours, even with sequential serials", () => {
  const units = Array.from({ length: 50 }, (_, i) => ({ gtin: "00312345678906", serial: `S${i}`, lot: "L1", expiry: "2027-01-31" }));
  const c = commitUnits(units);
  const p = unitProof(c, units[7]);
  // The sibling at the bottom of the branch is another pack's leaf. Guessing every serial
  // without the salt finds nothing, which an unsalted leaf would have given up at once.
  const guesses = units.map((u) => leafHash(Buffer.from(unitKey(u), "utf8")));
  assert.equal(guesses.includes(p.branch[0]), false);
  assert.equal(unitInShipment(c.root, c.count, units[7], p), true);
  assert.equal(unitInShipment(c.root, c.count, units[7], { ...p, salt: undefined }), false);
  assert.equal(unitInShipment(c.root, c.count, units[7], { ...p, salt: "00".repeat(16) }), false);
  assert.equal(c.scheme, "salted-leaf/1");
});

test("pack commitments are reproducible when the shipper supplies the salts", () => {
  const units = [{ gtin: "1", serial: "a", lot: "x", expiry: "y" }, { gtin: "1", serial: "b", lot: "x", expiry: "y" }];
  const saltOf = (k) => Buffer.from(k).toString("hex").padEnd(32, "0").slice(0, 32);
  assert.equal(commitUnits(units, { saltOf }).root, commitUnits(units, { saltOf }).root);
  assert.throws(() => commitUnits(units, { saltOf: () => "short" }), /salt/);
});

// --- corrections, decision-time view, modelled estimates ---------------------------

// The carrier first files its leg against the wrong logger (L2, which sat in a hot dock),
// so the pharmacy quarantines. Hours after the decision the carrier corrects the leg.
function misfiled() {
  const [a, b, c] = ["maker", "carrier", "pharmacy"].map((custodian) => ({ custodian, kp: genKeypair() }));
  const ok = (t) => (t >= T0 + 90 * MIN && t < T0 + 100 * MIN ? 11 : 5);
  const logs = new Map([
    ["L1", series(T0, T0 + 4 * 60 * MIN, ok)],
    ["L2", series(T0, T0 + 4 * 60 * MIN, () => 14)],
  ]);
  const units = [{ gtin: "00312345678906", serial: "S1", lot: "L1", expiry: "2027-01-31" }];
  const built = buildShipment({
    shipmentId: "SHP-2", spec, units, logs, releaseAt: T0 + 300 * MIN,
    route: [{ ...a, at: T0 }, { ...b, at: T0 + 60 * MIN }, { ...c, at: T0 + 240 * MIN }],
    legs: [{ custodian: "maker", loggerId: "L1", from: T0, to: T0 + 60 * MIN }, { custodian: "carrier", loggerId: "L2", from: T0 + 60 * MIN, to: T0 + 240 * MIN }],
  });
  const pins = { maker: a.kp.pub, carrier: b.kp.pub, pharmacy: c.kp.pub };
  const fixLeg = (recordedAt) => {
    const win = windowOf(logs.get("L1"), T0 + 60 * MIN, T0 + 240 * MIN);
    return leg(b.kp, { shipmentId: "SHP-2", custodian: "carrier", loggerId: "L1", from: T0 + 60 * MIN, to: T0 + 240 * MIN, recordedAt, spec, fingerprint: fingerprint(win), analysis: analyse(win, { ...spec, from: T0 + 60 * MIN, to: T0 + 240 * MIN }) });
  };
  return { pkg: built.package, logs, pins, parties: { a, b, c }, fixLeg };
}

test("a correction after the decision is reported as later evidence, not held against the release", () => {
  const s = misfiled();
  assert.equal(s.pkg.release.decision, "quarantine");
  const replacement = s.fixLeg(T0 + 600 * MIN);
  const corr = correction(s.parties.b.kp, { shipmentId: "SHP-2", by: "carrier", corrects: s.pkg.legs[1].claimId, replacedBy: replacement.claimId, reason: "leg filed against the dock logger L2; the pallet carried L1", recordedAt: T0 + 600 * MIN });
  const pkg = { ...s.pkg, legs: [...s.pkg.legs, replacement], corrections: [corr] };
  const v = verifyShipment(pkg, { custodianPubs: s.pins, logs: s.logs });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.expected, "quarantine", "the release is judged on what was known when it was made");
  assert.equal(v.current.expected, "release");
  assert.deepEqual(v.findings, [{ type: "decision_changed_by_later_evidence", atDecision: "quarantine", now: "release" }]);
  assert.equal(v.history[0].leg, s.pkg.legs[1].claimId);
  assert.equal(v.history[0].knownAtDecision, false);
});

test("a correction is only valid from the leg's author, and the wrong leg cannot be dropped", () => {
  const s = misfiled();
  const replacement = s.fixLeg(T0 + 600 * MIN);
  const forged = correction(s.parties.a.kp, { shipmentId: "SHP-2", by: "maker", corrects: s.pkg.legs[1].claimId, replacedBy: replacement.claimId, reason: "x", recordedAt: T0 + 600 * MIN });
  const v1 = verifyShipment({ ...s.pkg, legs: [...s.pkg.legs, replacement], corrections: [forged] }, { custodianPubs: s.pins, logs: s.logs });
  assert.ok(v1.problems.some((p) => p.reason === "correction_not_by_author"));

  const corr = correction(s.parties.b.kp, { shipmentId: "SHP-2", by: "carrier", corrects: s.pkg.legs[1].claimId, replacedBy: replacement.claimId, reason: "x", recordedAt: T0 + 600 * MIN });
  const v2 = verifyShipment({ ...s.pkg, legs: [s.pkg.legs[0], replacement], corrections: [corr] }, { custodianPubs: s.pins, logs: s.logs });
  assert.ok(v2.problems.some((p) => p.reason === "correction_target_missing"));
});

test("a replacement leg without a correction is double counting", () => {
  const s = misfiled();
  const v = verifyShipment({ ...s.pkg, legs: [...s.pkg.legs, s.fixLeg(T0 + 240 * MIN)] }, { custodianPubs: s.pins, logs: s.logs });
  assert.ok(v.problems.some((p) => p.reason === "overlapping_legs"));
});

test("a record cannot be written before the event it describes", () => {
  const s = shipment();
  const { claimId, sig, signerPub, ...c } = s.package.legs[1];
  const early = signRecord(s.parties.b.kp, { ...c, recordedAt: c.to - 60 * MIN });
  const v = verifyShipment({ ...s.package, legs: [s.package.legs[0], early] }, { custodianPubs: s.pins, logs: s.logs });
  assert.ok(v.problems.some((p) => p.reason === "recorded_before_event"));
});

test("a modelled estimate fills a gap as a labelled model and never shrinks it", () => {
  const s = shipment({ gapAtDc: true });
  const before = verifyShipment(s.package, { custodianPubs: s.pins, logs: s.logs });
  const gap = before.attributed.find((x) => x.type === "logger_gap");
  const est = estimate(s.parties.b.kp, { shipmentId: "SHP-1", custodian: "carrier", from: gap.start, to: gap.end, minC: 4.6, maxC: 6.1, method: "thermal model from reefer setpoint and ambient", recordedAt: gap.end });
  const v = verifyShipment({ ...s.package, estimates: [est] }, { custodianPubs: s.pins, logs: s.logs });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.modelled.length, 1);
  assert.equal(v.gapMinutes, before.gapMinutes);
  assert.equal(v.decision, "quarantine", "a model does not turn unknown temperature into a release");

  const overObserved = estimate(s.parties.b.kp, { shipmentId: "SHP-1", custodian: "carrier", from: T0 + 60 * MIN, to: T0 + 90 * MIN, minC: 5, maxC: 5, method: "x", recordedAt: T0 + 240 * MIN });
  const v2 = verifyShipment({ ...s.package, estimates: [overObserved] }, { custodianPubs: s.pins, logs: s.logs });
  assert.ok(v2.problems.some((p) => p.reason === "estimate_overlaps_observed_data"));
});
