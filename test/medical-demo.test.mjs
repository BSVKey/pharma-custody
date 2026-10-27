import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../demo-medical.mjs", import.meta.url));

test("medical demo: bundle verifies after the offline trip, quarantine follows, every tampering is caught", () => {
  const out = execFileSync(process.execPath, [demo], { encoding: "utf8" });
  assert.match(out, /Verified at the national store from the raw logger CSVs: PASS/);
  assert.match(out, /= 75 of 60 min allowed: decision "quarantine" \(evidence says "quarantine"\)/);
  assert.match(out, /Vial VX200123 came in this run: true/);
  assert.match(out, /Counterfeit vial VX999999: false/);
  assert.equal((out.match(/caught: /g) || []).length, 6);
  assert.doesNotMatch(out, /NOT CAUGHT/);
});
