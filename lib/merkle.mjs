// Binary Merkle tree over payload chunks, with domain separation (leaf byte 0x00,
// internal byte 0x01) so a leaf can never be reinterpreted as an internal node.
// Odd layers duplicate the last node (Bitcoin-style). Hashes are lowercase hex.
import { createHash } from "node:crypto";

const sha = (buf) => createHash("sha256").update(buf).digest();
const hx = (buf) => buf.toString("hex");
const un = (hex) => Buffer.from(hex, "hex");

export function leafHash(bytes) {
  return hx(sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(bytes)])));
}
function nodeHash(leftHex, rightHex) {
  return hx(sha(Buffer.concat([Buffer.from([0x01]), un(leftHex), un(rightHex)])));
}

// Build a tree from leaf hashes (hex). Returns { root, layers } where layers[0] are
// the leaves and layers[last] is [root].
export function buildTree(leafHexes) {
  if (!Array.isArray(leafHexes) || leafHexes.length === 0) {
    throw new Error("buildTree: need at least one leaf");
  }
  const layers = [leafHexes.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i]; // duplicate last if odd
      next.push(nodeHash(left, right));
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

// Merkle branch (proof) for a leaf index: just the sibling hash at each level. The
// fold direction is NOT carried in the branch; it is derived from the claimed index
// at verify time, so a leaf is bound to its position (a chunk cannot be replayed at a
// different reassembly slot with the same proof).
export function proof(tree, index) {
  const branch = [];
  let idx = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    branch.push(siblingIdx < layer.length ? layer[siblingIdx] : layer[idx]); // duplicated last
    idx = Math.floor(idx / 2);
  }
  return branch;
}

// Verify a leaf hash against a root using its branch and its CLAIMED index. The index
// bits decide left/right at each level, so a valid leaf presented at the wrong index
// fails.
export function verifyProof(leafHex, branch, index, root) {
  let acc = leafHex;
  let idx = index;
  for (const sibling of branch) {
    acc = idx % 2 === 1 ? nodeHash(sibling, acc) : nodeHash(acc, sibling);
    idx = Math.floor(idx / 2);
  }
  return acc === root;
}
