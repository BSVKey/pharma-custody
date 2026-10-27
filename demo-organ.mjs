#!/usr/bin/env node
// Two medical custody runs on the same records as demo.mjs.
//
// 1. A donor kidney flown as commercial air cargo: organ procurement organization -> ground
//    courier -> airline -> ground courier -> transplant center. The organ misses its
//    connection at the hub and the airline holds it 5 hours longer than planned. One
//    temperature logger rides in the organ box the whole way. Besides the temperature
//    check, the signed handoffs give a time-out-of-body clock (from recovery to arrival)
//    and a per-custodian delay against the planned schedule, so the lost hours have a name.
//
// 2. A pathology tissue block sent to an outside reference lab. The lab proves the block it
//    received is the one the hospital sent; a block with another accession number is not.
//
// Identifiers are fictional, and no patient data is in any record: an organ is identified by
// organ type, donor ID, match run and use-by time; a specimen by accession and block. The
// time limit is a parameter the accepting surgeon would set, not a clinical rule.
//   node demo-organ.mjs              (writes to a temp folder and removes it)
//   node demo-organ.mjs --out DIR    (keeps the logger CSVs and both custody bundles in DIR)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { genKeypair } from "./lib/keys.mjs";
import { signRecord } from "./lib/receipt.mjs";
import { parseLoggerCsv } from "./src/logger.mjs";
import { buildShipment } from "./src/shipment.mjs";
import { verifyShipment } from "./src/verify.mjs";
import { unitProof, unitInShipment } from "./src/records.mjs";

const MIN = 60000, H = 60 * MIN;
const when = (t) => new Date(t).toISOString().slice(5, 16).replace("T", " ");
const hm = (ms) => `${Math.floor(ms / H)} h ${String(Math.round((ms % H) / MIN)).padStart(2, "0")} min`;
const csv = (from, to, intervalMs, tempAt) => {
  const rows = ["timestamp,temp_c"];
  for (let t = from; t <= to; t += intervalMs) rows.push(`${new Date(t).toISOString()},${tempAt(t).toFixed(2)}`);
  return rows.join("\n") + "\n";
};
const outAt = process.argv.indexOf("--out");
const keep = outAt > 0;
const dir = keep ? resolve(process.argv[outAt + 1]) : mkdtempSync(join(tmpdir(), "organ-demo-"));
mkdirSync(dir, { recursive: true });
const party = (custodian) => ({ custodian, kp: genKeypair() });
const strip = ({ claimId, sig, signerPub, ...c }) => c;
const attempt = (pkg, pins, logs, label, mutate) => {
  const p = structuredClone(pkg), l = new Map(logs);
  mutate(p, l);
  const r = verifyShipment(p, { custodianPubs: pins, logs: l });
  console.log(`  ${label.padEnd(62)} ${r.ok ? "NOT CAUGHT" : "caught: " + r.problems.map((x) => x.reason).join(", ")}`);
};

try {
  // ---- 1. Donor kidney by air ------------------------------------------------------------
  const T0 = Date.parse("2026-10-05T22:00:00Z"); // organ recovered
  const spec = { minC: 0, maxC: 8, budgetMinutes: 30, intervalMs: 5 * MIN };
  const limitMs = 12 * H; // set by the accepting surgeon for this organ
  const warmFrom = T0 + 9 * H, warmTo = warmFrom + 15 * MIN; // box left on the tarmac at the hub
  const box = csv(T0, T0 + 14.5 * H, spec.intervalMs, (t) => (t >= warmFrom && t < warmTo ? 9.2 : 4 + 0.5 * Math.sin(t / 3.7e6)));
  writeFileSync(join(dir, "organ-box-logger-5.csv"), box);
  const logs = new Map([["organ-box-logger-5", parseLoggerCsv(box).samples]]);

  const [opo, courierA, airline, courierB, center] = ["opo", "courier-a", "airline", "courier-b", "transplant-center"].map(party);
  const kidney = { gtin: "organ:kidney-left", serial: "donor:DN-26-4471", lot: "match:MR-0193", expiry: new Date(T0 + 36 * H).toISOString() };
  const planned = [T0, T0 + 3 * H, T0 + 4 * H, T0 + 8 * H, T0 + 9.5 * H];
  const actual = [T0, T0 + 3 * H, T0 + 4 * H, T0 + 13 * H, T0 + 14.5 * H];
  const holders = [opo, courierA, airline, courierB, center];
  const route = holders.map((p, i) => ({ ...p, at: actual[i], ...(i ? { receivedTempC: 4.1 } : {}) }));
  const legs = holders.slice(0, -1).map((p, i) => ({ custodian: p.custodian, loggerId: "organ-box-logger-5", from: actual[i], to: actual[i + 1] }));
  const { package: pkg, units } = buildShipment({ shipmentId: "ORGAN-2026-10-0031", spec, units: [kidney], route, legs, logs });
  const pins = Object.fromEntries(holders.map((p) => [p.custodian, p.kp.pub]));
  writeFileSync(join(dir, "organ-custody-bundle.json"), JSON.stringify(pkg));

  console.log(`Donor kidney ${pkg.shipmentId}, recovered ${when(T0)} UTC`);
  console.log(`Route: ${holders.map((p) => p.custodian).join(" -> ")}`);
  const v = verifyShipment(pkg, { custodianPubs: pins, logs });
  console.log(`\nVerified from the box logger: ${v.ok ? "PASS" : "FAIL " + JSON.stringify(v.problems)}`);
  console.log(`Temperature: ${v.excursionMinutes} min out of ${spec.minC} to ${spec.maxC} C + ${v.gapMinutes} min gaps = ${v.chargedMinutes} of ${spec.budgetMinutes} min allowed: temperature decision "${v.decision}"`);
  for (const a of v.attributed) console.log(`  ${a.type.padEnd(10)} ${a.custodian.padEnd(12)} ${when(a.start)} to ${when(a.end)} UTC, ${a.minutes} min${a.peakC !== undefined ? `, peak ${a.peakC} C` : ""}`);

  // Times come only from verified, signed handoffs: each one is signed by the party that
  // received the organ, so the party that held it cannot move its own hand-over time.
  if (v.ok) {
    const hs = pkg.handoffs, out = hs.at(-1).at - hs[0].at;
    console.log(`\nTime out of body, recovery to arrival: ${hm(out)} (planned ${hm(planned.at(-1) - planned[0])}), limit ${hm(limitMs)}: ${out > limitMs ? "OVER, surgeon review before use" : "within limit"}`);
    console.log("Delay by custodian (held vs planned):");
    for (let i = 0; i < hs.length - 1; i++) {
      const late = (hs[i + 1].at - hs[i].at) - (planned[i + 1] - planned[i]);
      console.log(`  ${hs[i].to.padEnd(12)} held ${hm(hs[i + 1].at - hs[i].at).padEnd(12)} ${late > 0 ? `+${hm(late)} late` : "on plan"}`);
    }
    console.log(`Kidney is the one matched (${kidney.lot.slice(6)}): ${unitInShipment(hs[0].unitsRoot, hs[0].unitCount, kidney, unitProof(units, kidney))}`);
  }

  console.log("\nTampering:");
  attempt(pkg, pins, logs, "courier-b backdates its pickup to hide the airline's delay", (p) => {
    p.handoffs[3] = signRecord(courierB.kp, { ...strip(p.handoffs[3]), at: T0 + 8 * H, recordedAt: T0 + 8 * H });
  });
  attempt(pkg, pins, logs, "airline signs courier-b's pickup itself with an earlier time", (p) => {
    p.handoffs[3] = signRecord(airline.kp, { ...strip(p.handoffs[3]), at: T0 + 8 * H, recordedAt: T0 + 8 * H });
  });
  attempt(pkg, pins, logs, "someone edits the arrival time at the transplant center", (p) => { p.handoffs[4].at = T0 + 9.5 * H; });
  attempt(pkg, pins, logs, "airline deletes the tarmac readings from the logger export", (p, l) => l.set("organ-box-logger-5", l.get("organ-box-logger-5").filter(([, c]) => c <= 8)));
  attempt(pkg, pins, logs, "a different kidney is substituted at the transplant center", (p) => {
    p.handoffs[4] = signRecord(center.kp, { ...strip(p.handoffs[4]), unitsRoot: "00".repeat(32) });
  });

  // ---- 2. Tissue block to an outside lab -------------------------------------------------
  const S0 = Date.parse("2026-10-06T14:00:00Z");
  const sspec = { minC: 15, maxC: 25, budgetMinutes: 60, intervalMs: 10 * MIN };
  const bag = csv(S0, S0 + 20 * H, sspec.intervalMs, (t) => 21 + Math.sin(t / 5e6));
  writeFileSync(join(dir, "specimen-bag-logger-9.csv"), bag);
  const slogs = new Map([["specimen-bag-logger-9", parseLoggerCsv(bag).samples]]);
  const [path, courier, lab] = ["hospital-pathology", "courier", "reference-lab"].map(party);
  const block = { gtin: "specimen:FFPE-block", serial: "accession:S26-118804", lot: "block:A3", expiry: "none" };
  const other = { ...block, serial: "accession:S26-118811" };
  const s = buildShipment({
    shipmentId: "SPEC-2026-10-0412", spec: sspec, units: [block],
    route: [{ ...path, at: S0 }, { ...courier, at: S0 + 2 * H, receivedTempC: 21.0 }, { ...lab, at: S0 + 20 * H, receivedTempC: 20.6 }],
    legs: [{ custodian: "hospital-pathology", loggerId: "specimen-bag-logger-9", from: S0, to: S0 + 2 * H }, { custodian: "courier", loggerId: "specimen-bag-logger-9", from: S0 + 2 * H, to: S0 + 20 * H }],
    logs: slogs,
  });
  const spins = Object.fromEntries([path, courier, lab].map((p) => [p.custodian, p.kp.pub]));
  writeFileSync(join(dir, "specimen-custody-bundle.json"), JSON.stringify(s.package));
  const sv = verifyShipment(s.package, { custodianPubs: spins, logs: slogs });
  const h0 = s.package.handoffs[0];
  console.log(`\nTissue block ${s.package.shipmentId}: hospital-pathology -> courier -> reference-lab`);
  console.log(`Verified: ${sv.ok ? "PASS" : "FAIL " + JSON.stringify(sv.problems)}, ${sv.chargedMinutes} of ${sspec.budgetMinutes} min out of ${sspec.minC} to ${sspec.maxC} C: "${sv.decision}"`);
  console.log(`Block received is ${block.serial.slice(10)} ${block.lot.slice(6)}: ${unitInShipment(h0.unitsRoot, h0.unitCount, block, unitProof(s.units, block))}`);
  console.log(`Block from another case (${other.serial.slice(10)}): ${unitInShipment(h0.unitsRoot, h0.unitCount, other, unitProof(s.units, block))}`);
  console.log("Tampering:");
  attempt(s.package, spins, slogs, "block swapped by the courier", (p) => {
    p.handoffs[2] = signRecord(lab.kp, { ...strip(p.handoffs[2]), unitsRoot: "11".repeat(32) });
  });

  if (keep) console.log(`\nEvidence kept in ${dir}: organ-box-logger-5.csv, specimen-bag-logger-9.csv, organ-custody-bundle.json, specimen-custody-bundle.json`);
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
