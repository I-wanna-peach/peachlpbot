/**
 * Cost-bounded bootstrap window.
 *
 * An explicit `startBlock` wins. Otherwise the first run starts at
 * `head - lookbackBlocks`: positions older than the window are deliberately not
 * backfilled. This is the single place the policy lives, shared by the global
 * indexer and the per-address subscription scan.
 */
export function bootstrapStartBlock(input: {
  head: bigint;
  startBlock: bigint | null;
  lookbackBlocks: bigint;
}): bigint {
  if (input.startBlock !== null) return input.startBlock;
  if (input.lookbackBlocks < 0n) throw new Error("lookbackBlocks must be non-negative.");
  return input.head > input.lookbackBlocks ? input.head - input.lookbackBlocks : 0n;
}
