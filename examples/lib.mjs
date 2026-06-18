import { createClient } from "@makerchecker/sdk";
import pg from "pg";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = wrap("32");
export const red = wrap("31");
export const yellow = wrap("33");
export const bold = wrap("1");
export const dim = wrap("2");

export const h = (t) => console.log("\n" + bold(t));

export function env() {
  const baseUrl = process.env.MAKERCHECKER_BASE_URL ?? "http://localhost:3000";
  const apiKey = process.env.MAKERCHECKER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "set MAKERCHECKER_API_KEY (the demo admin key the server prints at boot; see docker compose logs server)",
    );
  }
  const databaseUrl =
    process.env.MAKERCHECKER_DATABASE_URL ?? "postgres://makerchecker:makerchecker@localhost:5432/makerchecker";
  return { baseUrl, apiKey, databaseUrl };
}

export function makeClient() {
  const { baseUrl, apiKey } = env();
  return createClient({ baseUrl, apiKey });
}

export function makePool() {
  const { databaseUrl } = env();
  return new pg.Pool({ connectionString: databaseUrl });
}
