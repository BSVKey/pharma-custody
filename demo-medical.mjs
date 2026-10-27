#!/usr/bin/env node
// A vaccine supply run to a rural clinic with no network (2 to 8 C, 60-minute excursion
// budget): national vaccine store -> regional cold room -> district outreach team (cold box
// on a motorbike) -> rural clinic, with 500 serialised vials. The regional cold room's logger
// goes silent for 40 minutes in a power cut, and the outreach cold box freezes for 35
// minutes because its ice packs were packed straight from the freezer, a common cause of
// freeze damage in the field. The clinic signs its receipt and release decision offline;
// the whole custody package travels back as one file, carried hop by hop, and the national
// store verifies it from the raw logger exports when it arrives.
//
// Freeze-sensitive vaccines are judged by a shake test in practice; this demo uses the same
// time budget as demo.mjs so the two runs are directly comparable.
//   node demo-medical.mjs              (writes to a temp folder and removes it)
//   node demo-medical.mjs --out DIR    (keeps the logger CSVs and the custody bundle in DIR)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { genKeypair } from "./lib/keys.mjs";
import { signRecord } from "./lib/receipt.mjs";
import { parseLoggerCsv } from "./src/logger.mjs";
import { buildShipment } from "./src/shipment.mjs";
import { verifyShipment } from "./src/verify.mjs";
import { unitProof, unitInShipment } from "./src/records.mjs";

const T0 = Date.parse("2026-10-05T06:00:00Z"), MIN = 60000, H = 60 * MIN;
const spec = { minC: 2, maxC: 8, budgetMinutes: 60, intervalMs: 5 * MIN };
const when = (t) => new Date(t).toISOString().slice(5, 16).replace("T", " ");

function csv(from, to, tempAt, skip = () => false) {
  const rows = ["timestamp,temp_c"];
  for (let t = from; t <= to; t += spec.intervalMs) if (!skip(t)) rows.push(`${new Date(t).toISOString()},${tempAt(t).toFixed(2)}`);
  return rows.join("\n") + "\n";
}
const base = (t) => 5 + 0.8 * Math.sin(t / 3.7e6);
const outAt = process.argv.indexOf("--out");
const keep = outAt > 0;
const dir = keep ? resolve(process.argv[outAt + 1]) : mkdtempSync(join(tmpdir(), "medical-demo-"));
mkdirSync(dir, { recursive: true });

const freezeFrom = T0 + 30 * H + 10 * MIN, freezeTo = freezeFrom + 35 * MIN;
const powerCut = T0 + 18 * H;
const files = {
  "truck-logger-08": csv(T0, T0 + 6 * H, base),
  "coldroom-logger-02": csv(T0 + 6 * H, T0 + 30 * H, base, (t) => t > powerCut && t < powerCut + 40 * MIN),
  "coldbox-logger-11": csv(T0 + 30 * H, T0 + 36 * H, (t) => (t >= freezeFrom && t < freezeTo ? -0.8 : base(t))),
};
for (const [id, text] of Object.entries(files)) writeFileSync(join(dir, `${id}.csv`), text);
const load = () => new Map(Object.keys(files).map((id) => [id, parseLoggerCsv(readFileSync(join(dir, `${id}.csv`), "utf8")).samples]));

try {
  const party = (custodian) => ({ custodian, kp: genKeypair() });
  const [nat, reg, dist, clinic] = ["national-store", "regional-coldroom", "district-outreach", "rural-clinic"].map(party);
  const vials = Array.from({ length: 500 }, (_, i) => ({ gtin: "00312345000012", serial: `VX${String(200000 + i)}`, lot: "MV2610", expiry: "2027-06-30" }));
  const route = [{ ...nat, at: T0 }, { ...reg, at: T0 + 6 * H, receivedTempC: 5.2 }, { ...dist, at: T0 + 30 * H, receivedTempC: 4.9 }, { ...clinic, at: T0 + 36 * H, receivedTempC: 3.1 }];
  const legs = [
    { custodian: "national-store", loggerId: "truck-logger-08", from: T0, to: T0 + 6 * H },
    { custodian: "regional-coldroom", loggerId: "coldroom-logger-02", from: T0 + 6 * H, to: T0 + 30 * H },
    { custodian: "district-outreach", loggerId: "coldbox-logger-11", from: T0 + 30 * H, to: T0 + 36 * H },
  ];
  const { package: pkg, units: committed } = buildShipment({ shipmentId: "VAX-2026-10-0117", spec, units: vials, route, legs, logs: load() });
  const pins = Object.fromEntries([nat, reg, dist, clinic].map((p) => [p.custodian, p.kp.pub]));

  console.log(`Vaccine run ${pkg.shipmentId}: ${committed.count} vials, ${spec.minC} to ${spec.maxC} C, excursion budget ${spec.budgetMinutes} min`);
  console.log(`Route: ${route.map((r) => r.custodian).join(" -> ")}`);
  console.log(`Clinic signed its receipt and decision offline at ${when(pkg.release.at)} UTC: "${pkg.release.decision}"\n`);

  // The package travels as one file, the way a DTN bundle would: written at the clinic,
  // carried by the outreach team, uplinked from the district office, read at the national store.
  const bundle = JSON.stringify(pkg);
  const hops = ["rural-clinic (written, no network)", "outreach motorbike (carried)", "district office (uplinked)", "national-store (received)"];
  writeFileSync(join(dir, "custody-bundle.json"), bundle);
  const arrived = JSON.parse(readFileSync(join(dir, "custody-bundle.json"), "utf8"));
  console.log(`Custody bundle: ${bundle.length.toLocaleString()} bytes, ${hops.length} hops`);
  for (const h of hops) console.log(`  ${h}`);

  const v = verifyShipment(arrived, { custodianPubs: pins, logs: load() });
  console.log(`\nVerified at the national store from the raw logger CSVs: ${v.ok ? "PASS" : "FAIL " + JSON.stringify(v.problems)}`);
  console.log(`Excursions ${v.excursionMinutes} min + logger gaps ${v.gapMinutes} min (unknown temperature, counted) = ${v.chargedMinutes} of ${v.budgetMinutes} min allowed: decision "${v.decision}" (evidence says "${v.expected}")`);
  for (const a of v.attributed) console.log(`  ${a.type.padEnd(12)} ${a.custodian.padEnd(18)} ${when(a.start)} to ${when(a.end)} UTC, ${a.minutes} min${a.peakC !== undefined ? `, ${a.direction === "low" ? "low" : "peak"} ${a.peakC} C` : ""}`);

  const vial = vials[123], fake = { ...vials[123], serial: "VX999999" };
  console.log(`\nVial ${vial.serial} came in this run: ${unitInShipment(pkg.handoffs[0].unitsRoot, pkg.handoffs[0].unitCount, vial, unitProof(committed, vial))}`);
  console.log(`Counterfeit vial ${fake.serial}: ${unitInShipment(pkg.handoffs[0].unitsRoot, pkg.handoffs[0].unitCount, fake, unitProof(committed, vial))}`);

  console.log("\nTampering:");
  const attempt = (label, mutate) => {
    const p = structuredClone(arrived), logs = load();
    mutate(p, logs);
    const r = verifyShipment(p, { custodianPubs: pins, logs });
    console.log(`  ${label.padEnd(64)} ${r.ok ? "NOT CAUGHT" : "caught: " + r.problems.map((x) => x.reason).join(", ")}`);
  };
  attempt("outreach team deletes its freezing rows from the logger export", (p, logs) => logs.set("coldbox-logger-11", logs.get("coldbox-logger-11").filter(([, c]) => c >= 2)));
  attempt("someone edits the cold box leg to hide the freezing", (p) => { p.legs[2].analysis.excursions = []; });
  attempt("outreach team re-signs a clean leg for itself", (p) => {
    const { claimId, sig, signerPub, ...c } = p.legs[2];
    p.legs[2] = signRecord(dist.kp, { ...c, analysis: { ...c.analysis, excursions: [], excursionMinutes: 0 } });
  });
  attempt("clinic's decision flipped to release by another party", (p) => { const { claimId, sig, signerPub, ...c } = p.release; p.release = signRecord(genKeypair(), { ...c, decision: "release" }); });
  attempt("vials swapped on the road (different set at the clinic)", (p) => { const h = p.handoffs[3]; const { claimId, sig, signerPub, ...c } = h; p.handoffs[3] = signRecord(clinic.kp, { ...c, unitsRoot: "00".repeat(32) }); });
  attempt("cold room's leg left out of the bundle", (p) => { p.legs.splice(1, 1); });

  if (keep) console.log(`\nEvidence kept in ${dir}: ${Object.keys(files).map((f) => f + ".csv").join(", ")}, custody-bundle.json`);
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true });
}
