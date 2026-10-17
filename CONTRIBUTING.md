# Contributing

Thanks for taking the time. Issues and pull requests are welcome.

## Setup

Requires Node 24 and pnpm 11.11.0.

```bash
corepack enable
pnpm install --frozen-lockfile
```

## Checks to run before a pull request

```bash
pnpm unit      # unit tests
pnpm test      # typecheck, two builds compared byte for byte, MCP conformance
pnpm e2e:fork  # needs an anvil fork of Base on FORK_RPC (default http://127.0.0.1:8546)
```

Start the fork with Foundry:

```bash
anvil --fork-url https://mainnet.base.org --port 8546
```

The starter's environment check accepts Linux and macOS. CI runs on Ubuntu.

## Guidelines

- Keep each tool to one read or one proposal. PayBox signs exactly one EVM call per proposal.
- Validate every input at the tool boundary (addresses, USDC amounts, policy envelopes) and fail with a message an agent can act on.
- Never add a code path that signs, broadcasts or reads a secret. Credentials belong in PayBox brokered headers.
- Network calls stay out of module startup and tool discovery, and every request is bounded so a call fits PayBox's 10 second budget.
- Add or update a unit test for new behaviour, and extend `test/fork.e2e.ts` when a change touches what reaches the chain.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages.
