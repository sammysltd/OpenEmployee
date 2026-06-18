# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-17

### Added

- `@openemployee/connector-openclaw` — the OpenClaw plugin that governs an agent
  with MakerChecker: a deny-by-default trusted-tool policy (CHECK, fail closed), a
  separate `after_tool_call` hook (RECORD), and a node-invoke policy for shell.
- `@openemployee/employee` — the declarative `Employee` model and idempotent
  `onboard` / `offboard` (role, skills, grants, agent via the SDK; segregation of
  duties via SQL).
- Runnable demos: the live `control-room` dashboard, the `coding-agent` and
  `ungoverned-vs-governed` before/afters, the `approval` human-in-the-loop
  round-trip, the flagship `org-demo`, and a `smoke` check. A `Makefile` drives
  them in one command (`make up`, `make demo`, `make approval`, …).
- `docs/ARCHITECTURE.md` — the architecture overview.
