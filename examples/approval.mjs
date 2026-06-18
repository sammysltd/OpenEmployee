// The maker/checker payoff: high-risk work routes to a human.
//
// A governed flow runs the agent's prep, then PAUSES at an approval gate. The
// requester cannot clear its own gate — a second identity signs off — and the
// run only continues after approval. The request, the approval, and who signed
// are all in the audit chain.
//
//   MAKERCHECKER_API_KEY=mk_admin... MAKERCHECKER_OFFICER_KEY=mk_officer... \
//     node examples/approval.mjs
import { createClient } from "@makerchecker/sdk";
import { bold, dim, green, h, makeClient, red, yellow } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = makeClient();
const baseUrl = process.env.MAKERCHECKER_BASE_URL ?? "http://localhost:3000";
const officerKey = process.env.MAKERCHECKER_OFFICER_KEY;
if (!officerKey) {
  throw new Error("set MAKERCHECKER_OFFICER_KEY (the demo officer key the server prints at boot)");
}
const officer = createClient({ baseUrl, apiKey: officerKey });

h("High-risk work routes to a human — the maker/checker round-trip");

const flow = "aml-alert-triage";
console.log(`   ${dim("trigger")} ${bold(flow)}  ${dim("(the agent triages the alert, then a gate stops it)")}`);
const { runId } = await admin.flows.trigger(flow);

let pending;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const { approvals } = await admin.approvals.list();
  pending = approvals.find((a) => a.run_id === runId);
  if (pending) {
    console.log(`   ${yellow("PAUSED")}  the agent finished its analysis; a human must sign off before it proceeds`);
    break;
  }
  const { run } = await admin.runs.get(runId);
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    console.log(red(`   run ${run.status} before reaching the gate`));
    process.exit(0);
  }
}
if (!pending) {
  console.log(red("   no approval gate reached in time"));
  process.exit(1);
}

console.log(`   ${dim("the requester is forbidden from clearing its own gate (maker is not checker)")}`);
await officer.approvals.decide(pending.id, "approved", "Reviewed the alert; cleared to proceed.");
console.log(`   ${green("APPROVED")} by a compliance officer — a different identity`);

for (let i = 0; i < 60; i++) {
  await sleep(500);
  const { run } = await admin.runs.get(runId);
  if (run.status === "completed") {
    console.log(`   ${green("COMPLETED")}  the workflow proceeded only after sign-off`);
    break;
  }
  if (["failed", "cancelled"].includes(run.status)) {
    console.log(red(`   run ${run.status}`));
    break;
  }
}

const verify = await admin.audit.verify();
console.log(
  `   ${dim("audit")} chain ${verify.ok ? green("VERIFIED") : red("TAMPERED")} (${verify.count} events) — the request, the approval, and who signed are all recorded\n`,
);
