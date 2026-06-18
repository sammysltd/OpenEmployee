import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Client } from "@makerchecker/sdk";
import { CheckIdStore, createGovernance, type Governance } from "@openemployee/connector-openclaw";
import { offboard, onboard, type Employee, type OnboardedEmployee } from "@openemployee/employee";

// Integration tests. Run only when MAKERCHECKER_API_KEY is set —
// point it at a live server (docker compose up). No mocks below the SDK.
const apiKey = process.env.MAKERCHECKER_API_KEY;
const baseUrl = process.env.MAKERCHECKER_BASE_URL ?? "http://localhost:3000";
const databaseUrl =
  process.env.MAKERCHECKER_DATABASE_URL ?? "postgres://makerchecker:makerchecker@localhost:5432/makerchecker";

const stamp = Date.now();

describe.skipIf(!apiKey)("OpenEmployee governance against a live MakerChecker", () => {
  let client: Client;
  let pool: pg.Pool;
  let preparer: Employee;
  let approver: Employee;
  let P: OnboardedEmployee;
  let A: OnboardedEmployee;
  let sessionId: string;
  let prep: Governance;
  let appr: Governance;

  beforeAll(async () => {
    client = createClient({ baseUrl, apiKey });
    pool = new pg.Pool({ connectionString: databaseUrl });

    preparer = {
      name: `it-preparer-${stamp}`,
      description: "Prepares reconciliations.",
      role: { name: `it-prep-role-${stamp}`, description: "Ingests and matches." },
      owner: { id: "u-cfo", email: "cfo@corp" },
      skills: [
        { name: `it-csv-${stamp}`, version: 1, description: "Ingest CSV", riskTier: "low", tools: ["csv_ingest"] },
        { name: `it-pay-${stamp}`, version: 1, description: "Post payment", riskTier: "high", tools: ["post_payment"] },
      ],
    };
    approver = {
      name: `it-approver-${stamp}`,
      description: "Approves reconciliations.",
      role: { name: `it-appr-role-${stamp}`, description: "Approves." },
      owner: { id: "u-ctrl", email: "ctrl@corp" },
      skills: [{ name: `it-approve-${stamp}`, version: 1, description: "Approve", riskTier: "low", tools: ["approve_recon"] }],
      separationOfDuties: [`it-prep-role-${stamp}`],
    };

    P = await onboard(preparer, { client });
    A = await onboard(approver, { client });

    const opened = await client.proxy.openSession({ label: `it-${stamp}`, externalRef: "owner:cfo@corp" });
    sessionId = opened.session.id;
    prep = createGovernance({ client, sessionId, agentName: preparer.name, toolSkillMap: P.toolSkillMap, store: new CheckIdStore() });
    appr = createGovernance({ client, sessionId, agentName: approver.name, toolSkillMap: A.toolSkillMap, store: new CheckIdStore() });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const evaluate = (gov: Governance, tool: string, params: Record<string, unknown> = {}) =>
    gov.toolPolicy.evaluate({ toolName: tool, params, toolCallId: `${tool}-${stamp}-${Math.random()}` }, { toolName: tool, toolCallId: `${tool}-x` });

  it("allows a granted low-risk tool", async () => {
    expect(await evaluate(prep, "csv_ingest", { file: "jan.csv" })).toEqual({});
  });

  it("blocks an unmapped tool at the connector (deny by default)", async () => {
    const decision = await evaluate(prep, "rm_rf");
    expect(decision).toMatchObject({ block: true });
    expect((decision as { blockReason: string }).blockReason).toContain("deny by default");
  });

  it("blocks an in-map but ungranted skill at the proxy (skill_not_granted)", async () => {
    const crossed = createGovernance({
      client,
      sessionId,
      agentName: preparer.name,
      toolSkillMap: { approve_recon: A.toolSkillMap["approve_recon"]! },
      store: new CheckIdStore(),
    });
    const decision = await evaluate(crossed, "approve_recon");
    expect((decision as { blockReason: string }).blockReason).toContain("skill_not_granted");
  });

  it("blocks a high-risk tool — it needs an approval flow", async () => {
    const decision = await evaluate(prep, "post_payment", { amount: 1_000_000 });
    expect((decision as { blockReason: string }).blockReason).toContain("high_risk_requires_gate");
  });

  it("enforces segregation of duties within one session", async () => {
    await evaluate(prep, "csv_ingest"); // preparer (role A) acts
    const decision = await evaluate(appr, "approve_recon"); // approver (role B) conflicts
    expect((decision as { blockReason: string }).blockReason).toContain("sod_violation");
  });

  it("verifies the audit chain and records both an allow and a deny", async () => {
    const verify = await client.audit.verify();
    expect(verify.ok).toBe(true);
    const session = await client.proxy.getSession(sessionId);
    const decisions = session.actions.map((a) => a.decision);
    expect(decisions).toContain("allowed");
    expect(decisions).toContain("denied");
  });

  it("detects out-of-band audit tampering and recovers when restored", async () => {
    const { rows } = await pool.query<{ seq: string; hash: string }>(
      "SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1",
    );
    const target = rows[0]!;
    try {
      await pool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
      await pool.query("UPDATE audit_events SET hash = $1 WHERE seq = $2", ["0".repeat(64), target.seq]);
      const tampered = await client.audit.verify();
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.failedSeq).toBe(target.seq);
    } finally {
      await pool.query("UPDATE audit_events SET hash = $1 WHERE seq = $2", [target.hash, target.seq]);
      await pool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");
    }
    const restored = await client.audit.verify();
    expect(restored.ok).toBe(true);
  });

  it("blocks a retired employee (offboarding is instant)", async () => {
    await offboard(preparer, { client });
    const next = await client.proxy.openSession({ label: `it-off-${stamp}` });
    const ghost = createGovernance({
      client,
      sessionId: next.session.id,
      agentName: preparer.name,
      toolSkillMap: P.toolSkillMap,
      store: new CheckIdStore(),
    });
    const decision = await ghost.toolPolicy.evaluate(
      { toolName: "csv_ingest", params: {}, toolCallId: "off-x" },
      { toolName: "csv_ingest", toolCallId: "off-x" },
    );
    expect((decision as { blockReason: string }).blockReason).toContain("agent_not_active");
  });
});
