// Build a shipment's custody package the way it happens in practice: each custodian signs
// its own records with its own key as the shipment moves. Here one function plays all the
// parties so the whole flow can be run and tested in one place.
//
// route: [{ custodian, kp, at, receivedTempC? }]  the receiving custodians in order; the
//        first entry is the origin taking custody at packing/dispatch
// legs:  [{ custodian, loggerId, from, to }]      logger windows each custodian attests to
// logs:  Map loggerId -> samples
import { handoff, leg, release, commitUnits } from "./records.mjs";
import { windowOf, fingerprint, analyse } from "./logger.mjs";

export function buildShipment({ shipmentId, spec, units, route, legs, logs, releaseAt }) {
  const units_ = commitUnits(units);
  const keyOf = new Map(route.map((r) => [r.custodian, r.kp]));
  const handoffs = [];
  route.forEach((r, i) => {
    handoffs.push(handoff(r.kp, {
      shipmentId, from: i === 0 ? "origin" : route[i - 1].custodian, to: r.custodian, at: r.at,
      unitsRoot: units_.root, unitCount: units_.count, prev: i === 0 ? null : handoffs[i - 1].claimId, receivedTempC: r.receivedTempC ?? null,
    }));
  });
  const legRecords = legs.map((l) => {
    const win = windowOf(logs.get(l.loggerId), l.from, l.to);
    return leg(keyOf.get(l.custodian), { shipmentId, custodian: l.custodian, loggerId: l.loggerId, from: l.from, to: l.to, spec, fingerprint: fingerprint(win), analysis: analyse(win, { ...spec, from: l.from, to: l.to }) });
  });
  const excursionMinutes = Math.round(legRecords.reduce((a, l) => a + l.analysis.excursionMinutes, 0) * 10) / 10;
  const gapMinutes = Math.round(legRecords.reduce((a, l) => a + l.analysis.gapMinutes, 0) * 10) / 10;
  const final = route.at(-1);
  const rel = release(final.kp, {
    shipmentId, by: final.custodian, at: releaseAt ?? final.at, budgetMinutes: spec.budgetMinutes, excursionMinutes, gapMinutes,
    decision: excursionMinutes + (spec.gapsCount === false ? 0 : gapMinutes) <= spec.budgetMinutes ? "release" : "quarantine", legs: legRecords.map((l) => l.claimId),
  });
  return { package: { shipmentId, spec, handoffs, legs: legRecords, release: rel }, units: units_ };
}
