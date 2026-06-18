// OpenEmployee — Red Team.
//
// Tries to break every guarantee against a live server and prints a scoreboard.
// Exits non-zero if any attack is NOT blocked, so it doubles as a check.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/red-team.mjs
import { CheckIdStore, createGovernance } from "@openemployee/connector-openclaw";
import { offboard, onboard } from "@openemployee/employee";
import { bold, dim, green, makeClient, makePool, red } from "./lib.mjs";

const client = makeClient();
const pool = makePool();
const stamp = Date.now();

const rogue = {
  name: `rogue-${stamp}`,
  description: "An agent that tries everything.",
  role: { name: `rogue-role-${stamp}`, description: "Reads." },
  owner: { id: "u-x", email: "x@corp" },
  skills: [
    { name: `read-${stamp}`, version: 1, description: "Read", riskTier: "low", tools: ["safe_read"] },
    { name: `wipe-${stamp}`, version: 1, description: "Wipe everything", riskTier: "high", tools: ["wipe_all"] },
  ],
};
const other = {
  name: `other-${stamp}`,
  description: "A second agent.",
  role: { name: `other-role-${stamp}`, description: "Signs off." },
  owner: { id: "u-y", email: "y@corp" },
  skills: [{ name: `sign-${stamp}`, version: 1, description: "Sign off", riskTier: "low", tools: ["sign_off"] }],
  separationOfDuties: [`rogue-role-${stamp}`],
};

const Rg = await onboard(rogue, { client });
const Ot = await onboard(other, { client, sql: pool });
const { session } = await client.proxy.openSession({ label: `red-team-${stamp}`, externalRef: "owner:x@corp" });
const gov = (name, map) => createGovernance({ client, sessionId: session.id, agentName: name, toolSkillMap: map, store: new CheckIdStore() });
const rogueGov = gov(rogue.name, Rg.toolSkillMap);
const otherGov = gov(other.name, Ot.toolSkillMap);

const evalTool = (g, tool, params = {}) =>
  g.toolPolicy.evaluate({ toolName: tool, params, toolCallId: `${tool}-${Math.random()}` }, { toolName: tool, toolCallId: "x" });

const results = [];
async function attack(label, fn, expect) {
  const decision = await fn();
  const blocked = Boolean(decision.block);
  const ok = blocked && (!expect || String(decision.blockReason).includes(expect));
  results.push({ label, ok, detail: blocked ? String(decision.blockReason).replace(/^openemployee[^:]*:?\s*/, "").slice(0, 52) : "RAN — NOT BLOCKED" });
}

// Establish the rogue role acting in this session (so the SoD attack has a conflict).
await evalTool(rogueGov, "safe_read");

await attack("ungranted tool (deny by default)", () => evalTool(rogueGov, "exfiltrate"), "deny by default");
await attack("ungranted skill (proxy grant check)", () =>
  gov(rogue.name, { sign_off: Ot.toolSkillMap["sign_off"] }).toolPolicy.evaluate(
    { toolName: "sign_off", params: {}, toolCallId: "x" },
    { toolName: "sign_off", toolCallId: "x" },
  ), "skill_not_granted");
await attack("high-risk without approval", () => evalTool(rogueGov, "wipe_all"), "high_risk_requires_gate");
await attack("segregation of duties", () => evalTool(otherGov, "sign_off"), "sod_violation");
await attack("prototype-key bypass (__proto__)", () => evalTool(rogueGov, "__proto__"), "deny by default");

await offboard(rogue, { client });
const after = await client.proxy.openSession({ label: `red-team-off-${stamp}` });
const ghost = gov2(after.session.id, rogue.name, Rg.toolSkillMap);
await attack("retired agent", () => evalTool(ghost, "safe_read"), "agent_not_active");

console.log("\n  " + bold("OpenEmployee — Red Team"));
console.log("  " + dim("─".repeat(64)));
console.log("  " + dim("Trying to break each guarantee:") + "\n");
for (const r of results) {
  const tag = r.ok ? green("[BLOCKED]") : red("[ FAILED]");
  console.log(`  ${tag} ${r.label.padEnd(36)} ${dim(r.detail)}`);
}
const pass = results.filter((r) => r.ok).length;
const verify = await client.audit.verify();
console.log(
  "\n  " + bold(`${pass}/${results.length} attacks blocked.`) + `  audit chain ${verify.ok ? green("VERIFIED") : red("TAMPERED")}.`,
);
console.log("  " + dim("─".repeat(64)) + "\n");

await pool.end();
process.exit(pass === results.length && verify.ok ? 0 : 1);

function gov2(sessionId, name, map) {
  return createGovernance({ client, sessionId, agentName: name, toolSkillMap: map, store: new CheckIdStore() });
}
