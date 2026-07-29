import { describe, expect, test } from "bun:test";
import { formatLock, parseLock } from "./lock.ts";

const entry = { name: "demo", ref: "github:owner/repo@main", rev: "a".repeat(40), narHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };

describe("skill.lock", () => {
  test("parses and canonically formats sorted pins", () => {
    const second = { ...entry, name: "another" };
    expect(formatLock([entry, second])).toBe(`${second.name} ${second.ref} ${second.rev} ${second.narHash}\n${entry.name} ${entry.ref} ${entry.rev} ${entry.narHash}\n`);
    expect(parseLock(formatLock([second, entry]))).toEqual([second, entry]);
  });

  test("diagnoses corruption and merge conflicts with recovery", () => {
    expect(() => parseLock("<<<<<<< ours\n")).toThrow("lock merge conflict");
    expect(() => parseLock(`demo  ${entry.ref} ${entry.rev} ${entry.narHash}\n`)).toThrow("noncanonical spacing");
    expect(() => parseLock(`demo ${entry.ref} short ${entry.narHash}\n`)).toThrow("invalid resolved revision");
    expect(() => parseLock(`z ${entry.ref} ${entry.rev} ${entry.narHash}\na ${entry.ref} ${entry.rev} ${entry.narHash}\n`)).toThrow("not sorted");
  });
});
