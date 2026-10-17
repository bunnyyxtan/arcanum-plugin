# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-10-17

### Added

- PayBox plugin with ten tools: `arcanum_status`, `arcanum_preflight`, `arcanum_pay`, `arcanum_freeze`, `arcanum_unfreeze`, `arcanum_add_vendor`, `arcanum_fund`, `arcanum_create_wallet`, `arcanum_find_wallet` and `arcanum_deploy`.
- Base mainnet deployment of the ARCANUM v2 contracts, made through PayBox with no deployer key (`deployments/base-mainnet.json`).
- Arc mainnet support for reads, using the existing ARCANUM deployment (`deployments/arc-mainnet.json`).
- RPC fallback with batched requests across three public Base endpoints.
- Unit tests, a Base mainnet fork end-to-end test, and CI.
