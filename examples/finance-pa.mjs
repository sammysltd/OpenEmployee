// OpenEmployee — the finance PA you can actually trust.
//
// A REAL Claude agent pays this month's bills against a REAL ledger. You give it
// a $1000/month budget (a MakerChecker windowed quota). It pays the small bills
// autonomously, gets blocked on the one that would blow the budget, and escalates
// to you. You raise the cap; it finishes. Every cent is in a signed audit log.
//
//   node --env-file=.env examples/finance-pa.mjs
// Needs ANTHROPIC_API_KEY (in .env) and a quota-capable MakerChecker server
// (MAKERCHECKER_BASE_URL + MAKERCHECKER_API_KEY). Without ANTHROPIC_API_KEY it
// runs a scripted PA that still really pays/really gets blocked.
import pg from "pg";

import { CheckIdStore, createGovernance } from "@openemployee/connector-openclaw";
import { onboard } from "@openemployee/employee";
import { bold, dim, green, h, makeClient, red, yellow } from "./lib.mjs";

const MODEL = process.env.OPENEMPLOYEE_MODEL ?? "claude-sonnet-4-6";
const BUDGET = 1000;
const stamp = Date.now();

// --- a real ledger (the PA's checking account) ---
const adminDbUrl =
  process.env.MAKERCHECKER_DATABASE_URL ?? "postgres://makerchecker:makerchecker@localhost:5432/makerchecker";
const root = new pg.Client({ connectionString: adminDbUrl.replace(/\/[^/]*$/, "/postgres") });
await root.connect();
await root.query("CREATE DATABASE openemployee_bank").catch(() => {});
await root.end();
const bank = new pg.Pool({ connectionString: adminDbUrl.replace(/\/[^/]*$/, "/openemployee_bank") });
await bank.query("DROP TABLE IF EXISTS ledger");
await bank.query("CREATE TABLE ledger (id serial primary key, payee text, amount numeric, paid_at timestamptz default now())");
const balance = async () => Number((await bank.query("SELECT coalesce(sum(amount),0)::float8 AS s FROM ledger")).rows[0].s);

const bills = [
  { kind: "Rent", payee: "Oakwood Apartments", amount: 700 },
  { kind: "Internet", payee: "Comcast", amount: 90 },
  { kind: "Phone", payee: "Verizon", amount: 60 },
  { kind: "Taxes", payee: "IRS", amount: 1500 },
  { kind: "Gym", payee: "Anytime Fitness", amount: 40 },
  { kind: "Streaming", payee: "Netflix", amount: 50 },
];

// --- hire the finance PA: a pay-bill skill capped at $1000/month ---
const client = makeClient();
const pa = {
  name: `finance-pa-${stamp}`,
  description: "Pays the household bills each month.",
  role: {
    name: `finance-pa-role-${stamp}`,
    description: "Pays bills within a monthly budget.",
    limits: {
      skills: {
        [`pay-bill-${stamp}@1`]: { quotas: [{ key: "monthly-budget", field: "amount", window: "month", max: BUDGET }] },
      },
    },
  },
  owner: { id: "u-you", email: "you@home" },
  skills: [
    { name: `pay-bill-${stamp}`, version: 1, description: "Pay one bill", riskTier: "low", tools: ["pay_bill"] },
    { name: `list-bills-${stamp}`, version: 1, description: "List the month's bills", riskTier: "low", tools: ["list_bills"] },
  ],
};
const onboarded = await onboard(pa, { client });
const { session } = await client.proxy.openSession({ label: `finance-${stamp}`, externalRef: "owner:you@home" });
const gov = createGovernance({ client, sessionId: session.id, agentName: pa.name, toolSkillMap: onboarded.toolSkillMap, store: new CheckIdStore() });

// --- the tools (REAL: pay_bill debits the ledger when governance allows) ---
async function payBill({ payee, amount }) {
  const ev = { toolName: "pay_bill", params: { payee, amount }, toolCallId: `pay-${payee}-${Math.random()}` };
  const decision = await gov.toolPolicy.evaluate(ev, { toolName: "pay_bill", toolCallId: ev.toolCallId });
  if (decision.block) {
    const overBudget = /limit_quota/.test(decision.blockReason);
    console.log(`   ${red("BLOCK")} ${bold(`$${amount}`)} to ${payee}  ${dim(overBudget ? `would exceed your $${BUDGET}/mo budget` : decision.blockReason)}`);
    return { paid: false, reason: decision.blockReason };
  }
  await bank.query("INSERT INTO ledger (payee, amount) VALUES ($1, $2)", [payee, amount]);
  console.log(`   ${green("PAID ")} ${bold(`$${amount}`)} to ${payee}   ${dim(`balance spent: $${await balance()}`)}`);
  return { paid: true };
}

async function callTool(name, input) {
  if (name === "list_bills") return { bills };
  if (name === "pay_bill") return payBill(input);
  return { error: `unknown tool ${name}` };
}

const anthropicTools = [
  { name: "list_bills", description: "List this month's bills to pay.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "pay_bill", description: "Pay one bill.", input_schema: { type: "object", properties: { payee: { type: "string" }, amount: { type: "number" } }, required: ["payee", "amount"] } },
];

async function runClaude() {
  const messages = [{
    role: "user",
    content: `You are my finance assistant. Pay all of this month's bills (use list_bills, then pay_bill for each). If a payment is blocked, note which one and why, and continue with the rest. End with a SINGLE short sentence — no tables, no lists.`,
  }];
  for (let turn = 0; turn < 12; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, tools: anthropicTools, messages }),
    });
    const data = await res.json();
    if (data.type === "error") throw new Error(JSON.stringify(data.error));
    messages.push({ role: "assistant", content: data.content });
    const toolUses = data.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (text) console.log(`\n   ${dim("PA:")} ${text}`);
      return;
    }
    const results = [];
    for (const tu of toolUses) results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(await callTool(tu.name, tu.input)) });
    messages.push({ role: "user", content: results });
  }
}

async function runScripted() {
  console.log(dim("   (no ANTHROPIC_API_KEY — running a scripted PA; set the key in .env to drive a real model)"));
  for (const b of bills) await payBill(b);
}

h(`1. Your finance PA pays this month's bills — autonomously, within a $${BUDGET}/month budget`);
if (process.env.ANTHROPIC_API_KEY) await runClaude();
else await runScripted();

h("2. The budget held");
console.log(`   spent $${await balance()} of $${BUDGET}.  The $1,500 IRS bill was blocked — it would have blown the budget.`);
const blocked = bills.find((b) => b.amount > BUDGET - 0); // the one the PA couldn't fit

h("3. You review and raise the cap to $3,000 — the PA finishes the job");
await raiseBudget(3000);
console.log(`   ${yellow("budget raised")} $${BUDGET} → $3,000 (you, the owner)`);
const retry = await payBill({ payee: blocked.payee, amount: blocked.amount });
if (retry.paid) console.log(`   ${dim("the IRS bill cleared only after you raised the budget")}`);

h("4. The signed record");
const verify = await client.audit.verify();
console.log(`   audit chain ${verify.ok ? green("VERIFIED") : red("TAMPERED")} (${verify.count} events) — every payment and every block is in the log.`);
const sess = await client.proxy.getSession(session.id);
console.log(`   this month: ${sess.actions.map((a) => a.decision).filter((d) => d === "allowed").length} paid, ${sess.actions.filter((a) => a.decision === "denied").length} blocked.\n`);

await bank.end();

// Raising the cap has no SDK route yet, so the owner edits the role's quota
// directly (read-modify-write) — the human-in-the-loop "you go and change it"
// step. The proxy reads role limits live, so the next payment sees the new cap.
async function raiseBudget(newMax) {
  const admin = new pg.Pool({ connectionString: adminDbUrl });
  const { rows } = await admin.query("SELECT limits FROM roles WHERE name = $1", [pa.role.name]);
  const limits = rows[0]?.limits ?? {};
  limits.skills = limits.skills ?? {};
  limits.skills[`pay-bill-${stamp}@1`] = {
    quotas: [{ key: "monthly-budget", field: "amount", window: "month", max: newMax }],
  };
  await admin.query("UPDATE roles SET limits = $2 WHERE name = $1", [pa.role.name, limits]);
  await admin.end();
}
