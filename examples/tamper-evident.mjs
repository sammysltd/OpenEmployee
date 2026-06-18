// OpenEmployee — Tamper-evident audit log.
//
// Closes the standard critique of in-process verify(): "your verify() runs
// against a DB the app owns; whoever can UPDATE can re-chain to the head."
// This demo connects AS the non-owner runtime role (mc_app_runtime) — the exact
// credential an attacker steals from the app — and tries to forge the audit log.
// Every forge attempt is rejected by Postgres itself, BEFORE verify() ever runs.
// The protection is the database privilege model, not detection after the fact.
//
// Prereq: ops/harden-db.sql has been applied as the table owner, provisioning
// mc_app_runtime REVOKEd from UPDATE/DELETE/TRUNCATE on audit_events and unable
// to ALTER (disable the append-only trigger) since it does not own the table.
//
//   MAKERCHECKER_BASE_URL=http://localhost:3001 \
//   MAKERCHECKER_API_KEY=mk_... \
//   MC_RUNTIME_DATABASE_URL=postgres://mc_app_runtime:<pw>@localhost:5432/mc_quota \
//   node examples/tamper-evident.mjs
import pg from "pg";
import { bold, dim, green, makeClient, red, yellow } from "./lib.mjs";

// The stolen credential: connect as the non-owner runtime role, NOT the owner.
const runtimeUrl =
  process.env.MC_RUNTIME_DATABASE_URL ??
  "postgres://mc_app_runtime:runtime_s3cret_quota@localhost:5432/mc_quota";
const pool = new pg.Pool({ connectionString: runtimeUrl });
const client = makeClient();

const who = await pool.query("SELECT current_user");
const head = await pool.query("SELECT min(seq) AS lo, max(seq) AS hi FROM audit_events");
const victim = head.rows[0].hi; // the head row an attacker would rewrite

console.log("\n  " + bold("OpenEmployee — Tamper-evident audit log"));
console.log("  " + dim("─".repeat(64)));
console.log(
  "  connected as " + yellow(who.rows[0].current_user) +
    dim(`  (the credential an attacker steals — head seq ${victim})`) + "\n",
);

// Each forge runs in its own transaction so one rejection cannot abort the next.
async function forge(label, sql) {
  try {
    await pool.query(sql);
    console.log("  " + red("[ FORGED ]") + ` ${label.padEnd(34)} ${red("NOT BLOCKED — log is mutable")}`);
    return false;
  } catch (err) {
    const msg = `${err.code ? err.code + " " : ""}${err.message}`.replace(/\s+/g, " ").trim();
    console.log("  " + green("[ BLOCKED ]") + ` ${label.padEnd(34)} ${dim(msg.slice(0, 60))}`);
    return true;
  }
}

const blocked = [];
// 1. Disable the append-only trigger — requires table ownership.
blocked.push(
  await forge(
    "DISABLE TRIGGER",
    "ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete",
  ),
);
// 2. Rewrite a payload in place — needs UPDATE, which is REVOKEd.
blocked.push(
  await forge(
    "UPDATE payload",
    `UPDATE audit_events SET payload = '{"forged":true}'::jsonb WHERE seq = ${victim}`,
  ),
);
// 3. Delete the head row to roll the chain back — needs DELETE, which is REVOKEd.
blocked.push(
  await forge("DELETE row", `DELETE FROM audit_events WHERE seq = ${victim}`),
);

// The chain was never touched: verify() confirms it, but the DB already refused
// every write above — this is the guarantee, not a post-hoc check.
const verify = await client.audit.verify();
const status = verify.ok ? green("VERIFIED") : red("TAMPERED");
const all = blocked.every(Boolean);

console.log("");
console.log(
  "  audit chain " + status +
    dim(`  (${verify.count} events, head ${(verify.headHash ?? "").slice(0, 12)}…)`),
);
console.log(
  "  " + bold(`${blocked.filter(Boolean).length}/${blocked.length} forge attempts rejected by the database`) +
    dim(" — before verify() ran."),
);

// Honesty about the residual: the single-role quickstart connects AS the owner,
// and an owner CAN disable its own trigger. That is exactly why production runs
// the non-owner role you just watched the database refuse.
console.log(
  "\n  " + yellow("Residual: ") +
    dim("the single-role quickstart's OWNER could still DISABLE TRIGGER and rewrite the log."),
);
console.log(
  "  " + dim("That is why production connects as the non-owner mc_app_runtime role — the one rejected above."),
);
console.log("  " + dim("─".repeat(64)) + "\n");

await pool.end();
process.exit(all && verify.ok ? 0 : 1);
