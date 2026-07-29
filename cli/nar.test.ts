import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheKey, narHash } from "./nar.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const fixture = join(import.meta.dir, "tests", "fixtures", "nar", "tree");

describe("NAR serialization", () => {
  test("matches independent nix hash path oracles", () => {
    const emptyDirectory = mkdtempSync(join(tmpdir(), "skillful-empty-nar-"));
    temporary.push(emptyDirectory);
    const cases = [
      [fixture, "sha256-2mxlEDW3+N2Q3hEqYg8ZBul6b/TTvRaZagRheRHWhEY="],
      [join(fixture, "run.sh"), "sha256-+0fil9Mk2ccjjPib96LKe+C4im9koQ07TY3OvgqUAXo="],
      [join(fixture, "link"), "sha256-Edqgi676ttAD2VGyWJvn2T+fGI54Q/9klu3PqmwFcWM="],
      [join(fixture, "empty"), "sha256-d6xi4mKdjkX2JFicDIv5niSzpyI0m/Hnm8GGAIU04kY="],
      [emptyDirectory, "sha256-pQpattmS9VmO3ZIQUFn66az8GSmB4IvYhTTCFn6SUmo="],
    ] as const;
    for (const [path, expected] of cases) expect(narHash(path), `nix hash path --sri ${path}`).toBe(expected);
  });

  test("encodes SRI hashes as filesystem-safe cache keys", () => {
    expect(cacheKey("sha256-2mxlEDW3+N2Q3hEqYg8ZBul6b/TTvRaZagRheRHWhEY=")).toBe("2mxlEDW3-N2Q3hEqYg8ZBul6b_TTvRaZagRheRHWhEY");
  });
});
