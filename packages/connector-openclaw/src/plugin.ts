/**
 * OpenClaw host entry. OpenClaw discovers this module (via plugins.load.paths +
 * openclaw.plugin.json) and calls the entry's `register` with its plugin api.
 *
 * Unlike the library surface (src/governance.ts), this file imports the REAL
 * `definePluginEntry` from the host `@openclaw/plugin-sdk` peer dependency, so it
 * is loaded only inside OpenClaw — never by the unit tests (which is why the entry
 * is a separate file). Configuration is read from the environment:
 *
 *   MAKERCHECKER_BASE_URL              the MakerChecker server
 *   MAKERCHECKER_API_KEY               bearer key (optional if auth is disabled)
 *   OPENEMPLOYEE_AGENT_NAME            the registered MakerChecker agent
 *   OPENEMPLOYEE_TOOL_SKILL_MAP        JSON: { "<tool>": "<name@version>", ... }
 *   OPENEMPLOYEE_COMMAND_SKILL_MAP     JSON (optional): { "system.run": "<name@version>" }
 *   OPENEMPLOYEE_OWNER                 optional externalRef, e.g. "owner:alice@corp"
 */
import { definePluginEntry as rawDefinePluginEntry } from "@openclaw/plugin-sdk/plugin-entry";

import { governOpenClaw, type Governance, type OpenClawGovernanceConfig } from "./governance.js";
import type { PluginEntryOptions } from "./openclaw-shim.js";

// The host provides the real definePluginEntry; type it against the shim so the
// entry object (and its policy callbacks) are fully checked.
const definePluginEntry = rawDefinePluginEntry as (options: PluginEntryOptions) => unknown;

function configFromEnv(): OpenClawGovernanceConfig {
  const baseUrl = process.env.MAKERCHECKER_BASE_URL;
  const agentName = process.env.OPENEMPLOYEE_AGENT_NAME;
  const toolMapRaw = process.env.OPENEMPLOYEE_TOOL_SKILL_MAP;
  if (!baseUrl || !agentName || !toolMapRaw) {
    throw new Error(
      "OpenEmployee plugin requires MAKERCHECKER_BASE_URL, OPENEMPLOYEE_AGENT_NAME, and OPENEMPLOYEE_TOOL_SKILL_MAP",
    );
  }
  return {
    baseUrl,
    agentName,
    ...(process.env.MAKERCHECKER_API_KEY ? { apiKey: process.env.MAKERCHECKER_API_KEY } : {}),
    toolSkillMap: JSON.parse(toolMapRaw) as Record<string, string>,
    ...(process.env.OPENEMPLOYEE_COMMAND_SKILL_MAP
      ? { commandSkillMap: JSON.parse(process.env.OPENEMPLOYEE_COMMAND_SKILL_MAP) as Record<string, string> }
      : {}),
    ...(process.env.OPENEMPLOYEE_OWNER ? { externalRef: process.env.OPENEMPLOYEE_OWNER } : {}),
  };
}

const DEFAULT_SHELL_COMMANDS = ["system.run", "system.run.prepare"];

// OpenClaw only routes a node command to this policy if it is in `commands`
// (matched exactly), and `commands` must be known at register time (synchronous).
// Derive it from the env command map so a custom command name is still gated.
function nodeCommandsFromEnv(): string[] {
  const raw = process.env.OPENEMPLOYEE_COMMAND_SKILL_MAP;
  if (!raw) return DEFAULT_SHELL_COMMANDS;
  try {
    const keys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    return keys.length > 0 ? keys : DEFAULT_SHELL_COMMANDS;
  } catch {
    return DEFAULT_SHELL_COMMANDS;
  }
}

type Loaded = { ok: true; gov: Governance } | { ok: false; reason: string };

// Open the session lazily (register is synchronous, governOpenClaw is async).
// A misconfiguration fails closed: every gated call is blocked, not allowed.
const loaded: Promise<Loaded> = (async () => {
  try {
    return { ok: true, gov: await governOpenClaw(configFromEnv()) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
})();

export default definePluginEntry({
  id: "openemployee.makerchecker",
  name: "OpenEmployee MakerChecker Governance",
  description: "Deny-by-default governance and a signed audit trail for OpenClaw tools and shell.",
  register(api) {
    api.registerTrustedToolPolicy({
      id: "openemployee.makerchecker.tool-gate",
      description: "Deny-by-default MakerChecker authorization for OpenClaw tools.",
      evaluate: async (event, ctx) => {
        const l = await loaded;
        if (!l.ok) return { block: true, blockReason: `openemployee: plugin misconfigured (${l.reason})` };
        return l.gov.toolPolicy.evaluate(event, ctx);
      },
    });
    api.registerHook("after_tool_call", async (event, ctx) => {
      const l = await loaded;
      if (l.ok) await l.gov.afterToolCall(event, ctx);
    });
    api.registerNodeInvokePolicy({
      commands: nodeCommandsFromEnv(),
      dangerous: true,
      handle: async (nodeCtx) => {
        const l = await loaded;
        if (!l.ok) return { ok: false, code: "misconfigured", message: `openemployee: plugin misconfigured (${l.reason})` };
        return l.gov.nodePolicy.handle(nodeCtx);
      },
    });
  },
});
