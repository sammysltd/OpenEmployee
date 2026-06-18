import type { Employee } from "./types.js";

/** The MakerChecker skillRef ("name@version") for a skill. */
export function skillRef(name: string, version: number): string {
  return `${name}@${version}`;
}

/**
 * Derive the connector's deny-by-default tool→skillRef map from an employee.
 * Only tools listed here can run; everything else is blocked at the connector.
 */
export function toolSkillMap(employee: Employee): Record<string, string> {
  const map: Record<string, string> = {};
  for (const skill of employee.skills) {
    for (const tool of skill.tools ?? []) {
      map[tool] = skillRef(skill.name, skill.version);
    }
  }
  return map;
}

/** Derive the node-command→skillRef map (governs shell/node) from an employee. */
export function commandSkillMap(employee: Employee): Record<string, string> {
  const map: Record<string, string> = {};
  for (const skill of employee.skills) {
    for (const command of skill.commands ?? []) {
      map[command] = skillRef(skill.name, skill.version);
    }
  }
  return map;
}
