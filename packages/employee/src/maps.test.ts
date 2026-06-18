import { describe, expect, it } from "vitest";

import { commandSkillMap, skillRef, toolSkillMap } from "./maps.js";
import type { Employee } from "./types.js";

const employee: Employee = {
  name: "research-assistant",
  description: "Drafts research from public sources.",
  role: { name: "researcher", description: "Reads and drafts." },
  owner: { id: "u-alice", email: "alice@corp" },
  skills: [
    { name: "web-fetch", version: 1, description: "Fetch a URL", riskTier: "low", tools: ["web_fetch", "http_get"] },
    { name: "shell-run", version: 2, description: "Run a shell command", riskTier: "high", commands: ["system.run", "system.run.prepare"] },
    { name: "no-binding", version: 1, description: "Granted but unbound", riskTier: "low" },
  ],
};

describe("maps", () => {
  it("builds skillRef as name@version", () => {
    expect(skillRef("web-fetch", 1)).toBe("web-fetch@1");
  });

  it("maps every tool to its versioned skillRef", () => {
    expect(toolSkillMap(employee)).toEqual({ web_fetch: "web-fetch@1", http_get: "web-fetch@1" });
  });

  it("maps every node command to its versioned skillRef", () => {
    expect(commandSkillMap(employee)).toEqual({
      "system.run": "shell-run@2",
      "system.run.prepare": "shell-run@2",
    });
  });

  it("omits skills with no tool/command bindings from both maps", () => {
    expect(toolSkillMap(employee)["no-binding"]).toBeUndefined();
    expect(Object.values(commandSkillMap(employee))).not.toContain("no-binding@1");
  });
});
