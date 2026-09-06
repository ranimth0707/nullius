import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliseSymbol } from "../src/llama.js";

/**
 * These cases are here because the tool once got them wrong.
 *
 * Binance writes BSC_ETH where DefiLlama writes ETH, and BNB where DefiLlama
 * writes WBNB. Left unnormalised, five products reported as having no independent
 * record at all — a far more alarming claim than the truth, which was a spelling
 * difference. The published verification rate was wrong by six points until this
 * was fixed.
 */
describe("normaliseSymbol", () => {
  test("strips the chain prefix Binance puts on bridged assets", () => {
    assert.equal(normaliseSymbol("BSC_ETH"), "ETH");
  });

  test("maps native coin names onto their wrapped counterparts", () => {
    assert.equal(normaliseSymbol("BNB"), "WBNB");
    assert.equal(normaliseSymbol("BTC"), "BTCB");
  });

  test("leaves an already-wrapped symbol alone", () => {
    assert.equal(normaliseSymbol("WBNB"), "WBNB");
  });

  test("is case-insensitive", () => {
    assert.equal(normaliseSymbol("bsc_eth"), "ETH");
    assert.equal(normaliseSymbol("bnb"), "WBNB");
  });

  test("passes ordinary symbols through untouched", () => {
    assert.equal(normaliseSymbol("USDT"), "USDT");
    assert.equal(normaliseSymbol("FDUSD"), "FDUSD");
  });

  test("handles absent input without throwing", () => {
    assert.equal(normaliseSymbol(null), "");
    assert.equal(normaliseSymbol(undefined), "");
    assert.equal(normaliseSymbol(""), "");
  });
});
