import { describe, expect, test } from "bun:test";
import { HarnessError, loadHarnesses, normalizeHarness } from "./harness.ts";

describe("harness facts", () => {
  test("loads and validates every public fact file", () => {
    const harnesses = loadHarnesses();
    for (const fact of Object.values(harnesses)) {
      for (const paths of Object.values(fact.installPaths)) {
        expect(paths.skills).toBeString();
        if (fact.commandMerge === "skill") expect(paths.commands).toBeUndefined();
        else expect(paths.commands).toBeString();
      }
      expect(["inject", "file", "skill"]).toContain(fact.commandMerge);
    }
  });

  test("rejects unknown harness identifiers and explains the retired OpenCode name", () => {
    expect(() => normalizeHarness("unknown")).toThrow(HarnessError);
    try {
      normalizeHarness("opencode-v2");
      throw new Error("expected retired harness failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).recovery).toContain("--path");
    }
  });
});
