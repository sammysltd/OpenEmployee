// OpenEmployee — Governance Control Room.
//
// A live terminal dashboard: the org, a streaming feed of every tool call being
// checked before it runs (ALLOW / BLOCK), and the tamper-evident audit chain
// verifying. Self-contained — onboards a fresh org and drives it.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/control-room.mjs
import { CheckIdStore, createGovernance } from "@openemployee/connector-openclaw";
import { onboard } from "@openemployee/employee";
import { bold, dim, green, makeClient, makePool, red } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toTimeString().slice(0, 8);
const RULE = "─".repeat(70);
const live = process.stdout.isTTY;

const client = makeClient();
const pool = makePool();
const stamp = Date.now();

const researcher = {
  name: `research-assistant-${stamp}`,
  description: "Reads public sources, drafts summaries.",
  role: { name: `researcher-${stamp}`, description: "Reads and drafts." },
  owner: { id: "u-lead", email: "lead@corp" },
  skills: [
    { name: `web-fetch-${stamp}`, version: 1, description: "Fetch a URL", riskTier: "low", tools: ["web_fetch"] },
    { name: `summarize-${stamp}`, version: 1, description: "Summarize text", riskTier: "low", tools: ["summarize"] },
    { name: `purge-${stamp}`, version: 1, description: "Purge a dataset", riskTier: "high", tools: ["purge_data"] },
  ],
};
const ops = {
  name: `ops-engineer-${stamp}`,
  description: "Operates infrastructure.",
  role: { name: `ops-${stamp}`, description: "Runs ops tasks." },
  owner: { id: "u-sre", email: "sre@corp" },
  skills: [{ name: `read-logs-${stamp}`, version: 1, description: "Read logs", riskTier: "low", tools: ["read_logs"] }],
  separationOfDuties: [`researcher-${stamp}`],
};

const R = await onboard(researcher, { client });
const O = await onboard(ops, { client, sql: pool });
const { session } = await client.proxy.openSession({ label: `control-room-${stamp}`, externalRef: "owner:lead@corp" });
const gov = (name, map) => createGovernance({ client, sessionId: session.id, agentName: name, toolSkillMap: map, store: new CheckIdStore() });
const researcherGov = gov(researcher.name, R.toolSkillMap);
const opsGov = gov(ops.name, O.toolSkillMap);

if (live) console.clear();
console.log("");
console.log(bold("  OpenEmployee — Governance Control Room"));
console.log(dim(`  ${RULE}`));
console.log(bold("\n  ORG"));
console.log(`    ${"research-assistant".padEnd(20)} ${dim("role")} researcher  ${green("active")}  ${dim(`${Object.keys(R.toolSkillMap).length} skills`)}`);
console.log(`    ${"ops-engineer".padEnd(20)} ${dim("role")} ops         ${green("active")}  ${dim(`${Object.keys(O.toolSkillMap).length} skill   not allowed to share a shift with research-assistant`)}`);
console.log(bold("\n  LIVE") + dim("   every tool call is authorized before it runs"));

const feed = [
  [researcherGov, "research-assistant", "web_fetch", { url: "https://example.com" }],
  [researcherGov, "research-assistant", "summarize", {}],
  [researcherGov, "research-assistant", "post_slack", { channel: "#general" }],
  [researcherGov, "research-assistant", "purge_data", { dataset: "prod" }],
  [opsGov, "ops-engineer", "read_logs", {}],
];

for (const [g, who, tool, params] of feed) {
  const ev = { toolName: tool, params, toolCallId: `${tool}-${Date.now()}` };
  const decision = await g.toolPolicy.evaluate(ev, { toolName: tool, toolCallId: ev.toolCallId });
  const verdict = decision.block ? red("BLOCK") : green("ALLOW");
  const reason = decision.block ? "  " + dim(shortReason(decision.blockReason)) : "";
  console.log(`    ${dim(clock())}  ${who.padEnd(20)} ${bold(tool.padEnd(13))} ${verdict}${reason}`);
  await sleep(live ? 480 : 0);
}

console.log(bold("\n  AUDIT"));
const verify = await client.audit.verify();
const status = verify.ok ? green("VERIFIED") : red("TAMPERED");
console.log(`    chain ${status}   ${verify.count} events   head ${dim((verify.headHash ?? "").slice(0, 12) + "…")}   ${dim("hash-chained, signed")}`);
console.log(dim(`  ${RULE}\n`));

await pool.end();

function shortReason(reason) {
  if (/high_risk/.test(reason)) return "high-risk — needs human approval";
  if (/sod_violation/.test(reason)) return "segregation of duties — research-assistant already worked this shift";
  if (/not granted/.test(reason)) return "not granted (deny by default)";
  return reason;
}
