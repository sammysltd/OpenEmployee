import { describe, expect, it } from "vitest";

import { dlpGuard } from "./guard.js";

describe("dlpGuard — payload scanning", () => {
  it("passes clean content", () => {
    const g = dlpGuard();
    expect(g("send_email", { to: "ada@acme.io", subject: "Hi", body: "Quick intro, thanks." })).toBeNull();
  });

  it("blocks an OpenAI-style secret key in the body", () => {
    const g = dlpGuard();
    const hit = g("send_email", { body: "here is the key sk-abcDEF0123456789ghijkl" });
    expect(hit).not.toBeNull();
    expect(hit?.reason).toContain("API key");
  });

  it("blocks a MakerChecker admin key shape", () => {
    const g = dlpGuard();
    const hit = g("send_email", { body: "mk_deadbeefdeadbeefdeadbeefdeadbeef" });
    expect(hit?.reason).toContain("MakerChecker");
  });

  it("blocks an AWS access key id", () => {
    const g = dlpGuard();
    const hit = g("send_email", { note: "AKIAIOSFODNN7EXAMPLE" });
    expect(hit?.reason).toContain("AWS access key");
  });

  it("blocks a Luhn-valid credit-card number but not an arbitrary long id", () => {
    const g = dlpGuard();
    expect(g("send_email", { body: "card 4111 1111 1111 1111" })?.reason).toContain("credit-card");
    // 16 digits that fail Luhn — must not false-fire.
    expect(g("send_email", { body: "order 1234567890123456" })).toBeNull();
  });

  it("blocks a US SSN shape", () => {
    const g = dlpGuard();
    expect(g("send_email", { body: "ssn 123-45-6789" })?.reason).toContain("Social Security");
  });

  it("blocks a bulk set of distinct emails at the threshold", () => {
    const g = dlpGuard({ maxEmails: 3 });
    const body = "to: a@x.io, b@x.io, c@x.io";
    expect(g("send_email", { body })?.reason).toContain("3 email addresses");
  });

  it("counts distinct emails only (duplicates do not inflate)", () => {
    const g = dlpGuard({ maxEmails: 3 });
    expect(g("send_email", { body: "a@x.io a@x.io A@X.IO" })).toBeNull();
  });

  it("blocks a caller-supplied marker, case-insensitively", () => {
    const g = dlpGuard({ markers: ["CONFIDENTIAL", "customer database"] });
    expect(g("send_email", { body: "see attached customer DATABASE export" })?.reason).toContain("customer database");
    expect(g("send_email", { body: "marked Confidential" })?.reason).toContain("confidential");
  });

  it("a marker wins over a clean default scan", () => {
    const g = dlpGuard({ markers: ["secret-project-x"] });
    expect(g("send_email", { subject: "re: secret-project-x" })).not.toBeNull();
  });

  it("is deterministic: same input, same decision", () => {
    const g = dlpGuard();
    const params = { body: "key sk-abcDEF0123456789ghijkl" };
    expect(g("send_email", params)).toEqual(g("send_email", params));
  });

  it("tolerates empty/odd params without throwing", () => {
    const g = dlpGuard();
    expect(g("send_email", {})).toBeNull();
    expect(g("send_email", { nested: { deep: { v: 1 } } })).toBeNull();
  });
});
