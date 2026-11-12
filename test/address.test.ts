import { describe, expect, test } from "bun:test";
import { normalizeNickname, parseCandidateAddress } from "../src/bot/address.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("parseCandidateAddress", () => {
  test("accepts a 0x-prefixed address", () => {
    expect(parseCandidateAddress(ADDRESS)).toBe(ADDRESS);
    expect(parseCandidateAddress(`  ${ADDRESS}  `)).toBe(ADDRESS);
  });
  test("accepts a bare 40-hex address", () => {
    expect(parseCandidateAddress(ADDRESS.slice(2))).toBe(ADDRESS);
  });
  test("rejects hashes and malformed input", () => {
    expect(parseCandidateAddress(`0x${"ab".repeat(32)}`)).toBeNull();
    expect(parseCandidateAddress("0x1234")).toBeNull();
    expect(parseCandidateAddress("")).toBeNull();
  });
});

describe("normalizeNickname", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeNickname("  Main   Wallet ")).toBe("Main Wallet");
  });
  test("rejects empty, too long, or control characters", () => {
    expect(normalizeNickname("   ")).toBeNull();
    expect(normalizeNickname("x".repeat(33))).toBeNull();
    expect(normalizeNickname("bad\u0007name")).toBeNull();
  });
  test("accepts up to 32 characters", () => {
    expect(normalizeNickname("x".repeat(32))).toBe("x".repeat(32));
  });
});
