import { describe, expect, it } from "vitest";
import { guessDomains, payeeKey } from "./payee-icons";

/**
 * Pure-function tests for payee-icon domain guessing and key derivation. The
 * network fetch (`fetchPayeeIcon`/`refreshPayeeIcons`) is deliberately not
 * exercised here — see lib/prices.test.ts for that split.
 */
describe("guessDomains", () => {
  it("yields <name>.ch before <name>.com (Swiss-first)", () => {
    expect(guessDomains("Migros")).toEqual(["migros.ch", "migros.com"]);
  });

  it("lowercases and strips spaces and punctuation", () => {
    expect(guessDomains("Coop City")).toEqual(["coopcity.ch", "coopcity.com"]);
    expect(guessDomains("H&M")).toEqual(["hm.ch", "hm.com"]);
    expect(guessDomains("SBB CFF FFS")).toEqual(["sbbcffffs.ch", "sbbcffffs.com"]);
  });

  it("transliterates umlauts and accents", () => {
    expect(guessDomains("Müller")).toEqual(["mueller.ch", "mueller.com"]);
    expect(guessDomains("Bäckerei")).toEqual(["baeckerei.ch", "baeckerei.com"]);
    expect(guessDomains("Café Ölberg")).toEqual(["cafeoelberg.ch", "cafeoelberg.com"]);
  });

  it("skips phone-number-like payees", () => {
    expect(guessDomains("+41796831614")).toEqual([]);
    expect(guessDomains("+41 79 683 16 14")).toEqual([]);
    expect(guessDomains("079 683 16 14")).toEqual([]);
  });

  it("skips payees that normalize to empty or all-digits", () => {
    expect(guessDomains("")).toEqual([]);
    expect(guessDomains("   ")).toEqual([]);
    expect(guessDomains("!!!")).toEqual([]);
    expect(guessDomains("12345")).toEqual([]);
  });

  it("keeps alphanumeric names that merely contain digits", () => {
    expect(guessDomains("7-Eleven")).toEqual(["7eleven.ch", "7eleven.com"]);
  });
});

describe("payeeKey", () => {
  it("is a stable 16-char lowercase hex string", () => {
    const key = payeeKey("Migros");
    expect(key).toMatch(/^[a-f0-9]{16}$/);
    expect(payeeKey("Migros")).toBe(key);
  });

  it("differs between distinct payees", () => {
    expect(payeeKey("Migros")).not.toBe(payeeKey("Coop"));
  });
});
