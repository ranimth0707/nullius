import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeStringReturn } from "../src/chain.js";

/**
 * A wrong answer here is worse than no answer: a misdecoded name would let the
 * identity check either clear a contract it never read, or accuse a correct one.
 */
describe("decodeStringReturn", () => {
  const dynamic = (s) => {
    const hex = Buffer.from(s, "utf8").toString("hex");
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    return "0x" + (32).toString(16).padStart(64, "0")
      + (s.length).toString(16).padStart(64, "0") + padded;
  };

  test("decodes a dynamic string", () => {
    assert.equal(decodeStringReturn(dynamic("Venus BNB")), "Venus BNB");
  });

  test("decodes a string that exactly fills one word", () => {
    assert.equal(decodeStringReturn(dynamic("0123456789abcdef0123456789abcdef")),
      "0123456789abcdef0123456789abcdef");
  });

  test("decodes a legacy bytes32 name", () => {
    const hex = Buffer.from("vBNB", "utf8").toString("hex").padEnd(64, "0");
    assert.equal(decodeStringReturn("0x" + hex), "vBNB");
  });

  test("returns null for an empty return", () => {
    assert.equal(decodeStringReturn("0x"), null);
    assert.equal(decodeStringReturn(""), null);
    assert.equal(decodeStringReturn(null), null);
  });

  test("returns null when the payload is all zeroes", () => {
    assert.equal(decodeStringReturn("0x" + "0".repeat(64)), null);
  });

  test("does not throw on a truncated payload", () => {
    assert.doesNotThrow(() => decodeStringReturn("0x" + "0".repeat(20)));
  });

  test("strips trailing NUL padding rather than keeping it", () => {
    const hex = Buffer.from("Fluid", "utf8").toString("hex").padEnd(64, "0");
    assert.equal(decodeStringReturn("0x" + hex), "Fluid");
  });
});
