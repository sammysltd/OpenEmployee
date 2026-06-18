import type { Client } from "@makerchecker/sdk";

export type RiskTier = "low" | "medium" | "high";

/**
 * A capability the employee may use. Maps one-to-one onto a versioned
 * MakerChecker skill, plus the OpenClaw tool/command names that invoke it.
 */
export interface EmployeeSkill {
  name: string;
  version: number;
  description: string;
  riskTier: RiskTier;
  /** OpenClaw tool names that invoke this capability. */
  tools?: string[];
  /** OpenClaw node commands (e.g. "system.run") that invoke this capability. */
  commands?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Recorded on the MakerChecker skill (informational; OpenClaw does the execution). */
  implementation?: Record<string, unknown>;
}

/**
 * An OpenClaw agent modeled as a governed employee: one role (its job), a
 * deny-by-default set of skills (what it may do), segregation-of-duties
 * constraints (what it may not combine), and an accountable human owner.
 */
export interface Employee {
  /** The employee's identity = a MakerChecker agent name. */
  name: string;
  description: string;
  role: { name: string; description: string; limits?: Record<string, unknown> };
  /** Accountable human owner; carried into the audit chain via the session externalRef. */
  owner: { id: string; email: string };
  /** Deny-by-default: only these capabilities may run. */
  skills: EmployeeSkill[];
  /** Other role names this employee's role may not act alongside in one session. */
  separationOfDuties?: string[];
  modelConfig?: Record<string, unknown>;
}

/** The MakerChecker SDK client used for onboarding/offboarding. */
export type AdminClient = Client;
