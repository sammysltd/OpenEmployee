import { describe, expect, it, vi } from "vitest";
import type { ProxyCheckResult } from "@makerchecker/sdk";

import { CheckIdStore } from "./store.js";
import {
  createGovernance,
  governOpenClaw,
  makeAfterToolCall,
  makeNodePolicy,
  makeToolPolicy,
  type GovernanceClient,
  type GovernanceDeps,
} from "./governance.js";
import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
  OpenClawPluginNodeInvokePolicyContext,
} from "./openclaw-shim.js";

// governOpenClaw uses the real createClient; the rest of the suite builds a fake
// client directly. The mock only affects governOpenClaw.
vi.mock("@makerchecker/sdk", () => ({
  createClient: vi.fn(() => ({
    proxy: {
      openSession: vi.fn(async () => ({ session: { id: "opened-session" } })),
      check: vi.fn(),
      record: vi.fn(),
    },
  })),
}));

type CheckReturn = ProxyCheckResult | Error;

function buildClient(checks: CheckReturn[]) {
  const check = vi.fn(async () => {
    const next = checks.shift() ?? { allowed: false as const, code: "exhausted", reason: "no scripted check" };
    if (next instanceof Error) throw next;
    return next;
  });
  const record = vi.fn(async () => ({ ok: true }));
  const client = { proxy: { check, record } } as unknown as GovernanceClient;
  return { client, check, record };
}

function buildDeps(checks: CheckReturn[], overrides: Partial<GovernanceDeps> = {}) {
  const { client, check, record } = buildClient(checks);
  const deps: GovernanceDeps = {
    client,
    sessionId: "sess-1",
    agentName: "research-assistant",
    toolSkillMap: { fetch_report: "csv-ingest@1" },
    commandSkillMap: { "system.run": "shell-run@1" },
    store: new CheckIdStore(),
    ...overrides,
  };
  return { deps, check, record };
}

const beforeEvent = (
  toolName: string,
  params: unknown = {},
  toolCallId = "call-1",
): PluginHookBeforeToolCallEvent =>
  ({ toolName, params, toolCallId } as unknown as PluginHookBeforeToolCallEvent);

const toolCtx = (toolName: string, toolCallId = "call-1"): PluginHookToolContext => ({ toolName, toolCallId });

const afterEvent = (over: Partial<PluginHookAfterToolCallEvent>): PluginHookAfterToolCallEvent => ({
  toolName: "fetch_report",
  params: {},
  toolCallId: "call-1",
  ...over,
});

function nodeCtx(command: string, transport: unknown = { ok: true, payload: { stdout: "ok" } }) {
  const invokeNode = vi.fn(async () => transport);
  const ctx = { command, params: { cmd: command }, invokeNode } as unknown as OpenClawPluginNodeInvokePolicyContext;
  return { ctx, invokeNode };
}

describe("makeToolPolicy — CHECK gate", () => {
  it("blocks on a proxy deny and never records (fail closed)", async () => {
    const { deps, check, record } = buildDeps([{ allowed: false, code: "skill_not_granted", reason: "role lacks grant" }]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("skill_not_granted");
    expect(check).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });

  it("allows, stashes the checkId, and records the output after the call", async () => {
    const { deps, check, record } = buildDeps([{ allowed: true, checkId: "c1" }]);
    const policy = makeToolPolicy(deps);
    const after = makeAfterToolCall(deps);
    const decision = await policy.evaluate(beforeEvent("fetch_report", { quarter: "Q1" }), toolCtx("fetch_report"));
    expect(decision).toEqual({});
    expect(check).toHaveBeenCalledWith("sess-1", {
      agentName: "research-assistant",
      skillRef: "csv-ingest@1",
      input: { quarter: "Q1" },
    });
    await after(afterEvent({ result: { rows: 3 } }));
    expect(record).toHaveBeenCalledWith("sess-1", { checkId: "c1", output: { rows: 3 } });
  });

  it("records an error (coerced to {message}) when the tool throws", async () => {
    const { deps, record } = buildDeps([{ allowed: true, checkId: "c1" }]);
    await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    // a fresh after handler shares the same store via deps
    const after = makeAfterToolCall(deps);
    await after(afterEvent({ error: "boom" }));
    expect(record).toHaveBeenCalledWith("sess-1", { checkId: "c1", error: { message: "boom" } });
  });

  it("blocks an unmapped tool with no network call (deny by default)", async () => {
    const { deps, check } = buildDeps([]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("rm_rf"), toolCtx("rm_rf"));
    expect(decision).toMatchObject({ block: true });
    expect(check).not.toHaveBeenCalled();
  });

  it("surfaces the high-risk gate denial code", async () => {
    const { deps } = buildDeps([{ allowed: false, code: "high_risk_requires_gate", reason: "needs approval" }]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    expect((decision as { blockReason: string }).blockReason).toContain("high_risk_requires_gate");
  });

  it("omits input when params are not a plain record", async () => {
    const { deps, check } = buildDeps([{ allowed: true, checkId: "c1" }]);
    await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report", [1, 2]), toolCtx("fetch_report"));
    expect(check).toHaveBeenCalledWith("sess-1", { agentName: "research-assistant", skillRef: "csv-ingest@1" });
  });

  it("does not record for a call that never passed CHECK", async () => {
    const { deps, record } = buildDeps([]);
    await makeAfterToolCall(deps)(afterEvent({ result: { x: 1 } }));
    expect(record).not.toHaveBeenCalled();
  });

  it("fails closed when the proxy check rejects (transport error)", async () => {
    const { deps, record } = buildDeps([new Error("ECONNREFUSED")]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("authz_unavailable");
    expect(record).not.toHaveBeenCalled();
  });

  it("sends RAW params to check (enforcement) and redacts only the recorded output", async () => {
    const redact = (v: unknown) => (isObj(v) ? { ...v, secret: "***" } : v);
    const { deps, check, record } = buildDeps([{ allowed: true, checkId: "c1" }], { redact });
    const policy = makeToolPolicy(deps);
    const after = makeAfterToolCall(deps);
    await policy.evaluate(beforeEvent("fetch_report", { secret: "hunter2" }), toolCtx("fetch_report"));
    expect(check).toHaveBeenCalledWith("sess-1", {
      agentName: "research-assistant",
      skillRef: "csv-ingest@1",
      input: { secret: "hunter2" },
    });
    await after(afterEvent({ result: { secret: "topsecret" } }));
    expect(record).toHaveBeenCalledWith("sess-1", { checkId: "c1", output: { secret: "***" } });
  });

  it("blocks tool names that collide with Object.prototype keys", async () => {
    const { deps, check } = buildDeps([]);
    for (const evil of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const decision = await makeToolPolicy(deps).evaluate(beforeEvent(evil, {}, evil), toolCtx(evil, evil));
      expect(decision).toMatchObject({ block: true });
    }
    expect(check).not.toHaveBeenCalled();
  });
});

describe("makeToolPolicy — DLP content guard", () => {
  it("blocks a mapped tool when the guard flags the payload, before any proxy.check", async () => {
    const guard = vi.fn(() => ({ reason: "body contains an API key" }));
    const { deps, check } = buildDeps([{ allowed: true, checkId: "c1" }], { guard });
    const decision = await makeToolPolicy(deps).evaluate(
      beforeEvent("fetch_report", { body: "sk-abcDEF0123456789ghijkl" }),
      toolCtx("fetch_report"),
    );
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("openemployee DLP: body contains an API key");
    // the proxy is never consulted once the guard blocks.
    expect(check).not.toHaveBeenCalled();
    expect(guard).toHaveBeenCalledWith("fetch_report", { body: "sk-abcDEF0123456789ghijkl" });
  });

  it("runs the guard AFTER deny-by-default — an unmapped tool blocks without invoking the guard", async () => {
    const guard = vi.fn(() => null);
    const { deps, check } = buildDeps([], { guard });
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("rm_rf", { body: "x" }), toolCtx("rm_rf"));
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("deny by default");
    expect(guard).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("passes a clean payload through to proxy.check unchanged", async () => {
    const guard = vi.fn(() => null);
    const { deps, check } = buildDeps([{ allowed: true, checkId: "c1" }], { guard });
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report", { quarter: "Q1" }), toolCtx("fetch_report"));
    expect(decision).toEqual({});
    expect(guard).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("sess-1", { agentName: "research-assistant", skillRef: "csv-ingest@1", input: { quarter: "Q1" } });
  });

  it("calls the guard with {} when params are not a plain record", async () => {
    const guard = vi.fn(() => null);
    const { deps } = buildDeps([{ allowed: true, checkId: "c1" }], { guard });
    await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report", [1, 2]), toolCtx("fetch_report"));
    expect(guard).toHaveBeenCalledWith("fetch_report", {});
  });

  it("fails closed: a throwing guard blocks and never calls the proxy", async () => {
    const guard = vi.fn(() => {
      throw new Error("regex blew up");
    });
    const { deps, check } = buildDeps([{ allowed: true, checkId: "c1" }], { guard });
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report", { body: "x" }), toolCtx("fetch_report"));
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("guard error: regex blew up");
    expect(check).not.toHaveBeenCalled();
  });
});

describe("makeNodePolicy — SHELL gate", () => {
  it("registers the shell commands as dangerous", () => {
    const policy = makeNodePolicy(buildDeps([]).deps);
    expect(policy.commands).toContain("system.run");
    expect(policy.dangerous).toBe(true);
  });

  it("allows a granted command, invokes the node, and records output", async () => {
    const { deps, check, record } = buildDeps([{ allowed: true, checkId: "n1" }]);
    const { ctx, invokeNode } = nodeCtx("system.run", { ok: true, payload: { stdout: "files" } });
    const result = await makeNodePolicy(deps).handle(ctx);
    expect(check).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, payload: { stdout: "files" } });
    expect(record).toHaveBeenCalledWith("sess-1", { checkId: "n1", output: { stdout: "files" } });
  });

  it("passes a failed node command through as a failure and records nothing", async () => {
    const { deps, record } = buildDeps([{ allowed: true, checkId: "n1" }]);
    const { ctx, invokeNode } = nodeCtx("system.run", { ok: false, message: "command failed", code: "ENOENT" });
    const result = await makeNodePolicy(deps).handle(ctx);
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, message: "command failed", code: "ENOENT" });
    expect(record).not.toHaveBeenCalled();
  });

  it("blocks a denied command and never invokes the node", async () => {
    const { deps, record } = buildDeps([{ allowed: false, code: "skill_not_granted", reason: "no grant" }]);
    const { ctx, invokeNode } = nodeCtx("system.run");
    const result = await makeNodePolicy(deps).handle(ctx);
    expect(result).toMatchObject({ ok: false, code: "skill_not_granted" });
    expect(invokeNode).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("blocks an unmapped command", async () => {
    const { deps } = buildDeps([], { commandSkillMap: {} });
    const { ctx, invokeNode } = nodeCtx("system.run");
    const result = await makeNodePolicy(deps).handle(ctx);
    expect(result).toMatchObject({ ok: false, code: "unmapped_command" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("fails closed when the proxy check rejects during a node command", async () => {
    const { deps, record } = buildDeps([new Error("down")]);
    const { ctx, invokeNode } = nodeCtx("system.run");
    const result = await makeNodePolicy(deps).handle(ctx);
    expect(result).toMatchObject({ ok: false, code: "authz_unavailable" });
    expect(invokeNode).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("adversarial guarantees", () => {
  it("an ungranted-but-mapped skill is blocked", async () => {
    const { deps } = buildDeps([{ allowed: false, code: "skill_not_granted", reason: "role lacks grant" }]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    expect(decision).toMatchObject({ block: true });
  });

  it("a SoD violation is surfaced and fails closed", async () => {
    const { deps } = buildDeps([{ allowed: false, code: "sod_violation", reason: "preparer cannot approve" }]);
    const decision = await makeToolPolicy(deps).evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report"));
    expect((decision as { blockReason: string }).blockReason).toContain("sod_violation");
  });

  it("a replayed completion cannot double-write an outcome", async () => {
    const { deps, record } = buildDeps([
      { allowed: true, checkId: "c1" },
      { allowed: true, checkId: "c2" },
    ]);
    const policy = makeToolPolicy(deps);
    const after = makeAfterToolCall(deps);
    await policy.evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report", "call-1"));
    await policy.evaluate(beforeEvent("fetch_report"), toolCtx("fetch_report", "call-1"));
    await after(afterEvent({ toolCallId: "call-1", result: { x: 1 } }));
    await after(afterEvent({ toolCallId: "call-1", result: { x: 1 } }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("a tool cannot reach RECORD without passing CHECK", async () => {
    const { deps, record } = buildDeps([]);
    await makeAfterToolCall(deps)(afterEvent({ toolCallId: "never-checked", result: {} }));
    expect(record).not.toHaveBeenCalled();
  });
});

describe("createGovernance", () => {
  it("registers all three governance surfaces on the host api", () => {
    const api: OpenClawPluginApi = {
      registerTrustedToolPolicy: vi.fn(),
      registerHook: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    };
    createGovernance(buildDeps([]).deps).register(api);
    expect(api.registerTrustedToolPolicy).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
    expect(api.registerNodeInvokePolicy).toHaveBeenCalledTimes(1);
  });
});

describe("governOpenClaw", () => {
  it("opens a session and returns wired governance", async () => {
    const gov = await governOpenClaw({
      baseUrl: "http://localhost:3000",
      apiKey: "mk_test",
      agentName: "research-assistant",
      externalRef: "owner:alice@corp",
      toolSkillMap: { fetch_report: "csv-ingest@1" },
    });
    expect(gov.deps.sessionId).toBe("opened-session");
    expect(gov.deps.agentName).toBe("research-assistant");
    expect(gov.toolPolicy.id).toBe("openemployee.makerchecker.tool-gate");
  });
});

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
