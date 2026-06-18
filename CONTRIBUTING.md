# Contributing

OpenEmployee is an overlay that routes an OpenClaw agent's tools and commands
through MakerChecker's deny-by-default authorization and hash-chained audit log.
Read `docs/ARCHITECTURE.md` and the source before making changes.

## Setup

Requires Node >=22 and a working Docker install for integration tests.

```bash
./setup.sh                  # vendor openclaw + makerchecker, build @makerchecker/sdk
corepack pnpm install       # pnpm via corepack, not global
corepack pnpm -r build
corepack pnpm -r test
```

`setup.sh` restores `vendor/` (gitignored) and builds the SDK that the connector
and employee packages depend on. Run it before the first install.

## Testing is the product

The enforcement and audit guarantees are the product. Tests are the proof of
those guarantees, not hygiene.

- Every change lands with its tests in the same change. No test-later.
- Enforcement and audit paths require adversarial tests: attempt an ungranted
  tool, violate segregation of duties, replay a recorded decision, tamper an
  audit row, bypass the shell policy. If a guarantee is not attacked in a test,
  it is not a guarantee.
- Bug fixes start with a failing test that reproduces the bug.
- Never lower a coverage threshold to make a change pass.

## Integration tests

Integration tests run against a real MakerChecker server, never a mock.

```bash
cd vendor/makerchecker
docker compose up
```

Read `MAKERCHECKER_API_KEY` from the server's boot log and export it before
running the integration suite.

```bash
export MAKERCHECKER_API_KEY=<key from boot log>
corepack pnpm -r test
```

## Commits

Conventional commits. First line < 72 characters, imperative mood.
