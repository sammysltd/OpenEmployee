// Before/after: the same personal-assistant agent, ungoverned vs. governed.
//
// The owner asked it to "summarize the repo and post to Discord, and grab the
// deploy key from 1Password." Ungoverned, an agent just runs every tool. As an
// OpenEmployee, it can do only what its role grants — and everything it tries is
// recorded.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/ungoverned-vs-governed.mjs
import { CheckIdStore, createGovernance } from "@openemployee/connector-openclaw";
import { onboard } from "@openemployee/employee";
import { bold, dim, green, h, makeClient, red } from "./lib.mjs";

const client = makeClient();
const stamp = Date.now();

const assistant = {
  name: `assistant-${stamp}`,
  description: "Personal assistant employee.",
  role: { name: `assistant-role-${stamp}`, description: "Reads the repo and drafts summaries." },
  owner: { id: "u-me", email: "me@corp" },
  skills: [
    { name: `read-repo-${stamp}`, version: 1, description: "Read repository files", riskTier: "low", tools: ["read_repo"] },
    { name: `onepassword-${stamp}`, version: 1, description: "Read a 1Password secret", riskTier: "high", tools: ["onepassword_read"] },
    // post_discord and shell are deliberately NOT granted to this employee.
  ],
};

const onboarded = await onboard(assistant, { client });
const { session } = await client.proxy.openSession({ label: `assistant-${stamp}`, externalRef: `owner:${assistant.owner.email}` });
const gov = createGovernance({
  client,
  sessionId: session.id,
  agentName: assistant.name,
  toolSkillMap: onboarded.toolSkillMap,
  store: new CheckIdStore(),
});

const plan = [
  ["read_repo", { path: "." }, "summarize the codebase"],
  ["post_discord", { channel: "#general" }, "post the summary to Discord"],
  ["onepassword_read", { item: "deploy-key" }, "grab the deploy key from 1Password"],
  ["shell", { cmd: "rm -rf ~/.aws" }, "tidy up"],
];

const name = (t) => bold(t.padEnd(16));

h("UNGOVERNED OpenClaw — every tool call just runs:");
for (const [tool, , intent] of plan) {
  console.log(`   ${red("RUN")}    ${name(tool)} ${dim(intent)}`);
}

h("OpenEmployee — the same agent, governed by its role:");
for (const [tool, params, intent] of plan) {
  const ev = { toolName: tool, params, toolCallId: `${tool}-${Date.now()}` };
  const decision = await gov.toolPolicy.evaluate(ev, { toolName: tool, toolCallId: ev.toolCallId });
  if (!decision.block) {
    console.log(`   ${green("ALLOW")}  ${name(tool)} ${dim(intent)}`);
    continue;
  }
  const reason = /high_risk/.test(decision.blockReason)
    ? "high-risk — needs an approval flow"
    : /not granted/.test(decision.blockReason)
      ? "not granted (deny by default)"
      : decision.blockReason;
  console.log(`   ${red("BLOCK")}  ${name(tool)} ${dim(reason)}`);
}

const verify = await client.audit.verify();
h(`Every attempt above — allowed or denied — is in the signed audit chain (verify ok=${verify.ok}, ${verify.count} events).`);
console.log("");
