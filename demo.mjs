#!/usr/bin/env node
// A refrigerated vaccine shipment (2 to 8 C, 45-minute excursion budget) moving
// manufacturer -> air carrier -> distributor warehouse -> pharmacy, with 1,200 serialised
// packs. The carrier's leg has a 20-minute warm excursion on the tarmac; the warehouse's
// logger goes silent for 50 minutes, and unknown temperature counts against the budget. The demo writes the loggers' CSV exports, builds
// every custodian's signed records, verifies the whole package from the raw CSVs, then
// shows each kind of tampering being caught.
//   node demo.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genKeypair } from "./lib/keys.mjs";
import { signRecord } from "./lib/receipt.mjs";
import { parseLoggerCsv } from "./src/logger.mjs";
import { buildShipment } from "./src/shipment.mjs";
import { verifyShipment } from "./src/verify.mjs";
import { unitProof, unitInShipment } from "./src/records.mjs";

const T0 = Date.parse("2026-10-05T06:00:00Z"), MIN = 60000, H = 60 * MIN;
const spec = { minC: 2, maxC: 8, budgetMinutes: 45, intervalMs: 5 * MIN };
const iso = (t) => new Date(t).toISOString().slice(11, 16);

// Logger CSVs: one logger travels with the shipper's pallet; the warehouse has its own.
function csv(from, to, tempAt, skip = () => false) {
  const rows = ["timestamp,temp_c"];
  for (let t = from; t <= to; t += spec.intervalMs) if (!skip(t)) rows.push(`${new Date(t).toISOString()},${tempAt(t).toFixed(2)}`);
  return rows.join("\n") + "\n";
}
const base = (t) => 5 + Math.sin(t / 3.7e6);
const dir = mkdtempSync(join(tmpdir(), "pharma-demo-"));
const files = {
  "pallet-logger-17": csv(T0, T0 + 10 * H, (t) => (t >= T0 + 3 * H + 10 * MIN && t < T0 + 3 * H + 30 * MIN ? 9.6 + (t - T0) / 3.6e9 : base(t))),
  "warehouse-logger-03": csv(T0 + 10 * H, T0 + 30 * H, base, (t) => t > T0 + 14 * H && t < T0 + 14 * H + 50 * MIN),
};
for (const [id, text] of Object.entries(files)) writeFileSync(join(dir, `${id}.csv`), text);
const load = () => new Map(Object.keys(files).map((id) => [id, parseLoggerCsv(readFileSync(join(dir, `${id}.csv`), "utf8")).samples]));

try {
  const party = (custodian) => ({ custodian, kp: genKeypair() });
  const [mfr, air, dc, rx] = ["manufacturer", "air-carrier", "distributor-dc", "pharmacy"].map(party);
  const units = Array.from({ length: 1200 }, (_, i) => ({ gtin: "00312345678906", serial: `SN${String(100000 + i)}`, lot: "L2609A", expiry: "2027-09-30" }));
  const route = [{ ...mfr, at: T0 }, { ...air, at: T0 + 2 * H, receivedTempC: 5.1 }, { ...dc, at: T0 + 10 * H, receivedTempC: 5.4 }, { ...rx, at: T0 + 30 * H, receivedTempC: 4.8 }];
  const legs = [
    { custodian: "manufacturer", loggerId: "pallet-logger-17", from: T0, to: T0 + 2 * H },
    { custodian: "air-carrier", loggerId: "pallet-logger-17", from: T0 + 2 * H, to: T0 + 10 * H },
    { custodian: "distributor-dc", loggerId: "warehouse-logger-03", from: T0 + 10 * H, to: T0 + 30 * H },
  ];
  const { package: pkg, units: committed } = buildShipment({ shipmentId: "SHP-2026-10-0042", spec, units, route, legs, logs: load() });
  const pins = Object.fromEntries([mfr, air, dc, rx].map((p) => [p.custodian, p.kp.pub]));

  console.log(`Shipment ${pkg.shipmentId}: ${committed.count} packs, ${spec.minC} to ${spec.maxC} C, excursion budget ${spec.budgetMinutes} min`);
  console.log(`Route: ${route.map((r) => r.custodian).join(" -> ")}\n`);
  const v = verifyShipment(pkg, { custodianPubs: pins, logs: load() });
  console.log(`Verified from the raw logger CSVs: ${v.ok ? "PASS" : "FAIL " + JSON.stringify(v.problems)}`);
  console.log(`Excursions ${v.excursionMinutes} min + logger gaps ${v.gapMinutes} min (unknown temperature, counted) = ${v.chargedMinutes} of ${v.budgetMinutes} min allowed: decision "${v.decision}" (expected "${v.expected}")`);
  for (const a of v.attributed) console.log(`  ${a.type.padEnd(19)} ${a.custodian.padEnd(15)} ${iso(a.start)} to ${iso(a.end)} UTC, ${a.minutes} min${a.peakC !== undefined ? `, peak ${a.peakC} C` : ""}`);

  const pack = units[417], fake = { ...units[417], serial: "SN999999" };
  console.log(`\nPack ${pack.serial} in this shipment: ${unitInShipment(pkg.handoffs[0].unitsRoot, pkg.handoffs[0].unitCount, pack, unitProof(committed, pack))}`);
  console.log(`Counterfeit serial ${fake.serial}: ${unitInShipment(pkg.handoffs[0].unitsRoot, pkg.handoffs[0].unitCount, fake, unitProof(committed, pack))}`);

  console.log("\nTampering:");
  const attempt = (label, mutate) => {
    const p = structuredClone(pkg), logs = load();
    mutate(p, logs);
    const r = verifyShipment(p, { custodianPubs: pins, logs });
    console.log(`  ${label.padEnd(58)} ${r.ok ? "NOT CAUGHT" : "caught: " + r.problems.map((x) => x.reason).join(", ")}`);
  };
  attempt("carrier deletes its excursion rows from the logger export", (p, logs) => logs.set("pallet-logger-17", logs.get("pallet-logger-17").filter(([t, c]) => c <= 8)));
  attempt("someone edits the leg to hide the excursion", (p) => { p.legs[1].analysis.excursions = []; });
  attempt("carrier re-signs a clean leg for itself", (p, logs) => {
    const l = p.legs[1]; const { claimId, sig, signerPub, ...c } = l;
    p.legs[1] = signRecord(air.kp, { ...c, analysis: { ...c.analysis, excursions: [], excursionMinutes: 0 } });
  });
  attempt("pharmacy's release is forged by another party", (p) => { const { claimId, sig, signerPub, ...c } = p.release; p.release = signRecord(genKeypair(), c); });
  attempt("packs swapped mid-route (different unit set at the DC)", (p) => { const h = p.handoffs[2]; const { claimId, sig, signerPub, ...c } = h; p.handoffs[2] = signRecord(dc.kp, { ...c, unitsRoot: "00".repeat(32) }); });
  attempt("warehouse leg withheld", (p) => { p.legs.splice(2, 1); });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
