import { commandSkillMap, skillRef, toolSkillMap } from "./maps.js";
import type { AdminClient, Employee, EmployeeSkill } from "./types.js";

const DEFAULT_SCHEMA: Record<string, unknown> = { type: "object", additionalProperties: true };
const DEFAULT_IMPLEMENTATION: Record<string, unknown> = { type: "external", runtime: "openclaw" };

export interface OnboardOptions {
  client: AdminClient;
}

export interface OnboardedEmployee {
  employee: Employee;
  roleId: string;
  agentId: string;
  /** skillRef ("name@version") -> MakerChecker skill id. */
  skillIds: Record<string, string>;
  toolSkillMap: Record<string, string>;
  commandSkillMap: Record<string, string>;
}

async function ensureRole(client: AdminClient, role: Employee["role"]): Promise<string> {
  const { roles } = await client.roles.list();
  const existing = roles.find((r) => r.name === role.name);
  if (existing) return existing.id;
  const created = await client.roles.create({
    name: role.name,
    description: role.description,
    ...(role.limits ? { limits: role.limits } : {}),
  });
  return created.role.id;
}

async function ensureSkill(client: AdminClient, skill: EmployeeSkill): Promise<string> {
  const { skills } = await client.skills.list();
  const existing = skills.find((s) => s.name === skill.name && s.version === skill.version);
  if (existing) return existing.id;
  const created = await client.skills.publish({
    name: skill.name,
    version: skill.version,
    description: skill.description,
    riskTier: skill.riskTier,
    inputSchema: skill.inputSchema ?? DEFAULT_SCHEMA,
    outputSchema: skill.outputSchema ?? DEFAULT_SCHEMA,
    implementation: skill.implementation ?? DEFAULT_IMPLEMENTATION,
  });
  return created.skill.id;
}

async function ensureAgent(client: AdminClient, employee: Employee, roleId: string): Promise<string> {
  const { agents } = await client.agents.list();
  const existing = agents.find((a) => a.name === employee.name);
  if (existing) return existing.id;
  const created = await client.agents.create({
    name: employee.name,
    description: employee.description,
    roleId,
    ...(employee.modelConfig ? { modelConfig: employee.modelConfig } : {}),
  });
  return created.agent.id;
}

async function ensureGrant(client: AdminClient, roleId: string, skillId: string): Promise<void> {
  // role_skill_grants is append-only; a duplicate active grant is harmless
  // (enforcement needs one unrevoked row), so a conflict on re-run is ignored.
  try {
    await client.grants.create({ roleId, skillId });
  } catch {
    /* already granted */
  }
}

async function ensureSod(client: AdminClient, roleAId: string, roleBId: string, description: string): Promise<void> {
  // The server orders the pair (least/greatest) and records the audit event.
  // Re-running may add a duplicate, harmless constraint; enforcement fires on any
  // unrevoked match.
  await client.sod.create({ roleAId, roleBId, description });
}

/**
 * Onboard a governed employee into MakerChecker: create its role, publish and
 * grant its skills (deny by default — only these), create the agent, and seed
 * any segregation-of-duties constraints. Idempotent: existing role/skills/agent
 * are reused, so re-running is safe.
 *
 * @throws if a SoD target role named in separationOfDuties has not been
 *   onboarded yet.
 */
export async function onboard(employee: Employee, options: OnboardOptions): Promise<OnboardedEmployee> {
  const { client } = options;
  const roleId = await ensureRole(client, employee.role);

  const skillIds: Record<string, string> = {};
  for (const skill of employee.skills) {
    const skillId = await ensureSkill(client, skill);
    skillIds[skillRef(skill.name, skill.version)] = skillId;
    await ensureGrant(client, roleId, skillId);
  }

  const agentId = await ensureAgent(client, employee, roleId);

  if (employee.separationOfDuties && employee.separationOfDuties.length > 0) {
    const { roles } = await client.roles.list();
    for (const otherRoleName of employee.separationOfDuties) {
      const other = roles.find((r) => r.name === otherRoleName);
      if (!other) {
        throw new Error(`SoD target role "${otherRoleName}" not found — onboard that employee first`);
      }
      await ensureSod(
        client,
        roleId,
        other.id,
        `maker-checker: ${employee.role.name} and ${otherRoleName} may not act in one session`,
      );
    }
  }

  return {
    employee,
    roleId,
    agentId,
    skillIds,
    toolSkillMap: toolSkillMap(employee),
    commandSkillMap: commandSkillMap(employee),
  };
}

/**
 * Onboard a whole org from a declarative list. Two passes so that
 * segregation-of-duties constraints (which reference other roles by name) resolve
 * regardless of order or mutual references: first create every role/skill/grant/
 * agent, then seed SoD once all roles exist. Idempotent.
 */
export async function onboardOrg(employees: Employee[], options: OnboardOptions): Promise<OnboardedEmployee[]> {
  const results: OnboardedEmployee[] = [];
  for (const employee of employees) {
    results.push(await onboard({ ...employee, separationOfDuties: undefined }, { client: options.client }));
  }
  for (const employee of employees) {
    if (employee.separationOfDuties && employee.separationOfDuties.length > 0) {
      await onboard(employee, options);
    }
  }
  return results;
}

/**
 * Offboard an employee: retire its agent so every skill is instantly denied at
 * the proxy with `agent_not_active`. The audit trail of what it did persists.
 */
export async function offboard(employee: Employee, options: Pick<OnboardOptions, "client">): Promise<void> {
  const { agents } = await options.client.agents.list();
  const agent = agents.find((a) => a.name === employee.name);
  if (agent) {
    await options.client.agents.setStatus(agent.id, "retired");
  }
}
