import { bytesToHex, hexToBytes, type Hex } from "viem";

/** A 0x hex string (address or 32-byte hash) to lowercase `bytea` bytes. */
export function hexBytes(hex: string): Uint8Array {
  return hexToBytes(hex.toLowerCase() as Hex);
}

/** `bytea` bytes back to a lowercase 0x hex string. */
export function bytesHex(value: Uint8Array): Hex {
  return bytesToHex(value).toLowerCase() as Hex;
}

/** `numeric(78,0)`-style columns come back as strings; parse to bigint. */
export function asBigInt(value: unknown): bigint {
  return BigInt(String(value));
}

export function asNumber(value: unknown): number {
  return Number(value);
}

export function asString(value: unknown): string {
  return String(value);
}
