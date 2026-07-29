import { describe, expect, test } from "bun:test";
import { HarnessError, loadHarnesses, normalizeHarness } from "./harness.ts";

describe("harness facts", () => {
  test("loads and validates every public fact file", () => {
    const harnesses = loadHarnesses();
    expect(Object.keys(harnesses).sort()).toEqual(["claude", "opencode", "opencode-v2", "pi"]);
    for (const fact of Object.values(harnesses)) {
      expect(fact.installPaths.skills).toBeString();
      expect(fact.installPaths.commands).toBeString();
      expect(["inject", "file"]).toContain(fact.commandMerge);
    }
  });

  test("rejects unknown and retired harness identifiers", () => {
    expect(() => normalizeHarness("opencodev2")).toThrow(HarnessError);
    expect(() => normalizeHarness("unknown")).toThrow(HarnessError);
  });
});
