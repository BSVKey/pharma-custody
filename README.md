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
```

The carrier's excursion alone was within budget; the warehouse's logger gap is what
pushed the shipment into quarantine, and the record says so.

## Records

| Record | Signed by | Says |
|---|---|---|
| `pharma.handoff/1` | the receiving custodian | received this shipment from that custodian at this time, these units (a Merkle root over the packs' product identifiers), in this condition; names the previous handoff |
| `pharma.leg/1` | the custodian holding the shipment | which logger, which time window, a fingerprint of exactly the samples in that window, and what they show: range, excursions, gaps |
| `pharma.release/1` | the final receiver's quality function | total excursion and gap time against the stability budget, and the decision |

Packs are identified by their product identifier: GTIN, serial number, lot and expiry,
the data elements carried in the 2D barcode under the US Drug Supply Chain Security Act.
Any single pack can be proven part of a shipment with a short inclusion proof, without
revealing the other packs.

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
- The release decision must follow from the recomputed totals.

## Scope

This is a verification layer, not a validated system. It does not replace a
manufacturer's stability data, a quality system, or DSCSA-compliant transaction data
exchange; it gives every party in the chain the same verifiable evidence of custody and
condition. Validation for regulated use is the adopting organization's responsibility.

## License

Apache License 2.0. Copyright 2026 Embryo Space Inc. (DBA BSVKey).
