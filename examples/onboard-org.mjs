// Apply a declarative org — policy as code for your AI workforce.
//
//   MAKERCHECKER_API_KEY=mk_... node examples/onboard-org.mjs [path/to/org.json]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { onboardOrg } from "@openemployee/employee";
import { bold, dim, green, h, makeClient, makePool } from "./lib.mjs";

const file = process.argv[2] ?? fileURLToPath(new URL("./acme.org.json", import.meta.url));
const { org, employees } = JSON.parse(await readFile(file, "utf8"));

const client = makeClient();
const pool = makePool();

h(`Applying the ${bold(org)} org — ${employees.length} employees, defined as code`);
const onboarded = await onboardOrg(employees, { client, sql: pool });

for (const result of onboarded) {
  const e = result.employee;
  const high = e.skills.filter((s) => s.riskTier === "high").length;
  const sod = e.separationOfDuties?.length ? `, SoD: not with ${e.separationOfDuties.join("/")}` : "";
  console.log(
    `   ${green("hired")} ${e.name.padEnd(20)} ${dim(`role ${e.role.name}  ·  ${e.skills.length} skills (${high} high-risk)${sod}`)}`,
  );
}

console.log(`\n   ${dim("Every action these employees take is now deny-by-default, SoD-constrained, and signed.")}\n`);
await pool.end();
