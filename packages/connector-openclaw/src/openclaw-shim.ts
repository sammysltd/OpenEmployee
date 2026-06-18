/**
 * Structural type shim for the small slice of OpenClaw's plugin API the connector
 * uses. Types-only: at runtime the real `definePluginEntry` is imported from the
 * host `@openclaw/plugin-sdk` peer dependency (see src/plugin.ts).
 *
 * Every shape below is reproduced from vendored OpenClaw source with a file:line
 * citation so it can be re-synced when OpenClaw changes. A typecheck-only assertion against the real types
 * (when the peer dep is present) guards against silent drift.
 */

/** vendor/openclaw/src/plugins/hook-types.ts:615-636 */
export interface PluginHookBeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

/** vendor/openclaw/src/plugins/hook-types.ts:599-613 */
export interface PluginHookToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

/** vendor/openclaw/src/plugins/hook-types.ts:638-646 */
export interface PluginHookAfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  /** Error message string on the real contract (hook-types.ts:644). */
  error?: string;
  durationMs?: number;
  runId?: string;
  toolCallId?: string;
}

/** vendor/openclaw/src/plugins/hook-before-tool-call-result.ts:11-25 */
export interface PluginHookBeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  params?: Record<string, unknown>;
  requireApproval?: unknown;
}

/** vendor/openclaw/src/plugins/host-hooks.ts:78-83 */
export type PluginToolPolicyDecision =
  | PluginHookBeforeToolCallResult
  | { allow?: boolean; reason?: string };

/** vendor/openclaw/src/plugins/host-hooks.ts:85-92 */
export interface PluginTrustedToolPolicyRegistration {
  id: string;
  description: string;
  evaluate: (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext,
  ) => PluginToolPolicyDecision | void | Promise<PluginToolPolicyDecision | void>;
}

/**
 * The tagged transport result `ctx.invokeNode()` resolves to — already a valid
 * node-invoke policy result, so a policy that owns the invocation passes it
 * through. vendor/openclaw/src/plugins/types.ts (OpenClawPluginNodeInvokeTransportResult).
 */
export type OpenClawPluginNodeInvokeTransportResult =
  | { ok: true; payload?: unknown; payloadJSON?: string | null }
  | { ok: false; message: string; code?: string; details?: Record<string, unknown> };

/** vendor/openclaw/src/plugins/types.ts:2240-2262 */
export interface OpenClawPluginNodeInvokePolicyContext {
  nodeId?: string;
  command: string;
  params: unknown;
  approvals?: unknown;
  invokeNode: (input?: unknown) => Promise<OpenClawPluginNodeInvokeTransportResult>;
}

/** vendor/openclaw/src/plugins/types.ts:2264-2278 */
export type OpenClawPluginNodeInvokePolicyResult =
  | { ok: true; payload?: unknown; payloadJSON?: string | null }
  | {
      ok: false;
      message: string;
      code?: string;
      details?: Record<string, unknown>;
      unavailable?: boolean;
    };

/** vendor/openclaw/src/plugins/types.ts:2284-2300 */
export interface OpenClawPluginNodeInvokePolicy {
  commands: string[];
  dangerous?: boolean;
  handle: (
    ctx: OpenClawPluginNodeInvokePolicyContext,
  ) => OpenClawPluginNodeInvokePolicyResult | Promise<OpenClawPluginNodeInvokePolicyResult>;
}

/** Handler registered via api.registerHook("after_tool_call", …). types.ts:2644-2648 */
export type AfterToolCallHandler = (
  event: PluginHookAfterToolCallEvent,
  ctx?: PluginHookToolContext,
) => void | Promise<void>;

/** The slice of OpenClawPluginApi the connector uses. types.ts:2644,2695,2789 */
export interface OpenClawPluginApi {
  registerTrustedToolPolicy: (policy: PluginTrustedToolPolicyRegistration) => void;
  registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => void;
  registerHook: (event: string, handler: AfterToolCallHandler, opts?: unknown) => void;
}

/** definePluginEntry options. vendor/openclaw/src/plugin-sdk/plugin-entry.ts:218-234 */
export interface PluginEntryOptions {
  id: string;
  name?: string;
  description?: string;
  configSchema?: unknown;
  register: (api: OpenClawPluginApi) => void;
}

/** Opaque return of definePluginEntry (host-specific). plugin-entry.ts:255 */
export type DefinedPluginEntry = unknown;
