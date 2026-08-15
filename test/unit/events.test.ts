import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, computeEventHash } from "../../src/domain/events";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 1 })).toBe('{"a":1,"z":{"c":2,"d":1}}');
  });

  it("emits no whitespace", () => {
    expect(canonicalJson({ a: 1, b: [1, 2, 3] })).not.toMatch(/\s/);
  });

  it("preserves array order (arrays are ordered data, not sorted)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ items: ["b", "a"] })).toBe('{"items":["b","a"]}');
  });

  it("handles primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });

  it("is order-independent: differently-ordered input objects produce identical output", () => {
    const a = canonicalJson({ x: 1, y: 2, z: { m: 1, n: 2 } });
    const b = canonicalJson({ z: { n: 2, m: 1 }, y: 2, x: 1 });
    expect(a).toBe(b);
  });
});

describe("computeEventHash (Section 8)", () => {
  const base = { prevHash: "0".repeat(64), payload: { foo: "bar" }, actorId: "user-1", seq: 1, createdAtIso: "2026-08-14T00:00:00.000Z" };

  it("matches an independently computed SHA-256 of the literal concatenation", () => {
    const expected = createHash("sha256")
      .update(base.prevHash + canonicalJson(base.payload) + base.actorId + String(base.seq) + base.createdAtIso, "utf8")
      .digest("hex");
    expect(computeEventHash(base)).toBe(expected);
  });

  it("is deterministic for identical input", () => {
    expect(computeEventHash(base)).toBe(computeEventHash({ ...base }));
  });

  it("changes if prevHash changes", () => {
    expect(computeEventHash({ ...base, prevHash: "1".repeat(64) })).not.toBe(computeEventHash(base));
  });

  it("changes if payload changes", () => {
    expect(computeEventHash({ ...base, payload: { foo: "baz" } })).not.toBe(computeEventHash(base));
  });

  it("changes if actorId changes", () => {
    expect(computeEventHash({ ...base, actorId: "user-2" })).not.toBe(computeEventHash(base));
  });

  it("changes if seq changes", () => {
    expect(computeEventHash({ ...base, seq: 2 })).not.toBe(computeEventHash(base));
  });

  it("changes if createdAtIso changes", () => {
    expect(computeEventHash({ ...base, createdAtIso: "2026-08-14T00:00:00.001Z" })).not.toBe(computeEventHash(base));
  });

  it("payload key order never affects the hash (canonical JSON)", () => {
    const h1 = computeEventHash({ ...base, payload: { a: 1, b: 2 } });
    const h2 = computeEventHash({ ...base, payload: { b: 2, a: 1 } });
    expect(h1).toBe(h2);
  });

  it("produces a 64-character lowercase hex digest", () => {
    expect(computeEventHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
