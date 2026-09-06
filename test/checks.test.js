import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkValue, checkCapacity, checkIdentity, PASS, WARN, BLOCK, UNTESTED }
  from "../src/checks.js";

describe("checkValue", () => {
  const preview = (outUsd, inUsd) => ({
    balanceChange: [
      { amount: "-1", valueUsd: String(outUsd) },
      { amount: "1", valueUsd: String(inUsd) },
    ],
  });

  test("passes when value is conserved", () => {
    assert.equal(checkValue(preview(100, 100)).level, PASS);
  });

  test("passes when the position is worth marginally more", () => {
    assert.equal(checkValue(preview(100, 100.4)).level, PASS);
  });

  test("blocks when more than one percent goes missing", () => {
    const r = checkValue(preview(100, 98));
    assert.equal(r.level, BLOCK);
    assert.match(r.detail, /2\.00% lost/);
  });

  test("does not block on a loss inside tolerance", () => {
    assert.equal(checkValue(preview(100, 99.5)).level, PASS);
  });

  test("warns rather than passing when only one side is reported", () => {
    assert.equal(checkValue({ balanceChange: [{ amount: "-1", valueUsd: "10" }] }).level, WARN);
  });

  test("warns on a malformed preview instead of throwing", () => {
    assert.equal(checkValue({}).level, WARN);
    assert.equal(checkValue(null).level, WARN);
  });
});

describe("checkCapacity", () => {
  test("passes when the deposit is a small share of the pool", () => {
    assert.equal(checkCapacity(10, 1_000_000).level, PASS);
  });

  test("blocks once the deposit exceeds five percent of the pool", () => {
    const r = checkCapacity(10_000, 100_000);
    assert.equal(r.level, BLOCK);
    assert.match(r.detail, /10\.00%/);
  });

  test("blocks a deposit larger than the pool itself", () => {
    assert.equal(checkCapacity(10_000, 2_727).level, BLOCK);
  });

  test("sits just under the threshold at five percent", () => {
    assert.equal(checkCapacity(5_000, 100_000).level, PASS);
  });

  test("warns, rather than passing, when pool size is unknown", () => {
    assert.equal(checkCapacity(10, 0).level, WARN);
    assert.equal(checkCapacity(10, null).level, WARN);
  });
});

describe("verdict levels", () => {
  test("silence and failure are separate levels", () => {
    // The whole reason UNTESTED exists: a contract that never answered has not
    // been shown to be wrong, and recording it as a failure would misstate what
    // was observed. Collapsing these two would defeat the design.
    assert.notEqual(UNTESTED, BLOCK);
    assert.equal(new Set([PASS, WARN, BLOCK, UNTESTED]).size, 4);
  });
});
