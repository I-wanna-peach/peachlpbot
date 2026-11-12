import { getAddress, isAddress, type Address } from "viem";

export const NICKNAME_MAX_LENGTH = 32;

/**
 * Accepts a full 0x-prefixed address or a bare 40-hex address (a common
 * copy-paste shape). Anything else — including a transaction hash — is rejected.
 */
export function parseCandidateAddress(input: string): Address | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^[0-9a-fA-F]{40}$/.test(trimmed) ? `0x${trimmed}` : trimmed;
  return isAddress(candidate) ? getAddress(candidate) : null;
}

/** Collapses whitespace and enforces 1..32 visible characters. */
export function normalizeNickname(input: string): string | null {
  const value = input.replace(/\s+/g, " ").trim();
  if (value.length < 1 || value.length > NICKNAME_MAX_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}
