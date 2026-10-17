import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { parseEventLogs, type Address, type Hex } from "viem";
import * as z from "zod/v4";

import {
  CATEGORIES, calls, client, deployment, eventsAbi, formatUsdc, parseAddress, parseUsdc,
  preflight, readWallet, validatePolicy, walletAbi, type ChainKey, type Deployment, type WalletState,
} from "./arcanum.js";
import { BASE_DEPLOY_STEPS } from "./deploy-base.js";
import { evmOutputSchema, proposeEvm } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";

const chain = z.enum(["base", "arc"]).describe("Network of the ARCANUM wallet. base is Base mainnet; arc is Arc mainnet.");
const address = (what: string) => z.string().max(42).describe(what);
const usdc = (what: string) => z.string().max(20).describe(`${what} in USDC as a decimal string, e.g. "2.50".`);
const signer = address("The PayBox EVM wallet address that will sign (public). It must be an agent signer, or the owner for owner actions.");

const statusOutput = z.object({
  chain: z.string(), wallet: z.string(), owner: z.string(), frozen: z.boolean(), balance_usdc: z.string(),
  per_payment_cap_usdc: z.string(), daily_cap_usdc: z.string(), monthly_cap_usdc: z.string(), escalate_above_usdc: z.string(),
  spent_today_usdc: z.string(), spent_30d_usdc: z.string(), allowlist_only: z.boolean(), policy_version: z.string(),
  signer_is_agent: z.boolean().optional(), signer_is_owner: z.boolean().optional(),
}).strict();

const preflightOutput = z.object({
  verdict: z.enum(["ALLOW", "ESCALATE", "DENY", "FREEZE", "BLOCKED"]), reason: z.string(), checks: z.array(z.string()),
}).strict();

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function caip(d: Deployment) {
  return `eip155:${d.chainId}`;
}

function capsText(s: WalletState) {
  const p = s.policy;
  return [
    `Per payment: ${formatUsdc(p.perTxCap)} USDC · Daily: ${formatUsdc(s.dailySpent)} / ${formatUsdc(p.daily24hCap)} USDC · 30 days: ${formatUsdc(s.monthlySpent)} / ${p.monthlyCap === 0n ? "no cap" : `${formatUsdc(p.monthlyCap)} USDC`}`,
    `Above ${formatUsdc(p.escalationThreshold)} USDC goes to the human council · ${p.requireAllowlist ? "Allowlisted vendors only" : "Any recipient"}`,
  ].join("\n");
}

function proposal(d: Deployment, to: Address, data: Hex, summary: string) {
  const result = proposeEvm({ chain: caip(d), to, data });
  return {
    ...result,
    content: [{ type: "text" as const, text: `${summary}\n\nUnsigned proposal on ${d.name}. PayBox simulates it and asks for approval; the ARCANUM contract enforces its policy again when it executes.` }],
  };
}

async function requireOwner(d: Deployment, wallet: string, from: string) {
  const s = await readWallet(client(d), parseAddress(wallet, "wallet"));
  if (s.owner !== parseAddress(from, "signer")) throw new Error(`Only the wallet owner ${s.owner} can do this; ${from} is not the owner.`);
  return s;
}

function createServer() {
  const server = new McpServer({ name: "arcanum", version: "0.1.0" }, { supportedProtocolVersions: [PROTOCOL_VERSION] });

  server.registerTool("arcanum_status", {
    title: "ARCANUM wallet status",
    description: "Read an ARCANUM guarded wallet: owner, frozen state, USDC balance, per-payment / daily / 30-day caps and what is already spent, escalation threshold and allowlist mode. Pass signer to check whether the PayBox wallet may spend from it. Read-only.",
    inputSchema: z.object({ chain, wallet: address("ARCANUM GuardedWallet address."), signer: signer.optional() }).strict(),
    outputSchema: statusOutput,
    annotations: READ,
  }, async ({ chain: key, wallet, signer: from }) => {
    const d = deployment(key as ChainKey);
    const c = client(d);
    const s = await readWallet(c, parseAddress(wallet, "wallet"));
    let isAgent: boolean | undefined;
    if (from) isAgent = await c.readContract({ address: s.wallet, abi: walletAbi, functionName: "agentSigners", args: [parseAddress(from, "signer")] });
    const out = {
      chain: d.name, wallet: s.wallet, owner: s.owner, frozen: s.frozen, balance_usdc: formatUsdc(s.balance),
      per_payment_cap_usdc: formatUsdc(s.policy.perTxCap), daily_cap_usdc: formatUsdc(s.policy.daily24hCap),
      monthly_cap_usdc: formatUsdc(s.policy.monthlyCap), escalate_above_usdc: formatUsdc(s.policy.escalationThreshold),
      spent_today_usdc: formatUsdc(s.dailySpent), spent_30d_usdc: formatUsdc(s.monthlySpent), allowlist_only: s.policy.requireAllowlist,
      policy_version: s.policyVersion.toString(),
      ...(from ? { signer_is_agent: isAgent, signer_is_owner: s.owner === parseAddress(from, "signer") } : {}),
    };
    const text = [
      `ARCANUM wallet ${s.wallet} on ${d.name}: ${s.frozen ? "FROZEN" : "active"}, ${formatUsdc(s.balance)} USDC`,
      capsText(s),
      `Owner ${s.owner}${from ? ` · ${from} is ${isAgent ? "an agent signer" : "not an agent signer"}${out.signer_is_owner ? " and the owner" : ""}` : ""}`,
      `${d.explorer}/address/${s.wallet}`,
    ].join("\n");
    return { content: [{ type: "text", text }], structuredContent: out };
  });

  server.registerTool("arcanum_preflight", {
    title: "Check a payment against the wallet's on-chain policy",
    description: "Ask the wallet's own PolicyEngine whether a USDC payment would be ALLOWED, ESCALATED to the human council, DENIED or would FREEZE the wallet, and why. Run this before arcanum_pay and tell the user the verdict. Read-only.",
    inputSchema: z.object({ chain, wallet: address("ARCANUM GuardedWallet address."), signer, to: address("Recipient address."), amount_usdc: usdc("Amount") }).strict(),
    outputSchema: preflightOutput,
    annotations: READ,
  }, async ({ chain: key, wallet, signer: from, to, amount_usdc }) => {
    const d = deployment(key as ChainKey);
    const c = client(d);
    const s = await readWallet(c, parseAddress(wallet, "wallet"));
    const r = await preflight(c, s, parseAddress(from, "signer"), parseAddress(to, "to"), parseUsdc(amount_usdc, "amount_usdc"));
    const text = [`Verdict: ${r.verdict} (${r.reason}) for ${amount_usdc} USDC to ${to}`, ...r.checks.map((x) => `· ${x}`), capsText(s)].join("\n");
    return { content: [{ type: "text", text }], structuredContent: r };
  });

  server.registerTool("arcanum_pay", {
    title: "Pay from an ARCANUM wallet",
    description: "Propose a USDC payment from an ARCANUM guarded wallet, signed by the PayBox wallet as agent signer. Runs the on-chain policy preflight first and refuses DENY, FREEZE or BLOCKED verdicts. An ESCALATE verdict proposes the call, which parks the payment for the human council instead of sending it. Only call after telling the user the preflight verdict.",
    inputSchema: z.object({
      chain, wallet: address("ARCANUM GuardedWallet address."), signer, to: address("Recipient address."), amount_usdc: usdc("Amount"),
      reason: z.string().min(1).max(140).describe("Short purpose recorded on-chain with the payment, e.g. \"invoice 42\"."),
      propose_even_if_denied: z.boolean().optional().describe("Default false. When true and the verdict is DENY, still return the proposal so PayBox's simulation shows the contract refusing it. Use only when the user asks to see the contract enforce the rule."),
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async ({ chain: key, wallet, signer: from, to, amount_usdc, reason, propose_even_if_denied }) => {
    const d = deployment(key as ChainKey);
    const c = client(d);
    const s = await readWallet(c, parseAddress(wallet, "wallet"));
    const recipient = parseAddress(to, "to");
    const amount = parseUsdc(amount_usdc, "amount_usdc");
    const r = await preflight(c, s, parseAddress(from, "signer"), recipient, amount);
    const denied = r.verdict === "DENY" || r.verdict === "FREEZE" || r.verdict === "BLOCKED";
    if (denied && !(propose_even_if_denied && r.verdict === "DENY")) {
      throw new Error(`ARCANUM policy says ${r.verdict}: ${r.reason}. No payment was proposed.`);
    }
    const note = r.verdict === "ESCALATE"
      ? `Above the escalation threshold: executing parks ${amount_usdc} USDC for the human council; nothing reaches ${recipient} until they approve.`
      : r.verdict === "DENY"
        ? `Policy verdict DENY (${r.reason}). Proposed on request so PayBox's simulation can show the contract reverting with TransferDenied.`
        : `Policy verdict ALLOW: ${amount_usdc} USDC to ${recipient}.`;
    return proposal(d, s.wallet, calls.pay(recipient, amount, reason), `${note}\n${capsText(s)}`);
  });

  server.registerTool("arcanum_freeze", {
    title: "Freeze an ARCANUM wallet",
    description: "Owner kill switch: propose freezing the wallet so no agent can spend until the owner unfreezes it. signer must be the wallet owner.",
    inputSchema: z.object({ chain, wallet: address("ARCANUM GuardedWallet address."), signer, reason: z.string().min(1).max(140).describe("Why it is being frozen; recorded on-chain.") }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async ({ chain: key, wallet, signer: from, reason }) => {
    const d = deployment(key as ChainKey);
    const s = await requireOwner(d, wallet, from);
    if (s.frozen) throw new Error("The wallet is already frozen.");
    return proposal(d, s.wallet, calls.freeze(reason), `Freeze ${s.wallet}: every agent payment will revert until the owner unfreezes it.`);
  });

  server.registerTool("arcanum_unfreeze", {
    title: "Unfreeze an ARCANUM wallet",
    description: "Owner action: propose lifting a freeze after review. signer must be the wallet owner.",
    inputSchema: z.object({ chain, wallet: address("ARCANUM GuardedWallet address."), signer }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async ({ chain: key, wallet, signer: from }) => {
    const d = deployment(key as ChainKey);
    const s = await requireOwner(d, wallet, from);
    if (!s.frozen) throw new Error("The wallet is not frozen.");
    return proposal(d, s.wallet, calls.unfreeze(), `Unfreeze ${s.wallet}: agents can spend again within policy.`);
  });

  server.registerTool("arcanum_add_vendor", {
    title: "Allow a vendor on an ARCANUM wallet",
    description: "Owner action: propose adding a recipient to the wallet's vendor allowlist with a category and optional per-vendor cap. signer must be the wallet owner.",
    inputSchema: z.object({
      chain, wallet: address("ARCANUM GuardedWallet address."), signer, vendor: address("Vendor address to allow."),
      category: z.enum(CATEGORIES).describe("Vendor category; the policy can disable whole categories."),
      per_vendor_cap_usdc: usdc("Optional cap per payment to this vendor").optional(),
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async ({ chain: key, wallet, signer: from, vendor, category, per_vendor_cap_usdc }) => {
    const d = deployment(key as ChainKey);
    const s = await requireOwner(d, wallet, from);
    const cap = per_vendor_cap_usdc ? parseUsdc(per_vendor_cap_usdc, "per_vendor_cap_usdc") : 0n;
    const v = parseAddress(vendor, "vendor");
    return proposal(d, s.wallet, calls.addVendor(v, CATEGORIES.indexOf(category), cap),
      `Allow ${v} as a ${category} vendor${cap ? ` capped at ${formatUsdc(cap)} USDC per payment` : ""}.`);
  });

  server.registerTool("arcanum_fund", {
    title: "Fund an ARCANUM wallet",
    description: "Propose a plain USDC transfer from the PayBox wallet into an ARCANUM guarded wallet so its agents have a budget.",
    inputSchema: z.object({ chain, wallet: address("ARCANUM GuardedWallet address."), amount_usdc: usdc("Amount") }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async ({ chain: key, wallet, amount_usdc }) => {
    const d = deployment(key as ChainKey);
    const s = await readWallet(client(d), parseAddress(wallet, "wallet"));
    return proposal(d, d.usdc, calls.fund(s.wallet, parseUsdc(amount_usdc, "amount_usdc")), `Move ${amount_usdc} USDC into ARCANUM wallet ${s.wallet}.`);
  });

  server.registerTool("arcanum_create_wallet", {
    title: "Create an ARCANUM guarded wallet",
    description: "Propose deploying a new ARCANUM GuardedWallet through the factory: the owner sets per-payment, daily and 30-day USDC caps, an escalation threshold, allowlist mode, agent signers and a human council. The PayBox wallet is the default owner, agent signer and council. After it confirms, call arcanum_find_wallet with the transaction hash to get the address.",
    inputSchema: z.object({
      chain, owner: address("Owner address, normally the PayBox wallet."), label: z.string().min(1).max(64),
      per_payment_usdc: usdc("Maximum per payment"), daily_usdc: usdc("Maximum spend per 24-hour window"),
      monthly_usdc: usdc("Maximum spend per 30-day window; omit for none").optional(),
      escalate_above_usdc: usdc("Payments above this go to the council; defaults to the per-payment cap (no escalation)").optional(),
      allowlist_only: z.boolean().optional().describe("Default true: agents may only pay allowlisted vendors."),
      agent_signers: z.array(z.string().max(42)).max(8).optional().describe("Agent signer addresses; defaults to [owner]."),
      council: z.array(z.string().max(42)).max(8).optional().describe("Human council for escalations; defaults to [owner]."),
      council_threshold: z.int().min(1).max(8).optional().describe("Council approvals needed; default 1."),
    }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async (a) => {
    const d = deployment(a.chain as ChainKey);
    const owner = parseAddress(a.owner, "owner");
    const factoryCode = await client(d).getCode({ address: d.walletFactory });
    if (!factoryCode || factoryCode === "0x") throw new Error(`The ARCANUM factory is not deployed on ${d.name} yet.`);
    const perTx = parseUsdc(a.per_payment_usdc, "per_payment_usdc");
    const policy = {
      perTxCap: perTx, daily24hCap: parseUsdc(a.daily_usdc, "daily_usdc"),
      monthlyCap: a.monthly_usdc ? parseUsdc(a.monthly_usdc, "monthly_usdc") : 0n,
      allowedCategories: (1n << BigInt(CATEGORIES.length)) - 1n,
      escalationThreshold: a.escalate_above_usdc ? parseUsdc(a.escalate_above_usdc, "escalate_above_usdc") : perTx,
      requireAllowlist: a.allowlist_only ?? true, freezeOnBlockedVendor: true,
    };
    validatePolicy(policy);
    const signers = (a.agent_signers?.length ? a.agent_signers : [owner]).map((x) => parseAddress(x, "agent_signers"));
    const council = (a.council?.length ? a.council : [owner]).map((x) => parseAddress(x, "council"));
    const threshold = a.council_threshold ?? 1;
    if (threshold > council.length) throw new Error("council_threshold cannot exceed the council size.");
    if (new Set(council).size !== council.length) throw new Error("council has a duplicate address.");
    return proposal(d, d.walletFactory, calls.createWallet(owner, a.label, policy, signers, council, threshold, 86_400n),
      `Create ARCANUM wallet "${a.label}" owned by ${owner}: ${a.per_payment_usdc} USDC per payment, ${a.daily_usdc} USDC per day, ${policy.requireAllowlist ? "allowlisted vendors only" : "any recipient"}, council ${threshold} of ${council.length}.`);
  });

  server.registerTool("arcanum_deploy", {
    title: "Deploy ARCANUM to Base",
    description: "Deploy the ARCANUM protocol contracts to Base through PayBox, one module per call, with no deployer key. Each call returns the next module that is not deployed yet as a proposal to the canonical CREATE2 deployer; call again after each one confirms until it reports all five are live.",
    inputSchema: z.object({ chain: z.literal("base").describe("Only Base is deployable from here; Arc is already live.") }).strict(),
    outputSchema: evmOutputSchema,
    annotations: WRITE,
  }, async () => {
    const d = deployment("base");
    const c = client(d);
    const live = await Promise.all(BASE_DEPLOY_STEPS.map(async (s) => {
      const code = await c.getCode({ address: s.address as Address });
      return !!code && code !== "0x";
    }));
    const next = live.indexOf(false);
    if (next === -1) throw new Error(`All five ARCANUM modules are already live on Base. Factory ${d.walletFactory}.`);
    const s = BASE_DEPLOY_STEPS[next]!;
    const progress = BASE_DEPLOY_STEPS.map((x, i) => `${live[i] ? "✓" : i === next ? "→" : "·"} ${i + 1}. ${x.name} ${x.address}`).join("\n");
    return proposal(d, s.to as Address, s.data as Hex, `Deploy step ${next + 1} of 5: ${s.name} at ${s.address}.\n${progress}`);
  });

  server.registerTool("arcanum_find_wallet", {
    title: "Find the wallet created by a transaction",
    description: "Read the WalletCreated event from a confirmed arcanum_create_wallet transaction and return the new wallet address. Read-only.",
    inputSchema: z.object({ chain, tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Confirmed transaction hash.") }).strict(),
    outputSchema: z.object({ wallet: z.string(), owner: z.string(), label: z.string() }).strict(),
    annotations: READ,
  }, async ({ chain: key, tx_hash }) => {
    const d = deployment(key as ChainKey);
    const receipt = await client(d).getTransactionReceipt({ hash: tx_hash as Hex });
    const [ev] = parseEventLogs({ abi: eventsAbi, logs: receipt.logs, eventName: "WalletCreated" });
    if (!ev) throw new Error("That transaction did not create an ARCANUM wallet.");
    const out = { wallet: ev.args.wallet, owner: ev.args.owner, label: ev.args.label };
    return { content: [{ type: "text", text: `ARCANUM wallet "${out.label}" is ${out.wallet} (owner ${out.owner}).\n${d.explorer}/address/${out.wallet}` }], structuredContent: out };
  });

  return server;
}

serveStdio(createServer, { legacy: "reject" });
