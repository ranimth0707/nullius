import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stage, peek, commit } from "../src/execute.js";

/**
 * These guard the one path in the program that can spend money. The point of the
 * nonce is that a deposit cannot be reached by anything that merely says it wants
 * one, including the model, which never sees a nonce and cannot mint one.
 */
const intent = (over = {}) => ({
  investmentId: "abc123", tokenAddress: "0xEee", amount: 0.005,
  label: "Venus BNB @ 0.13%", ownerId: 889619621, ...over,
});

describe("staging", () => {
  test("a nonce unlocks exactly what was staged", () => {
    const n = stage(intent());
    const i = peek(n);
    assert.equal(i.investmentId, "abc123");
    assert.equal(i.amount, 0.005);
  });

  test("nonces are unguessable and distinct", () => {
    const seen = new Set(Array.from({ length: 200 }, () => stage(intent())));
    assert.equal(seen.size, 200);
    assert.ok([...seen][0].length >= 12);
  });

  test("an unknown nonce unlocks nothing", () => {
    assert.equal(peek("not-a-real-nonce"), null);
    assert.equal(peek(""), null);
    assert.equal(peek(undefined), null);
  });
});

describe("commit", () => {
  test("refuses a nonce that was never staged", async () => {
    const r = await commit("made-up", 889619621);
    assert.equal(r.ok, false);
    assert.equal(r.error.name, "EXPIRED");
  });

  test("refuses a real nonce presented by someone else", async () => {
    // A nonce pasted into a group chat must be useless to everyone but its owner.
    const n = stage(intent());
    const r = await commit(n, 12345);
    assert.equal(r.ok, false);
    assert.equal(r.error.name, "NOT_YOURS");
  });

  test("a rejected attempt does not burn the intent", async () => {
    const n = stage(intent());
    await commit(n, 12345);
    assert.ok(peek(n), "the owner must still be able to confirm afterwards");
  });

  test("the same nonce cannot deposit twice", async () => {
    // commit() burns the intent before the call goes out, so a double tap on the
    // confirm button cannot send two transactions.
    const n = stage(intent());
    await commit(n, 889619621).catch(() => {});
    assert.equal(peek(n), null);
    const again = await commit(n, 889619621);
    assert.equal(again.ok, false);
    assert.equal(again.error.name, "EXPIRED");
  });
});
