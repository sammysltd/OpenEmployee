# Security Policy

## Reporting a vulnerability

Email **security@makerchecker.ai**. Do not open public issues, pull requests, or
discussions for suspected vulnerabilities.

Include the affected version or commit, a description of the issue, and steps to
reproduce. We acknowledge reports on a best-effort basis and will coordinate a
fix and disclosure timeline with you. Please give us reasonable time to ship a
fix before any public disclosure.

## Security model

OpenEmployee is an overlay that routes every OpenClaw tool and command through
MakerChecker before it runs and records the outcome afterward.

### What it guarantees

- **Deny-by-default authorization before execution.** A tool call is checked
  against the agent's role and versioned skill grants (`proxy.check`) and fails
  closed: no grant, no execution. Segregation-of-duties constraints and
  high-risk approval gates are enforced at the same point.
- **Tamper-evident audit.** Decisions and outcomes are written to a
  hash-chained, signed audit log. Altering or removing a record breaks the
  chain and is detectable on verification.

### What it does NOT guarantee

OpenEmployee is an authorization and evidence layer, not a sandbox. It decides
whether a skill may run and records that it did; it does not contain what a
permitted skill does once it runs. The host environment must still constrain
the blast radius of any allowed skill (filesystem, network, credentials,
process isolation).

Known caveats:

- **Local-shell bypass.** A local or sandbox shell can bypass the node-invoke
  policy unless shell execution is routed to a node host. We mitigate this by
  also mapping the local-exec tool name, but direct local execution outside the
  routed path is not gated.
- **Fire-and-forget record.** The `after_tool_call` RECORD step is
  best-effort. The authorization decision is persisted by the proxy at check
  time; the post-execution outcome record is not guaranteed to land if the
  process dies between execution and record.

These are documented limitations and roadmap items, not a substitute for host
containment.
