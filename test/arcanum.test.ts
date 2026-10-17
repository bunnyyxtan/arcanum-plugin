import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, toHex, type Address } from "viem";

import {
  calls, deployment, erc20Abi, factoryAbi, formatUsdc, parseAddress, parseUsdc, reasonText,
  rolledSpend, validatePolicy, walletAbi, type Policy,
} from "../src/arcanum.ts";

const A: Address = "0x1111111111111111111111111111111111111111";
const policy = (over: Partial<Policy> = {}): Policy => ({
  perTxCap: 5_000_000n, daily24hCap: 20_000_000n, monthlyCap: 0n, allowedCategories: 31n,
  escalationThreshold: 3_000_000n, requireAllowlist: true, freezeOnBlockedVendor: true, ...over,
});

test("USDC amounts parse to 6-decimal integers and reject bad input", () => {
  assert.equal(parseUsdc("2.5", "x"), 2_500_000n);
  assert.equal(parseUsdc("0.000001", "x"), 1n);
  for (const bad of ["0", "-1", "1.0000001", "1e3", "", "abc", "01"]) assert.throws(() => parseUsdc(bad, "x"), undefined, bad);
  assert.equal(formatUsdc(2_500_000n), "2.50");
  assert.equal(formatUsdc(1n), "0.000001");
});

test("addresses are checksummed and validated", () => {
  assert.equal(parseAddress("0xa6207ed5c1ee62ec2ac18486a0c0bc3040c42485", "w"), "0xA6207eD5c1Ee62eC2AC18486A0C0bC3040C42485");
  assert.throws(() => parseAddress("0x123", "w"), /0x address/);
});

test("spend windows roll the way GuardedWallet does", () => {
  // day 100 sits in 30-day window 3
  const raw = { dailySpent: 7n, monthlySpent: 9n, spendDay: 100n, spendMonth: 3n };
  assert.deepEqual(rolledSpend(raw, 100n * 86_400n + 5n), { dailySpent: 7n, monthlySpent: 9n });
  assert.deepEqual(rolledSpend(raw, 101n * 86_400n), { dailySpent: 0n, monthlySpent: 9n });
  assert.deepEqual(rolledSpend(raw, 120n * 86_400n), { dailySpent: 0n, monthlySpent: 0n });
});

test("policy validation mirrors the contract", () => {
  validatePolicy(policy());
  assert.throws(() => validatePolicy(policy({ perTxCap: 0n })), /above zero/);
  assert.throws(() => validatePolicy(policy({ perTxCap: 30_000_000n })), /cannot exceed the daily/);
  assert.throws(() => validatePolicy(policy({ monthlyCap: 1n })), /monthly cap/);
  assert.throws(() => validatePolicy(policy({ escalationThreshold: 6_000_000n })), /escalate_above/);
});

test("calldata decodes back to the intended call", () => {
  const pay = decodeFunctionData({ abi: walletAbi, data: calls.pay(A, 1_000_000n, "invoice 42") });
  assert.equal(pay.functionName, "executeUSDC");
  assert.deepEqual(pay.args, [A, 1_000_000n, toHex("invoice 42")]);
  assert.equal(decodeFunctionData({ abi: walletAbi, data: calls.freeze("x") }).functionName, "freeze");
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: calls.fund(A, 3n) }).args, [A, 3n]);
  const create = decodeFunctionData({ abi: factoryAbi, data: calls.createWallet(A, "agent", policy(), [A], [A], 1, 86_400n) });
  assert.equal(create.functionName, "createWallet");
  assert.equal((create.args[2] as Policy).perTxCap, 5_000_000n);
});

test("deployments are known for Base and Arc, and reasons read in plain words", () => {
  assert.equal(deployment("base").chainId, 8453);
  assert.equal(deployment("arc").chainId, 5042);
  assert.match(reasonText(1), /allowlist/);
  assert.match(reasonText(99), /unknown/);
});
