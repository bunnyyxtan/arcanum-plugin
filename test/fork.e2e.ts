// End-to-end check against an anvil fork of Base mainnet. Run `pnpm e2e:fork` with anvil listening on FORK_RPC.
// It impersonates the PayBox wallet, deploys any missing ARCANUM module through the same CREATE2 calls
// arcanum_deploy proposes, then drives a guarded wallet through allow, deny, escalate, block and freeze.
import assert from "node:assert/strict";
import {
  createTestClient, createWalletClient, encodeAbiParameters, http, keccak256, parseEventLogs,
  type Address, type BaseError, type Hex,
} from "viem";

import { DEPLOYMENTS, calls, client, decodeRevert, eventsAbi, preflight, readWallet } from "../src/arcanum.ts";
import { BASE_DEPLOY_STEPS } from "../src/deploy-base.ts";

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8546";
DEPLOYMENTS.base.rpcs = [RPC];
const d = DEPLOYMENTS.base;
const pub = client(d);
const anvil = createTestClient({ mode: "anvil", transport: http(RPC) });
const owner: Address = "0xf14521e8eFF08b5A2ee324e515EBc42e336DAe06"; // protocol admin and PayBox wallet
const VENDOR: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x2222222222222222222222222222222222222222";

await anvil.impersonateAccount({ address: owner });
await anvil.setBalance({ address: owner, value: 10n ** 18n });
const wallet = createWalletClient({
  account: owner, transport: http(RPC),
  chain: { id: 8453, name: "base-fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
});

async function send(to: Address, data: Hex) {
  const hash = await wallet.sendTransaction({ to, data, gas: 4_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

async function simulate(to: Address, data: Hex) {
  try {
    await pub.call({ account: owner, to, data });
    return "ok";
  } catch (e) {
    const found = (e as BaseError).walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
    return decodeRevert(found?.data) ?? (e as Error).message.split("\n")[0];
  }
}

for (const step of BASE_DEPLOY_STEPS) {
  const code = await pub.getCode({ address: step.address as Address });
  if (code && code !== "0x") continue;
  await send(step.to as Address, step.data as Hex);
  console.log("deployed", step.name);
}

// 10 USDC for the owner (FiatToken balances live in mapping slot 9).
const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 9n]));
await anvil.setStorageAt({ address: d.usdc, index: slot, value: `0x${(10_000_000n).toString(16).padStart(64, "0")}` });

const created = await send(d.walletFactory, calls.createWallet(owner, `fork-${Date.now()}`, {
  perTxCap: 5_000_000n, daily24hCap: 20_000_000n, monthlyCap: 0n, allowedCategories: 31n,
  escalationThreshold: 3_000_000n, requireAllowlist: true, freezeOnBlockedVendor: true,
}, [owner], [owner], 1, 86_400n));
const guarded = parseEventLogs({ abi: eventsAbi, logs: created.logs, eventName: "WalletCreated" })[0]!.args.wallet;

await send(d.usdc, calls.fund(guarded, 6_000_000n));
await send(guarded, calls.addVendor(VENDOR, 0, 0n));
let state = await readWallet(pub, guarded);
assert.equal(state.balance, 6_000_000n);

assert.equal((await preflight(pub, state, owner, VENDOR, 1_000_000n)).verdict, "ALLOW");
await send(guarded, calls.pay(VENDOR, 1_000_000n, "invoice 42"));
state = await readWallet(pub, guarded);
assert.equal(state.dailySpent, 1_000_000n);

assert.equal((await preflight(pub, state, owner, STRANGER, 2_000_000n)).verdict, "DENY");
assert.match(await simulate(guarded, calls.pay(STRANGER, 2_000_000n, "forced")), /TransferDenied: recipient is not on this wallet's vendor allowlist/);
assert.equal((await preflight(pub, state, owner, VENDOR, 4_000_000n)).verdict, "ESCALATE");
assert.equal((await preflight(pub, state, owner, VENDOR, 6_000_000n)).verdict, "BLOCKED");

await send(guarded, calls.freeze("fork test"));
state = await readWallet(pub, guarded);
assert.equal((await preflight(pub, state, owner, VENDOR, 1_000_000n)).verdict, "BLOCKED");
assert.equal(await simulate(guarded, calls.pay(VENDOR, 1_000_000n, "x")), "FrozenWallet");
await send(guarded, calls.unfreeze());
assert.equal((await readWallet(pub, guarded)).frozen, false);

console.log("fork e2e passed for", guarded);
