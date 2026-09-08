// Every envelope below was copied from a real `baw` response during a survey of
// all 144 Earn and LiquidityPool products on BSC. They are pinned here because
// the distinction they encode — a refusal about the wallet versus a refusal
// about the product — is the whole reason the classifier exists, and a
// regression would quietly turn a screen back into something that distrusts
// everything it cannot afford.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classify, FINDING, CONDITION, CALLER, TRANSPORT } from "../src/refusal.js";

describe("classify", () => {
  test("not holding the asset is a fact about the wallet, not the product", () => {
    // 101 of 144 previews came back like this.
    const c = classify({ code: 20002002, name: "INSUFFICIENT_BALANCE",
      message: "Insufficient balance. Your available USDT balance is 9.99." });
    assert.equal(c.kind, CONDITION);
    assert.match(c.title, /USDT/);
    assert.equal(c.retryable, false);
  });

  test("a minimum deposit is reported with its number", () => {
    // Lista USDT. The listing never mentions a minimum; the preview does.
    const c = classify({ name: "SERVICE_ERROR", message: "amount 0.5 is less than minimum 1" });
    assert.equal(c.kind, CONDITION);
    assert.equal(c.minimum, 1);
  });

  test("a missing tick range is this program's fault and says so", () => {
    // 43 of 144. Blaming the product for it would be a lie about what happened.
    const c = classify({ name: "SERVICE_ERROR",
      message: "A tick range is required for a new LP position: provide one of nftId (to append " +
               "to an existing position), priceRange, or tickLower+tickUpper" });
    assert.equal(c.kind, CALLER);
  });

  test("having no position is why an exit could not be simulated", () => {
    const c = classify({ code: 60003001, name: "INVESTMENT_NO_POSITION",
      message: "You don't have any position in this investment product." });
    assert.equal(c.kind, CONDITION);
  });

  test("a request that never completed claims nothing either way", () => {
    const c = classify({ name: "CLI_FAILURE", message: "spawn baw ETIMEDOUT" });
    assert.equal(c.kind, TRANSPORT);
    assert.equal(c.retryable, true);
  });

  test("a rate limit is transport, not a verdict on the product", () => {
    const c = classify({ name: "SERVICE_ERROR",
      message: "Request rate limit exceeded. Please reduce request frequency" });
    assert.equal(c.kind, TRANSPORT);
    assert.equal(c.retryable, true);
  });

  test("anything genuinely rejecting the deposit stays a finding", () => {
    const c = classify({ name: "TRANSACTION_REVERTED",
      message: "execution reverted: supply cap exceeded" });
    assert.equal(c.kind, FINDING);
  });

  test("an unrecognised failure is treated as a finding, not waved through", () => {
    // Fail closed: an unknown refusal must never become permission.
    const c = classify({ name: "SOMETHING_NEW", message: "" });
    assert.equal(c.kind, FINDING);
  });
});
