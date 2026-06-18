# @openemployee/connector-openclaw

Govern an [OpenClaw](https://github.com/openclaw/openclaw) agent with
[MakerChecker](https://makerchecker.ai). One plugin routes every tool call and
shell command through deny-by-default authorization *before* it runs, and records
the outcome into a hash-chained, signed audit log *after*.

It registers three things on the OpenClaw plugin api:

- `registerTrustedToolPolicy` — the **CHECK** gate. Maps the tool to a skill, calls
  `proxy.check`, and returns `{ block: true }` on any denial, unmapped tool, or
  transport error. Fail closed: the tool body never runs.
- `registerHook("after_tool_call", …)` — the **RECORD** step, correlated to the
  check by tool-call id (the pre-call event cannot see the result).
- `registerNodeInvokePolicy` — the same gate for shell/node commands.

## Programmatic

```ts
import { governOpenClaw } from "@openemployee/connector-openclaw";

const gov = await governOpenClaw({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.MAKERCHECKER_API_KEY,
  agentName: "research-assistant",
  externalRef: "owner:alice@corp",
  toolSkillMap: { web_fetch: "web-fetch@1" }, // deny by default: only these run
});

register(api) {
  gov.register(api); // wires CHECK + RECORD + shell onto the host
}
```

## As an OpenClaw plugin

Point OpenClaw at this directory (`plugins.load.paths`) and configure via the
environment: `MAKERCHECKER_BASE_URL`, `MAKERCHECKER_API_KEY`,
`OPENEMPLOYEE_AGENT_NAME`, `OPENEMPLOYEE_TOOL_SKILL_MAP` (JSON), and optionally
`OPENEMPLOYEE_COMMAND_SKILL_MAP` and `OPENEMPLOYEE_OWNER`. Misconfiguration fails
closed.

High-risk skills are denied at the proxy (`high_risk_requires_gate`); route that
work through a MakerChecker flow with an approval gate.

See the [repo README](../../README.md) and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## License

MIT.
