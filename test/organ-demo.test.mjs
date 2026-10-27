import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const demo = fileURLToPath(new URL("../demo-organ.mjs", import.meta.url));

test("organ demo: delay pinned on the airline, time limit flagged, specimen identity proven, every tampering caught", () => {
  const out = execFileSync(process.execPath, [demo], { encoding: "utf8" });
  assert.match(out, /Verified from the box logger: PASS/);
  assert.match(out, /14 h 30 min \(planned 9 h 30 min\), limit 12 h 00 min: OVER/);
  assert.match(out, /airline +held 9 h 00 min +\+5 h 00 min late/);
  assert.match(out, /Kidney is the one matched \(MR-0193\): true/);
  assert.match(out, /Verified: PASS, 0 of 60 min/);
  assert.match(out, /Block received is S26-118804 A3: true/);
  assert.match(out, /Block from another case \(S26-118811\): false/);
  assert.equal((out.match(/caught: /g) || []).length, 6);
  assert.doesNotMatch(out, /NOT CAUGHT/);
});
