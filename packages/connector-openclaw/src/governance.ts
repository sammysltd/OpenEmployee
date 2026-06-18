import { createClient, type Client, type ProxyCheckResult } from "@makerchecker/sdk";

import { CheckIdStore } from "./store.js";
import type {
  AfterToolCallHandler,
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  PluginTrustedToolPolicyRegistration,
} from "./openclaw-shim.js";

/** The slice of the MakerChecker SDK client the connector calls. */
export type GovernanceClient = Pick<Client, "proxy">;

/**
 * Redacts a tool/command OUTPUT before it is recorded into the audit chain
 * (client-side defense-in-depth; the server also redacts the audit payload at
 * write time). It is NEVER applied to the params sent to `proxy.check`, because
 * the server evaluates those as real enforcement input (amount/allowlist/path
 * limits) — redacting them would corrupt enforcement.
 */
export type RedactFn = (value: unknown) => unknown;

/**
 * A deterministic payload (DLP) guard. Inspects a mapped tool's params — what the
 * call actually DOES, not just which verb — and returns a `{reason}` to block, or
 * `null` to pass. Runs after deny-by-default and before `proxy.check`. No LLM, so
 * it cannot be prompt-talked out of a block; a throwing guard fails closed (blocks).
 */
export type ContentGuard = (
  toolName: string,
  params: Record<string, unknown>,
) => { reason: string } | null;

export interface GovernanceDeps {
  client: GovernanceClient;
  /** An open proxy session (from client.proxy.openSession). */
  sessionId: string;
  /** The registered MakerChecker agent whose role grants are evaluated. */
  agentName: string;
  /** OpenClaw tool name -> MakerChecker skillRef ("name@version"). Deny by default. */
  toolSkillMap: Readonly<Record<string, string>>;
  /** OpenClaw node command (e.g. "system.run") -> skillRef. Governs shell/node. */
  commandSkillMap?: Readonly<Record<string, string>>;
  /** Applied to recorded OUTPUTS only (never to enforcement input). */
  redact?: RedactFn;
  /** Deterministic payload guard run on a mapped tool's params before proxy.check. */
  guard?: ContentGuard;
  store: CheckIdStore;
}

export const TOOL_POLICY_ID = "openemployee.makerchecker.tool-gate";
export const NODE_POLICY_ID = "openemployee.makerchecker.shell-gate";
const DEFAULT_SHELL_COMMANDS = ["system.run", "system.run.prepare"];

const identity: RedactFn = (value) => value;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-property membership — guards against Object.prototype keys (`__proto__`, `constructor`). */
function mapped(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unreachable(err: unknown): ProxyCheckResult {
  return { allowed: false, code: "authz_unavailable", reason: `authorization service unreachable: ${errorMessage(err)}` };
}

/**
 * The pre-execution CHECK gate. Returns `{block:true}` — which stops the tool
 * before it runs — on any deny, on an unmapped tool, or on a transport error
 * (fail closed). The RAW params are sent as enforcement input; on allow the
 * checkId is stashed for the RECORD step. Mirrors the fail-closed contract of
 * vendor/makerchecker/packages/connector-claude-agent/src/index.ts:105-108.
 */
export function makeToolPolicy(deps: GovernanceDeps): PluginTrustedToolPolicyRegistration {
  return {
    id: TOOL_POLICY_ID,
    description: "Deny-by-default MakerChecker authorization for OpenClaw tools.",
    evaluate: async (event, ctx) => {
      const skillRef = mapped(deps.toolSkillMap, event.toolName);
      if (skillRef === undefined) {
        return { block: true, blockReason: `openemployee: tool "${event.toolName}" is not granted (deny by default)` };
      }
      const params = isRecord(event.params) ? event.params : {};
      if (deps.guard !== undefined) {
        let g: { reason: string } | null;
        try {
          g = deps.guard(event.toolName, params);
        } catch (err) {
          // fail-safe: a throwing guard blocks (it cannot vouch for the payload).
          return { block: true, blockReason: `openemployee DLP: guard error: ${errorMessage(err)}` };
        }
        if (g !== null) {
          return { block: true, blockReason: `openemployee DLP: ${g.reason}` };
        }
      }
      const input = isRecord(event.params) ? event.params : undefined;
      const check = await deps.client.proxy
        .check(deps.sessionId, { agentName: deps.agentName, skillRef, ...(input ? { input } : {}) })
        .catch(unreachable);
      if (!check.allowed) {
        return { block: true, blockReason: `openemployee denied: ${check.code}: ${check.reason}` };
      }
      deps.store.stash(ctx.toolCallId, check.checkId);
      return {};
    },
  };
}

/**
 * The RECORD step: a separate `after_tool_call` hook, because the pre-call event
 * cannot see results (hook-types.ts:615-636). Pops the checkId stashed at CHECK
 * time and records the tool's output (redacted client-side) or error. A blocked
 * or unmapped call has no stashed checkId, so nothing is recorded (the proxy
 * already recorded its decision server-side). Best-effort: a failed record (or a
 * throwing redactor) never disrupts the tool result flow.
 */
export function makeAfterToolCall(deps: GovernanceDeps): AfterToolCallHandler {
  const redact = deps.redact ?? identity;
  return async (event) => {
    const checkId = deps.store.take(event.toolCallId);
    if (checkId === undefined) {
      return;
    }
    try {
      if (event.error !== undefined) {
        await deps.client.proxy.record(deps.sessionId, { checkId, error: { message: errorMessage(event.error) } });
      } else {
        await deps.client.proxy.record(deps.sessionId, { checkId, output: redact(event.result) });
      }
    } catch {
      /* record is best-effort */
    }
  };
}

/**
 * The SHELL/NODE gate. Remote shell arrives as a node.invoke with
 * command:"system.run" (bash-tools.exec-host-node-phases.ts:357), which tool
 * policies never see. The policy owns the invocation: check -> invokeNode ->
 * record. `ctx.invokeNode()` already returns a tagged transport result, so it is
 * passed through unchanged (a failed command stays a failure); only the inner
 * payload of a success is recorded. Matching is exact (no wildcards); every gated
 * command is enumerated and `dangerous:true` blocks any registered-but-unmatched
 * command (node-invoke-plugin-policy.ts:131-142).
 */
export function makeNodePolicy(deps: GovernanceDeps): OpenClawPluginNodeInvokePolicy {
  const redact = deps.redact ?? identity;
  const commandSkillMap = deps.commandSkillMap ?? {};
  const keys = Object.keys(commandSkillMap);
  const commands = keys.length > 0 ? keys : DEFAULT_SHELL_COMMANDS;
  return {
    commands,
    dangerous: true,
    handle: async (ctx) => {
      const skillRef = mapped(commandSkillMap, ctx.command);
      if (skillRef === undefined) {
        return { ok: false, code: "unmapped_command", message: `openemployee: command "${ctx.command}" is not granted (deny by default)` };
      }
      const check = await deps.client.proxy
        .check(deps.sessionId, { agentName: deps.agentName, skillRef, input: { command: ctx.command, params: ctx.params } })
        .catch(unreachable);
      if (!check.allowed) {
        return { ok: false, code: check.code, message: check.reason };
      }
      const result = await ctx.invokeNode();
      if (result.ok) {
        try {
          await deps.client.proxy.record(deps.sessionId, { checkId: check.checkId, output: redact(result.payload) });
        } catch {
          /* record is best-effort */
        }
      }
      return result;
    },
  };
}

export interface Governance {
  deps: GovernanceDeps;
  toolPolicy: PluginTrustedToolPolicyRegistration;
  afterToolCall: AfterToolCallHandler;
  nodePolicy: OpenClawPluginNodeInvokePolicy;
  /** Registers all three governance surfaces on the OpenClaw plugin api. */
  register: (api: OpenClawPluginApi) => void;
}

export function createGovernance(deps: GovernanceDeps): Governance {
  const toolPolicy = makeToolPolicy(deps);
  const afterToolCall = makeAfterToolCall(deps);
  const nodePolicy = makeNodePolicy(deps);
  return {
    deps,
    toolPolicy,
    afterToolCall,
    nodePolicy,
    register: (api) => {
      api.registerTrustedToolPolicy(toolPolicy);
      api.registerHook("after_tool_call", afterToolCall);
      api.registerNodeInvokePolicy(nodePolicy);
    },
  };
}

export interface OpenClawGovernanceConfig {
  /** MakerChecker server base URL, e.g. "http://localhost:3000". */
  baseUrl: string;
  /** MakerChecker API key (Bearer). */
  apiKey?: string;
  /** The registered MakerChecker agent this employee maps to. */
  agentName: string;
  /** Proxy session label (audit context). */
  sessionLabel?: string;
  /** Accountable owner reference carried into the audit chain, e.g. "owner:alice@corp". */
  externalRef?: string;
  toolSkillMap: Record<string, string>;
  commandSkillMap?: Record<string, string>;
  redact?: RedactFn;
  /** Deterministic payload guard applied to mapped tools' params (DLP). */
  guard?: ContentGuard;
}

/**
 * Open a governed session and build the connector against a live MakerChecker
 * server. Used by the demos and the e2e harness; the OpenClaw-loaded plugin
 * entry (src/plugin.ts) does the equivalent from host plugin config.
 */
export async function governOpenClaw(config: OpenClawGovernanceConfig): Promise<Governance> {
  const client = createClient({
    baseUrl: config.baseUrl,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  });
  const { session } = await client.proxy.openSession({
    label: config.sessionLabel ?? "openemployee",
    ...(config.externalRef !== undefined ? { externalRef: config.externalRef } : {}),
  });
  return createGovernance({
    client,
    sessionId: session.id,
    agentName: config.agentName,
    toolSkillMap: config.toolSkillMap,
    commandSkillMap: config.commandSkillMap,
    redact: config.redact,
    guard: config.guard,
    store: new CheckIdStore(),
  });
}
