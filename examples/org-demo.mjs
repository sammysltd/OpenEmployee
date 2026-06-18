// OpenEmployee — the flagship demo.
//
// Hires two governed AI employees with a maker/checker rule, then shows, live
// against a real MakerChecker server:
//   - deny-by-default (an employee can do only its job),
//   - high-risk work that needs a human approval flow,
//   - segregation of duties within one shift,
//   - instant offboarding,
//   - a hash-chained, signed personnel file that verifies.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/org-demo.mjs
import { CheckIdStore, createGovernance } from "@openemployee/connector-openclaw";
import { offboard, onboard } from "@openemployee/employee";
import { bold, dim, green, h, makeClient, makePool, red, yellow } from "./lib.mjs";

const client = makeClient();
const pool = makePool();
const stamp = Date.now();

const preparer = {
  name: `preparer-${stamp}`,
  description: "Prepares the daily cash reconciliation.",
  role: { name: `preparer-role-${stamp}`, description: "Ingests statements and matches transactions." },
  owner: { id: "u-cfo", email: "cfo@corp" },
  skills: [
    { name: `csv-ingest-${stamp}`, version: 1, description: "Ingest a statement CSV", riskTier: "low", tools: ["csv_ingest"] },
    { name: `txn-match-${stamp}`, version: 1, description: "Match transactions", riskTier: "low", tools: ["txn_match"] },
    { name: `post-payment-${stamp}`, version: 1, description: "Post a payment to the ledger", riskTier: "high", tools: ["post_payment"] },
  ],
};

const approver = {
  name: `approver-${stamp}`,
  description: "Approves the reconciliation.",
  role: { name: `approver-role-${stamp}`, description: "Reviews and approves." },
  owner: { id: "u-controller", email: "controller@corp" },
  skills: [{ name: `approve-recon-${stamp}`, version: 1, description: "Approve a reconciliation", riskTier: "low", tools: ["approve_recon"] }],
  separationOfDuties: [`preparer-role-${stamp}`],
};

async function run(gov, tool, params = {}) {
  const ev = { toolName: tool, params, toolCallId: `${tool}-${Date.now()}` };
  const decision = await gov.toolPolicy.evaluate(ev, { toolName: tool, toolCallId: ev.toolCallId });
  if (decision.block) {
    console.log(`   ${red("BLOCK")} ${bold(tool)}  ${dim(decision.blockReason)}`);
  } else {
    console.log(`   ${green("ALLOW")} ${bold(tool)}`);
  }
  return decision;
}

h("1. Onboard two governed employees (deny-by-default + maker/checker SoD)");
const P = await onboard(preparer, { client });
const A = await onboard(approver, { client, sql: pool });
console.log(`   ${green("hired")} ${preparer.name}  ${dim("may: " + Object.keys(P.toolSkillMap).join(", "))}`);
console.log(`   ${green("hired")} ${approver.name}  ${dim("may: " + Object.keys(A.toolSkillMap).join(", ") + "; cannot share a shift with the preparer")}`);

// One governed shift (proxy session) that both employees act within.
const { session } = await client.proxy.openSession({ label: `recon-shift-${stamp}`, externalRef: "owner:cfo@corp" });
const shift = (name, map) => createGovernance({ client, sessionId: session.id, agentName: name, toolSkillMap: map, store: new CheckIdStore() });
const prep = shift(preparer.name, P.toolSkillMap);
const appr = shift(approver.name, A.toolSkillMap);

h("2. The preparer can do its job — and nothing else");
await run(prep, "csv_ingest", { file: "jan.csv" });
await run(prep, "txn_match");
await run(prep, "approve_recon"); // never granted to the preparer
await run(prep, "post_payment", { amount: 1_000_000 }); // high-risk: needs a human

h("3. Segregation of duties: the approver cannot act in a shift the preparer worked");
await run(appr, "approve_recon"); // sod_violation — the preparer's role already acted this shift

h("4. Offboarding is instant: retire the preparer and every permission is gone");
await offboard(preparer, { client });
const next = await client.proxy.openSession({ label: `post-offboard-${stamp}` });
const ghost = createGovernance({ client, sessionId: next.session.id, agentName: preparer.name, toolSkillMap: P.toolSkillMap, store: new CheckIdStore() });
await run(ghost, "csv_ingest"); // agent_not_active

h("5. The tamper-evident personnel file");
const verify = await client.audit.verify();
console.log(`   ${green("audit.verify")} ok=${verify.ok} events=${verify.count} head=${dim((verify.headHash ?? "").slice(0, 16) + "…")}`);
const recorded = await client.proxy.getSession(session.id);
console.log(`   ${yellow("shift record")} ${recorded.actions.map((a) => `${a.skill_ref.replace(`-${stamp}`, "")}:${a.decision}`).join("  ")}`);

await pool.end();
console.log("");
