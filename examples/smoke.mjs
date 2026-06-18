// End-to-end smoke: onboard a governed employee against a live MakerChecker
// server, then drive the connector's CHECK gate for a granted, a high-risk, and
// an unmapped tool, record an outcome, and verify the audit chain.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/smoke.mjs
import { createClient } from "../vendor/makerchecker/packages/sdk/dist/index.js";
import { governOpenClaw } from "../packages/connector-openclaw/dist/index.js";
import { onboard } from "../packages/employee/dist/index.js";

const baseUrl = process.env.MAKERCHECKER_BASE_URL ?? "http://localhost:3000";
const apiKey = process.env.MAKERCHECKER_API_KEY;
if (!apiKey) throw new Error("set MAKERCHECKER_API_KEY (the demo admin key printed by the server)");

const stamp = Date.now();
const client = createClient({ baseUrl, apiKey });

const employee = {
  name: `smoke-researcher-${stamp}`,
  description: "Smoke-test research employee",
  role: { name: `smoke-researcher-role-${stamp}`, description: "Reads public sources." },
  owner: { id: "u-smoke", email: "smoke@corp" },
  skills: [
    { name: `smoke-web-fetch-${stamp}`, version: 1, description: "Fetch a URL", riskTier: "low", tools: ["web_fetch"] },
    { name: `smoke-deploy-${stamp}`, version: 1, description: "Deploy to prod", riskTier: "high", tools: ["deploy_prod"] },
  ],
};

const onboarded = await onboard(employee, { client });
console.log("onboarded agent:", onboarded.agentId);
console.log("tool map:", onboarded.toolSkillMap);

const gov = await governOpenClaw({
  baseUrl,
  apiKey,
  agentName: employee.name,
  externalRef: `owner:${employee.owner.email}`,
  toolSkillMap: onboarded.toolSkillMap,
});

async function tryTool(toolName, params = {}) {
  const ev = { toolName, params, toolCallId: `${toolName}-1` };
  const decision = await gov.toolPolicy.evaluate(ev, { toolName, toolCallId: ev.toolCallId });
  console.log(`  ${toolName.padEnd(12)} -> ${decision.block ? "BLOCKED: " + decision.blockReason : "ALLOWED"}`);
  return decision;
}

console.log("\nGovernance decisions:");
await tryTool("web_fetch", { url: "https://example.com" });
await tryTool("deploy_prod", { env: "prod" });
await tryTool("rm_rf", {});

await gov.afterToolCall({ toolName: "web_fetch", params: {}, result: { rows: 2 }, toolCallId: "web_fetch-1" });

const verify = await client.audit.verify();
console.log("\naudit.verify:", verify);
const session = await client.proxy.getSession(gov.deps.sessionId);
console.log("session actions:", session.actions.map((a) => `${a.skill_ref}:${a.decision}`));
