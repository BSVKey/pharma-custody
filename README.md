# Pharma Custody

Verifiable chain of custody for temperature-sensitive pharmaceutical shipments.

Every company that holds a shipment signs what it received, when, and in what condition,
and signs a fingerprint of its own temperature-logger data for the time it held the goods.
Anyone with the logger exports can later check the whole chain without trusting any
single party: who held the shipment, whether it stayed in range, where the excursions
and logger gaps happened, and whether the release decision follows from the evidence.

```
npm test          # offline, zero dependencies
node demo.mjs     # a vaccine shipment: manufacturer -> air carrier -> distributor -> pharmacy
```

## What the demo shows

A 1,200-pack vaccine shipment kept at 2 to 8 C with a 45-minute excursion budget:

```
Verified from the raw logger CSVs: PASS
Excursions 20 min + logger gaps 50 min (unknown temperature, counted) = 70 of 45 min allowed: decision "quarantine"
  excursion           air-carrier     09:10 to 09:30 UTC, 20 min, peak 9.6 C
  logger_gap          distributor-dc  20:00 to 20:50 UTC, 50 min

Pack SN100417 in this shipment: true
Counterfeit serial SN999999: false

Tampering:
  carrier deletes its excursion rows from the logger export  caught
  someone edits the leg to hide the excursion                caught
  carrier re-signs a clean leg for itself                    caught
  pharmacy's release is forged by another party              caught
  packs swapped mid-route (different unit set at the DC)     caught
  warehouse leg withheld                                     caught

Correction filed 22 h after the release: PASS
  decision at the time "quarantine" stands; with the correction it would be "release" (20 of 45 min)
```

The carrier's excursion alone was within budget; the warehouse's logger gap is what
pushed the shipment into quarantine, and the record says so.

## Medical demo: vaccines to a clinic with no network

```
node demo-medical.mjs              # temp folder, removed afterwards
node demo-medical.mjs --out DIR    # keeps the logger CSVs and the custody bundle
```

500 vaccine vials go national store -> regional cold room -> district outreach team (cold
box on a motorbike) -> rural clinic. The cold room's logger is silent for 40 minutes in a
power cut, and the cold box freezes for 35 minutes because its ice packs went in straight
from the freezer. The clinic signs its receipt and quarantine decision offline. The custody
package travels back as one file, hop by hop, and the national store verifies it from the
raw logger exports:

```
Verified at the national store from the raw logger CSVs: PASS
Excursions 35 min + logger gaps 40 min (unknown temperature, counted) = 75 of 60 min allowed: decision "quarantine" (evidence says "quarantine")
  logger_gap   regional-coldroom  10-06 00:00 to 10-06 00:40 UTC, 40 min
  excursion    district-outreach  10-06 12:10 to 10-06 12:45 UTC, 35 min, low -0.8 C
```

Each vial can be checked against the run, and the same six kinds of tampering are caught.
No patient data is involved: the records cover vials, custodians, times and temperatures.

## Organ and specimen demo

```
node demo-organ.mjs              # temp folder, removed afterwards
node demo-organ.mjs --out DIR    # keeps the logger CSVs and both custody bundles
```

A donor kidney flies as commercial air cargo: organ procurement organization -> courier ->
airline -> courier -> transplant center. It misses its connection and the airline holds it
5 hours longer than planned. The temperature stays within budget, but the signed handoffs
show the time out of body ran over the limit the accepting surgeon set, and which custodian
the lost hours belong to:

```
Time out of body, recovery to arrival: 14 h 30 min (planned 9 h 30 min), limit 12 h 00 min: OVER, surgeon review before use
Delay by custodian (held vs planned):
  airline      held 9 h 00 min   +5 h 00 min late
```

Each handoff is signed by the party that received the organ, so nobody can move the time
they handed it over. Backdating a pickup, re-signing someone else's handoff, editing the
arrival time, deleting logger rows and substituting a different organ are all caught.

A second run sends a pathology tissue block to an outside reference lab. The lab proves the
block it received is the one the hospital sent, and a block from another case fails the
check. Identifiers are fictional and no patient data is in any record.

## Records

| Record | Signed by | Says |
|---|---|---|
| `pharma.handoff/1` | the receiving custodian | received this shipment from that custodian at this time, these units (a Merkle root over the packs' product identifiers), in this condition; names the previous handoff |
| `pharma.leg/1` | the custodian holding the shipment | which logger, which time window, a fingerprint of exactly the samples in that window, and what they show: range, excursions, gaps |
| `pharma.release/1` | the final receiver's quality function | total excursion and gap time against the stability budget, the legs it relied on, and the decision |
| `pharma.correction/1` | the author of an earlier leg | that leg was wrong, why, and which leg replaces it; the wrong leg is kept, not edited or deleted |
| `pharma.estimate/1` | a custodian | a modelled temperature range for a stretch with no logger data, labelled as modelled |

Every record carries the time of the event and the time it was recorded (`recordedAt`).

Packs are identified by their product identifier: GTIN, serial number, lot and expiry,
the data elements carried in the 2D barcode under the US Drug Supply Chain Security Act.
Any single pack can be proven part of a shipment with a short inclusion proof, without
revealing the other packs. Each pack's leaf is salted (`salted-leaf/1`): serial numbers
are often sequential, and without a salt the sibling hashes in one pack's proof could be
matched against guessed serials to reveal its neighbours. The salt for a pack goes only to
whoever holds that pack.

All records use canonical JSON, a SHA-256 content id and an Ed25519 signature, the same
primitives as BSVKey's other custody records.

## Rules the verifier applies

- Every record verifies and is signed by the pinned key of the custodian it names. Keys
  come from the verifier, never from the records.
- Handoffs chain from origin to final receiver, in time order, with one unit set
  throughout. A changed unit set is flagged.
- Each custodian's leg lies inside its custody window and matches the raw logger export
  exactly: same fingerprint, same excursions, same gaps.
- Custody time not covered by any leg is reported and forces quarantine.
- Logger gaps are unknown temperature and count against the excursion budget by default
  (`spec.gapsCount: false` to report them without counting).
- The release decision must follow from the recomputed totals, and must list exactly
  the legs it relied on, so a withheld leg is caught.
- A leg can only be corrected by its author. The corrected leg stays in the package and
  is reported in `history`; deleting it instead is flagged. A replacement leg with no
  correction is double counting and is flagged.
- The release is judged on what had been recorded by its decision time. A correction
  that arrives later is reported as `decision_changed_by_later_evidence`, with both the
  decision-time and current outcomes, instead of silently rewriting the record. The idea
  follows the GS1 EPCIS 2.0 ErrorDeclaration: correcting a record is not a new event.
- A record cannot be recorded before the event it describes.
- Modelled estimates are listed under `modelled`, only inside stretches with no logger
  data, and never reduce gap time or change the decision.

## Scope

This is a verification layer, not a validated system. It does not replace a
manufacturer's stability data, a quality system, or DSCSA-compliant transaction data
exchange; it gives every party in the chain the same verifiable evidence of custody and
condition. Validation for regulated use is the adopting organization's responsibility.

## License

Apache License 2.0. Copyright 2026 Embryo Space Inc. (DBA BSVKey).
