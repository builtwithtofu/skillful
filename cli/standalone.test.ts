import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "skillful-standalone-test-"));
const binary = join(root, "skillful");
const project = join(root, "project");
const rendered = join(root, "rendered");
const environment = { HOME: root, XDG_CACHE_HOME: join(root, "cache"), PATH: "/nonexistent" };

beforeAll(() => {
  const built = Bun.spawnSync(["bun", "build", "--compile", join(import.meta.dir, "main.ts"), "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(built.stderr)).toBe("");
  expect(built.exitCode).toBe(0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(...args: string[]) {
  return Bun.spawnSync([binary, ...args], { stdout: "pipe", stderr: "pipe", env: environment });
}

describe("standalone executable", () => {
  test("initializes and renders with no Bun runtime on PATH", () => {
    expect(run("init", "--dir", project).exitCode).toBe(0);
    const listed = run("list", "harnesses", "--project", project);
    expect(listed.exitCode).toBe(0);
    expect(new TextDecoder().decode(listed.stdout)).toContain("opencode-v2");
    expect(run("render", "--project", project, "--out", rendered).exitCode).toBe(0);
    expect(existsSync(join(rendered, "pi", "skills", "example", "SKILL.md"))).toBe(true);
  });
});
