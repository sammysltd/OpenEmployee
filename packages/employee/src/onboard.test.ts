import { describe, expect, it, vi } from "vitest";

import { offboard, onboard, onboardOrg } from "./onboard.js";
import type { AdminClient, Employee } from "./types.js";

interface Row {
  id: string;
  name: string;
  version?: number;
  role_id?: string;
  skill_id?: string;
  status?: string;
}

function fakeClient() {
  const roles: Row[] = [];
  const skills: Row[] = [];
  const agents: Row[] = [];
  const grants: Row[] = [];
  const sodCreates: Array<{ roleAId: string; roleBId: string; description?: string }> = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const client = {
    roles: {
      list: vi.fn(async () => ({ roles })),
      create: vi.fn(async (i: { name: string; description?: string }) => {
        const role = { id: id("role"), name: i.name };
        roles.push(role);
        return { role };
      }),
    },
    skills: {
      list: vi.fn(async () => ({ skills })),
      publish: vi.fn(async (i: { name: string; version: number }) => {
        const skill = { id: id("skill"), name: i.name, version: i.version };
        skills.push(skill);
        return { skill };
      }),
    },
    agents: {
      list: vi.fn(async () => ({ agents })),
      create: vi.fn(async (i: { name: string; roleId: string }) => {
        const agent = { id: id("agent"), name: i.name, role_id: i.roleId, status: "active" };
        agents.push(agent);
        return { agent };
      }),
      setStatus: vi.fn(async (agentId: string, status: string) => {
        const agent = agents.find((a) => a.id === agentId);
        if (agent) agent.status = status;
        return { agent };
      }),
    },
    grants: {
      create: vi.fn(async (i: { roleId: string; skillId: string }) => {
        const grant = { id: id("grant"), role_id: i.roleId, skill_id: i.skillId };
        grants.push(grant);
        return { grant };
      }),
    },
    sod: {
      create: vi.fn(async (i: { roleAId: string; roleBId: string; description?: string }) => {
        sodCreates.push(i);
        return { sodConstraint: { id: id("sod"), role_a_id: i.roleAId, role_b_id: i.roleBId } };
      }),
    },
  };
  return { client: client as unknown as AdminClient, state: { roles, skills, agents, grants, sodCreates } };
}

const preparer: Employee = {
  name: "recon-preparer",
  description: "Prepares reconciliations.",
  role: { name: "preparer-role", description: "Prepares." },
  owner: { id: "u-1", email: "ops@corp" },
  skills: [{ name: "csv-ingest", version: 1, description: "Ingest CSV", riskTier: "low", tools: ["csv_ingest"] }],
};

const approver: Employee = {
  name: "recon-approver",
  description: "Approves reconciliations.",
  role: { name: "approver-role", description: "Approves." },
  owner: { id: "u-2", email: "mgr@corp" },
  skills: [{ name: "approve-recon", version: 1, description: "Approve", riskTier: "low", tools: ["approve_recon"] }],
  separationOfDuties: ["preparer-role"],
};

describe("onboard", () => {
  it("creates role, skills, grants, and agent, and returns derived maps", async () => {
    const { client, state } = fakeClient();
    const result = await onboard(preparer, { client });
    expect(state.roles).toHaveLength(1);
    expect(state.skills).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
    expect(state.agents).toHaveLength(1);
    expect(result.toolSkillMap).toEqual({ csv_ingest: "csv-ingest@1" });
    expect(result.skillIds["csv-ingest@1"]).toBe(state.skills[0]!.id);
    expect(result.agentId).toBe(state.agents[0]!.id);
  });

  it("is idempotent — re-running reuses existing role, skill, and agent", async () => {
    const { client, state } = fakeClient();
    await onboard(preparer, { client });
    await onboard(preparer, { client });
    expect(state.roles).toHaveLength(1);
    expect(state.skills).toHaveLength(1);
    expect(state.agents).toHaveLength(1);
  });

  it("seeds a SoD constraint against an already-onboarded role", async () => {
    const { client, state } = fakeClient();
    await onboard(preparer, { client });
    const result = await onboard(approver, { client });
    expect(state.sodCreates).toHaveLength(1);
    expect(state.sodCreates[0]!.description).toContain("maker-checker");
    expect(state.sodCreates[0]!.roleAId).toBe(result.roleId);
    expect(state.sodCreates[0]!.roleBId).toBe(state.roles[0]!.id);
  });

  it("throws when a SoD target role has not been onboarded", async () => {
    const { client } = fakeClient();
    await expect(onboard(approver, { client })).rejects.toThrow(/not found/);
  });

  it("ignores a duplicate-grant conflict", async () => {
    const { client } = fakeClient();
    (client.grants.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("409 already granted"));
    await expect(onboard(preparer, { client })).resolves.toBeDefined();
  });
});

describe("onboardOrg", () => {
  it("onboards a whole org and seeds SoD after all roles exist (order-independent)", async () => {
    const { client, state } = fakeClient();
    // approver (with SoD on preparer-role) listed BEFORE its target — must still resolve.
    const results = await onboardOrg([approver, preparer], { client });
    expect(results).toHaveLength(2);
    expect(state.roles).toHaveLength(2);
    expect(state.agents).toHaveLength(2);
    expect(state.sodCreates).toHaveLength(1);
  });
});

describe("offboard", () => {
  it("retires the agent", async () => {
    const { client, state } = fakeClient();
    await onboard(preparer, { client });
    await offboard(preparer, { client });
    expect(state.agents[0]!.status).toBe("retired");
  });

  it("is a no-op when the agent does not exist", async () => {
    const { client } = fakeClient();
    await expect(offboard(preparer, { client })).resolves.toBeUndefined();
  });
});
