// Temperature-logger data: parse an export, cut it to one custodian's window, find
// excursions (time outside the product's allowed range) and gaps (the logger was silent),
// and fingerprint exactly the samples that were analysed.
import { canonicalize, sha256hex } from "../lib/canonical.mjs";

// Parse a CSV export. Columns are found by name (case-insensitive): a time column
// ("timestamp", "time", "datetime") holding ISO 8601 or epoch milliseconds, and a
// temperature column ("temp_c", "temperature", "temp", "celsius") in degrees Celsius.
// Unparseable rows are counted, not silently dropped.
export function parseLoggerCsv(text, { timeCol, tempCol } = {}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("logger csv: no data rows");
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const ti = timeCol !== undefined ? head.indexOf(timeCol.toLowerCase()) : head.findIndex((h) => ["timestamp", "time", "datetime", "date_time"].includes(h));
  const ci = tempCol !== undefined ? head.indexOf(tempCol.toLowerCase()) : head.findIndex((h) => ["temp_c", "temperature", "temp", "celsius", "temperature_c"].includes(h));
  if (ti < 0 || ci < 0) throw new Error("logger csv: time or temperature column not found");
  const samples = [];
  let rejected = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const raw = cells[ti]?.trim();
    const t = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    const c = Number(cells[ci]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) { rejected++; continue; }
    samples.push([t, Math.round(c * 100) / 100]);
  }
  samples.sort((a, b) => a[0] - b[0]);
  return { samples, rejected };
}

export const windowOf = (samples, from, to) => samples.filter(([t]) => t >= from && t <= to);

// Fingerprint of the exact samples analysed: SHA-256 of canonical JSON [[t, c], ...].
export const fingerprint = (samples) => "0x" + sha256hex(canonicalize(samples));

// Excursions: runs of samples outside [minC, maxC]. A run lasts from its first sample
// out of range to the next sample back in range (or the window end). Gaps: the logger
// was silent for longer than gapFactor x the sampling interval, including at the start
// or end of the window. Minutes are rounded to one decimal.
export function analyse(samples, { minC, maxC, intervalMs, gapFactor = 2, from, to }) {
  const mins = (ms) => Math.round((ms / 60000) * 10) / 10;
  const excursions = [];
  let run = null;
  for (let i = 0; i < samples.length; i++) {
    const [t, c] = samples[i];
    const out = c < minC || c > maxC;
    if (out && !run) run = { start: t, peakC: c, direction: c > maxC ? "high" : "low" };
    if (out && run) run.peakC = run.direction === "high" ? Math.max(run.peakC, c) : Math.min(run.peakC, c);
    if (!out && run) { excursions.push({ ...run, end: t, minutes: mins(t - run.start) }); run = null; }
  }
  if (run) excursions.push({ ...run, end: to, minutes: mins(to - run.start) });
  const gaps = [];
  const limit = gapFactor * intervalMs;
  const points = [from, ...samples.map(([t]) => t), to];
  for (let i = 1; i < points.length; i++) if (points[i] - points[i - 1] > limit) gaps.push({ start: points[i - 1], end: points[i], minutes: mins(points[i] - points[i - 1]) });
  const temps = samples.map(([, c]) => c);
  return {
    samples: samples.length,
    minC: temps.length ? Math.min(...temps) : null,
    maxC: temps.length ? Math.max(...temps) : null,
    excursions,
    excursionMinutes: Math.round(excursions.reduce((a, e) => a + e.minutes, 0) * 10) / 10,
    gaps,
    gapMinutes: Math.round(gaps.reduce((a, g) => a + g.minutes, 0) * 10) / 10,
  };
}
