# OpenEmployee — Architecture

OpenEmployee turns an OpenClaw agent into a governed AI employee. Every tool call
and shell command the agent makes is routed through MakerChecker's control plane:
deny-by-default skill grants, segregation-of-duties (SoD), approval gates for
high-risk work, and a hash-chained, signed audit log.

It is an overlay, not a fork. OpenClaw runs unchanged. One plugin joins the two
systems.

## The overlay

Two systems, one plugin between them:

- **OpenClaw runtime** — the agent loop: chooses tools, runs them, runs shell.
- **MakerChecker control plane** — authorization (`proxy.check`), audit recording
  (`proxy.record`), roles, grants, SoD, approval flows, the signed audit chain.

The connector (`packages/connector-openclaw`) is an OpenClaw plugin and a normal
dependency on `@makerchecker/sdk`. It registers three policies at startup. Nothing
in OpenClaw's core is modified.

```
   OpenClaw agent runtime                 MakerChecker control plane
  ┌──────────────────────┐               ┌──────────────────────────┐
  │  agent picks a tool  │               │                          │
  │          │           │   CHECK       │  proxy.check             │
  │          ▼           │──────────────▶│   deny by default        │
  │  TrustedToolPolicy   │◀──────────────│   allowed:true → checkId │
  │  .evaluate (gate)    │   allow/block │   allowed:false → code   │
  │          │           │               │                          │
  │   tool executes      │               │                          │
  │          │           │   RECORD      │  proxy.record            │
  │          ▼           │──────────────▶│   {checkId, output|error}│
  │  after_tool_call hook│               │                          │
  │          │           │               │                          │
  │  remote shell        │   CHECK+RUN   │  proxy.check, then       │
  │  (node.invoke)       │──────────────▶│   record on allow        │
  │  NodeInvokePolicy    │               │                          │
  └──────────────────────┘               │  audit_events            │
                                         │  hash-chained, signed    │
                                         └──────────────────────────┘
```

## Request path

Three registration points, wired in the plugin entry:

```ts
register(api) {
  api.registerTrustedToolPolicy(makerCheckerPolicy(deps)); // CHECK
  api.registerHook("after_tool_call", afterToolCall(deps)); // RECORD
  api.registerNodeInvokePolicy(nodeShellPolicy(deps));      // SHELL
}
```

### 1. CHECK — before a tool runs (fail closed)

`registerTrustedToolPolicy.evaluate` is OpenClaw's pre-execution gate; it runs
before the tool, and a `{ block: true }` return stops the call.

- Look up the tool in the deny-by-default map. No mapping → block.
- Call `proxy.check(sessionId, { agentName, skillRef, input? })`.
- `allowed: false` (or any thrown error) → `{ block: true, blockReason }`. The
  tool never runs. This is fail closed.
- `allowed: true` → stash the returned `checkId` keyed by `toolCallId`, return
  `{}` (allow, no rewrite).

### 2. RECORD — after a tool runs

Recording happens in a separate `after_tool_call` hook, not inside the gate. The
pre-call event carries no `result`/`error`, so the gate cannot observe the
outcome. The after hook carries `result`, `error`, and `durationMs`.

- Pop the stashed `checkId` for this `toolCallId`. No `checkId` → the call was
  blocked or unmapped → nothing to record.
- On error: `proxy.record(sessionId, { checkId, error: { message } })`.
- Otherwise: `proxy.record(sessionId, { checkId, output })`.

**Correlation** is by `toolCallId`: CHECK stashes, RECORD pops. The after hook is
fire-and-forget — a failed record never blocks the tool's result.

### 3. SHELL — remote command execution

Tool policies do not see remote shell; it arrives as a `node.invoke` with
`command: "system.run"`. A node-invoke policy gates it:

- `commands: ["system.run", "system.run.prepare"]` — no wildcards; commands are
  matched by exact membership, so every gated command is enumerated.
- `dangerous: true` — any registered-but-unmatched dangerous command is blocked.
- `handle` runs `proxy.check`; on deny returns `{ ok: false, code, message }` and
  never invokes the node; on allow calls `ctx.invokeNode()` then records.

## Deny by default: tool → skillRef

A static `Record<openclawToolName, "name@version">` is the closed set of what the
employee may do.

- Only mapped tools can run. Everything else blocks at CHECK before any network
  call.
- SkillRefs are pinned to a version (`csv-ingest@1`). The proxy resolves
  `name`+`version` to one skill row, so a skill bump is a deliberate map edit —
  nothing is edited in place.
- Shell has its own entry under `system.run`.

The map and the server-side grants must agree. A tool granted in MakerChecker but
absent from the map is unreachable (blocked at the connector). A mapped tool not
granted is denied by the proxy with `skill_not_granted`. The map is, in effect,
the employee's job description.

## High-risk work → approval flow

The proxy enforces high-risk categorically; the connector implements no risk logic
of its own. When a mapped skill has `risk_tier="high"`, `proxy.check` denies with
`high_risk_requires_gate`, and CHECK blocks it like any other denial.

To actually do high-risk work, route it through a **flow with an approval gate**:

```
flows.trigger(name, input) → runId
runs.get(runId)            → run, steps, approvals, auditEvents
approvals.list()           → pending approvals (required/approved counts, overdue)
approvals.decide(id, "approved" | "rejected", reason?)
```

The full denial-code set the connector surfaces in `blockReason`:
`agent_not_found`, `agent_not_active`, `skill_not_found`, `skill_not_granted`,
`high_risk_requires_gate`, `sod_violation`. Every denial is itself written to the
audit chain server-side — blocked attempts are evidence, not silence.

## The Employee model

An employee is one OpenClaw agent bound to one MakerChecker agent record.

| Concept | MakerChecker primitive |
|---|---|
| Identity | `agents` row (`agentName`), one role |
| Job / permissions | `roles` row |
| What it may do | `role_skill_grants` (deny by default) |
| What it may not combine | `sod_constraints` |
| Capability catalog | `skills` (`name@version`, `risk_tier`) |
| Owner / accountability | session `label` / `externalRef` + admin actor |

- **Onboard** (idempotent): `roles.create` → `skills.publish` → `grants.create` →
  `agents.create`, all via the SDK. SoD constraints have no SDK route and are
  seeded via SQL.
- **Offboard**: `agents.setStatus(id, "retired" | "suspended")`, plus
  `grants.revoke` / `skills.deprecate`. A non-active agent is denied at the proxy
  with `agent_not_active`.
- **Owner.** MakerChecker has no first-class owner column. Accountability is
  modeled through the proxy session's `externalRef` (e.g.
  `externalRef: "owner:alice@corp"`), carried into the audit chain, plus the
  authenticated admin `actor` that created the agent.

## The audit chain

Every check decision and every recorded outcome lands in `audit_events`,
hash-chained and signed.

- **Per-run view**: `runs.get(id).auditEvents`.
- **Per-session view**: `proxy.getSession(sessionId)` → `{ session, actions,
  auditEvents }`. Each event has `seq, occurred_at, actor, event_type, payload,
  hash`.
- **Integrity**: `audit.verify()` → `{ ok, count, headHash }` proves the chain has
  not been tampered with.

Because the proxy persists the decision at check time, even a denied or
un-recorded attempt is in the chain.

## Honest limitations

These are roadmap items, not defects.

- **Local/sandbox shell can bypass the node policy.** Local exec does not route
  through `node.invoke`, so node policies do not see it. Mitigation: route shell to
  a node host in the agent config, and map the local-exec tool name into the
  trusted-tool map so the tool layer gates it too.
- **Owner is modeled client-side.** Owner lives in the session `externalRef`, not
  a dedicated `agents` column. A first-class owner field is a server change.
- **No global audit enumeration.** There is no `proxy.listSessions`; only
  `getSession(id)`. Enumerating all employee activity requires retaining session
  IDs locally, or a new server route.
- **RECORD-after is fire-and-forget.** If the process dies between CHECK and
  RECORD, the proxy has a decision with no recorded outcome. The decision is never
  lost; treat a check-without-record as "outcome unknown" and reconcile via
  `proxy.getSession`. A stronger guarantee needs a server-side reaper.
- **No SDK routes for SoD, flow definitions, or signed audit export.** SoD is
  seeded via SQL; flows are defined out-of-band at deploy time; offline signed
  bundle export exists server-side but is not yet exposed in the SDK.
