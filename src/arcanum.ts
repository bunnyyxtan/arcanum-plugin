import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  fallback,
  getAddress,
  http,
  isAddress,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

// Contract-enforced policy wallets (ARCANUM) driven from PayBox. Each write is one EVM call.

export type ChainKey = "base" | "arc";
export type Deployment = {
  name: string;
  chainId: number;
  rpcs: string[];
  explorer: string;
  usdc: Address;
  walletFactory: Address;
  policyEngine: Address;
  vendorRegistry: Address;
};

// Base addresses are the CREATE2 results of script/DeployBaseMainnet.s.sol (same bytecode as Arc v2).
export const DEPLOYMENTS: Record<ChainKey, Deployment> = {
  base: {
    name: "Base",
    chainId: 8453,
    // Each host must also be allowed in the PayBox portal; later ones are fallbacks.
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    walletFactory: "0x3649bDD7A6095601b5D66bCe9FF7115e0Ffe5002",
    policyEngine: "0x437C281670111378F2da34246Fc587D5866ebc63",
    vendorRegistry: "0x0ea9f1B6cD5c5D8437cC96569730FB70d38F2fD6",
  },
  arc: {
    name: "Arc",
    chainId: 5042,
    rpcs: ["https://rpc.mainnet.arc.io"],
    explorer: "https://explorer.arc.io",
    usdc: "0x3600000000000000000000000000000000000000",
    walletFactory: "0x7077A28C003D9274d45263b04Ac9cB9a58Ab5342",
    policyEngine: "0xb74De5aD09a75dea03f5ddD77A25e1Ca11724483",
    vendorRegistry: "0x722C2f83ca55503Cf3104bABeb3EaA9d676B1469",
  },
};

export const CATEGORIES = ["API", "COMPUTE", "DATA", "SUBCONTRACTING", "OTHER"] as const;
export const VERDICTS = ["ALLOW", "ESCALATE", "DENY", "FREEZE"] as const;
export const REASONS = [
  "NONE", "ALLOWLIST_REQUIRED", "PER_TX_CAP", "DAILY_CAP", "ESCALATION_THRESHOLD",
  "BLOCKED_VENDOR", "CATEGORY_DISABLED", "MONTHLY_CAP", "PER_VENDOR_CAP",
] as const;
const REASON_TEXT: Record<(typeof REASONS)[number], string> = {
  NONE: "within policy",
  ALLOWLIST_REQUIRED: "recipient is not on this wallet's vendor allowlist",
  PER_TX_CAP: "amount is above the per-payment cap",
  DAILY_CAP: "payment would exceed today's spend cap",
  ESCALATION_THRESHOLD: "amount is above the escalation threshold, so the human council must approve",
  BLOCKED_VENDOR: "recipient is a blocked vendor",
  CATEGORY_DISABLED: "recipient's vendor category is disabled by policy",
  MONTHLY_CAP: "payment would exceed the 30-day spend cap",
  PER_VENDOR_CAP: "amount is above this vendor's cap",
};

const POLICY = "(uint256 perTxCap,uint256 daily24hCap,uint256 monthlyCap,uint256 allowedCategories,uint256 escalationThreshold,bool requireAllowlist,bool freezeOnBlockedVendor)";
export const walletAbi = parseAbi([
  "function owner() view returns (address)",
  "function usdc() view returns (address)",
  "function frozen() view returns (bool)",
  "function policyEngine() view returns (address)",
  "function vendorRegistry() view returns (address)",
  `function policy() view returns ${POLICY}`,
  "function policyVersion() view returns (uint256)",
  "function agentSigners(address) view returns (bool)",
  "function dailySpent() view returns (uint256)",
  "function monthlySpent() view returns (uint256)",
  "function spendDay() view returns (uint256)",
  "function spendMonth() view returns (uint256)",
  "function executeUSDC(address to, uint256 amount, bytes reason)",
  "function freeze(bytes reason)",
  "function unfreeze()",
  "function addVendor(address vendor, uint8 category, uint256 perVendorCap, bytes32 metadataHash)",
  "error NotSigner()",
  "error NotOwner()",
  "error FrozenWallet()",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error TransferDenied(uint8 reason)",
  "error InvalidPolicy()",
  "error InvalidThreshold()",
  "error InvalidExpiry()",
  "error InvalidCouncil()",
  "error InvalidCategory()",
]);
export const engineAbi = parseAbi([
  `function evaluate(${POLICY} policy, address to, uint256 amount, uint256 dailySpent, uint256 monthlySpent, address vendorRegistry) view returns (uint8 verdict, uint8 reason)`,
]);
export const registryAbi = parseAbi([
  "function getVendorFor(address wallet, address vendor) view returns ((bool allowed, bool blocked, uint8 category, uint256 perVendorCap, bytes32 metadataHash))",
]);
export const factoryAbi = parseAbi([
  `function createWallet(address owner, string label, ${POLICY} initialPolicy, address[] initialSigners, address[] escalationCouncil, uint8 escalationThreshold, uint64 escalationExpirySeconds) returns (address)`,
]);
export const eventsAbi = parseAbi([
  "event WalletCreated(address indexed wallet, address indexed owner, string label, uint256 defaultsVersion, uint256 timestamp)",
]);
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export type Policy = {
  perTxCap: bigint; daily24hCap: bigint; monthlyCap: bigint; allowedCategories: bigint;
  escalationThreshold: bigint; requireAllowlist: boolean; freezeOnBlockedVendor: boolean;
};

export function deployment(chain: ChainKey): Deployment {
  const d = DEPLOYMENTS[chain];
  if (/^0x0{40}$/.test(d.walletFactory)) throw new Error(`ARCANUM is not deployed on ${d.name} yet.`);
  return d;
}

export function client(d: Deployment): PublicClient {
  // One batched HTTP request per tick; on a refused or failed host, the next one answers.
  const transports = d.rpcs.map((url) => http(url, { timeout: 3000, retryCount: 0, batch: true }));
  return createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports) }) as PublicClient;
}

export function parseAddress(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`${field} must be a 0x address (got "${value}").`);
  return getAddress(value);
}

// "2.5" -> 2_500_000n. USDC has 6 decimals on Base and Arc's ERC-20 interface.
export function parseUsdc(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(value)) {
    throw new Error(`${field} must be a USDC amount with at most 6 decimals, e.g. "2.50" (got "${value}").`);
  }
  const [whole, fraction = ""] = value.split(".");
  const atomic = BigInt(whole + fraction.padEnd(6, "0"));
  if (atomic <= 0n) throw new Error(`${field} must be greater than zero.`);
  return atomic;
}

export function formatUsdc(atomic: bigint): string {
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${atomic / 1_000_000n}.${fraction.padEnd(2, "0")}`;
}

export function reasonText(reason: number): string {
  const key = REASONS[reason];
  return key ? REASON_TEXT[key] : `unknown reason ${reason}`;
}

export type WalletState = {
  wallet: Address; owner: Address; usdc: Address; frozen: boolean; policy: Policy; policyVersion: bigint;
  policyEngine: Address; vendorRegistry: Address; dailySpent: bigint; monthlySpent: bigint; balance: bigint;
};

// Spend counters only reset on the next spend; mirror _rollSpendWindow so reads show the live window.
export function rolledSpend(raw: { dailySpent: bigint; monthlySpent: bigint; spendDay: bigint; spendMonth: bigint }, nowSec: bigint) {
  return {
    dailySpent: nowSec / 86_400n === raw.spendDay ? raw.dailySpent : 0n,
    monthlySpent: nowSec / 2_592_000n === raw.spendMonth ? raw.monthlySpent : 0n,
  };
}

export async function readWallet(c: PublicClient, wallet: Address, nowSec = BigInt(Math.floor(Date.now() / 1000))): Promise<WalletState> {
  const code = await c.getCode({ address: wallet });
  if (!code || code === "0x") throw new Error(`${wallet} is not a contract on this chain, so it is not an ARCANUM wallet.`);
  const r = <T>(functionName: string) => c.readContract({ address: wallet, abi: walletAbi, functionName: functionName as never }) as Promise<T>;
  const [owner, usdc, frozen, policyTuple, policyVersion, policyEngine, vendorRegistry, dailySpent, monthlySpent, spendDay, spendMonth] = await Promise.all([
    r<Address>("owner"), r<Address>("usdc"), r<boolean>("frozen"),
    r<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean]>("policy"), r<bigint>("policyVersion"),
    r<Address>("policyEngine"), r<Address>("vendorRegistry"),
    r<bigint>("dailySpent"), r<bigint>("monthlySpent"), r<bigint>("spendDay"), r<bigint>("spendMonth"),
  ]);
  const balance = await c.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  const [perTxCap, daily24hCap, monthlyCap, allowedCategories, escalationThreshold, requireAllowlist, freezeOnBlockedVendor] = policyTuple;
  return {
    wallet, owner, usdc, frozen, policyVersion, policyEngine, vendorRegistry, balance,
    policy: { perTxCap, daily24hCap, monthlyCap, allowedCategories, escalationThreshold, requireAllowlist, freezeOnBlockedVendor },
    ...rolledSpend({ dailySpent, monthlySpent, spendDay, spendMonth }, nowSec),
  };
}

export type Preflight = {
  verdict: (typeof VERDICTS)[number] | "BLOCKED";
  reason: string;
  checks: string[];
};

// Asks the wallet's own PolicyEngine, as the wallet, exactly what executeUSDC would decide.
export async function preflight(c: PublicClient, s: WalletState, signer: Address, to: Address, amount: bigint): Promise<Preflight> {
  const [isSigner, vendor] = await Promise.all([
    c.readContract({ address: s.wallet, abi: walletAbi, functionName: "agentSigners", args: [signer] }),
    c.readContract({ address: s.vendorRegistry, abi: registryAbi, functionName: "getVendorFor", args: [s.wallet, to] }),
  ]);
  const checks = [
    `signer ${signer} is ${isSigner ? "" : "NOT "}an authorized agent signer`,
    `wallet is ${s.frozen ? "FROZEN" : "active"}`,
    `recipient is ${vendor.blocked ? "a BLOCKED vendor" : vendor.allowed ? `an allowed ${CATEGORIES[vendor.category] ?? "?"} vendor` : "not on the vendor list"}`,
    `balance ${formatUsdc(s.balance)} USDC, spent today ${formatUsdc(s.dailySpent)} of ${formatUsdc(s.policy.daily24hCap)}`,
  ];
  if (!isSigner) return { verdict: "BLOCKED", reason: "the PayBox wallet is not an authorized signer on this ARCANUM wallet", checks };
  if (s.frozen) return { verdict: "BLOCKED", reason: "the wallet is frozen; its owner must unfreeze it", checks };
  if (amount > s.balance) return { verdict: "BLOCKED", reason: `the wallet holds only ${formatUsdc(s.balance)} USDC`, checks };
  const [verdict, reason] = await c.readContract({
    address: s.policyEngine, abi: engineAbi, functionName: "evaluate", account: s.wallet,
    args: [s.policy, to, amount, s.dailySpent, s.monthlySpent, s.vendorRegistry],
  });
  return { verdict: VERDICTS[verdict] ?? "DENY", reason: reasonText(reason), checks };
}

export function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data) return undefined;
  try {
    const e = decodeErrorResult({ abi: walletAbi, data });
    return e.errorName === "TransferDenied" ? `TransferDenied: ${reasonText(Number(e.args?.[0]))}` : e.errorName;
  } catch {
    return undefined;
  }
}

export const calls = {
  pay: (to: Address, amount: bigint, reason: string): Hex =>
    encodeFunctionData({ abi: walletAbi, functionName: "executeUSDC", args: [to, amount, toHex(reason)] }),
  freeze: (reason: string): Hex => encodeFunctionData({ abi: walletAbi, functionName: "freeze", args: [toHex(reason)] }),
  unfreeze: (): Hex => encodeFunctionData({ abi: walletAbi, functionName: "unfreeze" }),
  addVendor: (vendor: Address, category: number, cap: bigint): Hex =>
    encodeFunctionData({ abi: walletAbi, functionName: "addVendor", args: [vendor, category, cap, `0x${"0".repeat(64)}`] }),
  fund: (wallet: Address, amount: bigint): Hex => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [wallet, amount] }),
  createWallet: (owner: Address, label: string, policy: Policy, signers: Address[], council: Address[], threshold: number, expiry: bigint): Hex =>
    encodeFunctionData({ abi: factoryAbi, functionName: "createWallet", args: [owner, label, policy, signers, council, threshold, expiry] }),
};

// Mirrors GuardedWallet._validatePolicy so a bad envelope fails here, not in a reverted transaction.
export function validatePolicy(p: Policy): void {
  if (p.perTxCap === 0n || p.daily24hCap === 0n) throw new Error("per_payment and daily caps must be above zero.");
  if (p.perTxCap > p.daily24hCap) throw new Error("per_payment cap cannot exceed the daily cap.");
  if (p.monthlyCap !== 0n && p.monthlyCap < p.daily24hCap) throw new Error("monthly cap cannot be below the daily cap.");
  if (p.escalationThreshold === 0n || p.escalationThreshold > p.perTxCap) {
    throw new Error("escalate_above must be above zero and at most the per_payment cap.");
  }
}
