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
