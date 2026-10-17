# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). I aim to acknowledge reports within 72 hours and to agree a disclosure date with you before anything is published.

Useful reports include the affected tool or contract, the chain, a minimal reproduction (a fork test is ideal), and what an attacker gains.

## Scope

In scope:

- this plugin's tool logic, input validation and transaction encoding (`src/`)
- the deployment calls in `src/deploy-base.ts`
- anything that lets an agent move funds outside a wallet's policy

The ARCANUM contracts themselves live in [bunnyyxtan/ARCANUM](https://github.com/bunnyyxtan/ARCANUM). Report contract issues there.

Out of scope are PayBox itself, third-party RPC providers, and findings that need a compromised owner key.

## Trust model

- The plugin never holds keys, never signs and never broadcasts. Every write is an unsigned proposal that PayBox simulates and the user approves.
- The wallet contract is the authority. `arcanum_preflight` mirrors the contract's checks for a readable verdict, but a payment the contract rejects fails on-chain even if a preflight said otherwise.
- The ARCANUM contracts have not had an independent audit. Keep caps and balances small.
