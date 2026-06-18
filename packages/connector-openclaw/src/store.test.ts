import { describe, expect, it } from "vitest";

import { CheckIdStore } from "./store.js";

describe("CheckIdStore", () => {
  it("stashes then pops a checkId exactly once", () => {
    const store = new CheckIdStore();
    store.stash("t1", "c1");
    expect(store.pending).toBe(1);
    expect(store.take("t1")).toBe("c1");
    expect(store.take("t1")).toBeUndefined();
    expect(store.pending).toBe(0);
  });

  it("ignores a missing toolCallId on both stash and take", () => {
    const store = new CheckIdStore();
    store.stash(undefined, "c1");
    expect(store.pending).toBe(0);
    expect(store.take(undefined)).toBeUndefined();
    expect(store.take("never-stashed")).toBeUndefined();
  });
});
