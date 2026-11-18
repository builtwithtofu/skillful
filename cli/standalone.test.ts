import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("initializes, renders and installs a skillful 2 project without Bun on PATH", () => {
    expect(run("init", "--dir", project).exitCode).toBe(0);
    expect(readFileSync(join(project, "skill.mod"), "utf8")).toStartWith("skillful 2\n");
    const listed = run("list", "harnesses", "--project", project);
    expect(listed.exitCode).toBe(0);
    expect(new TextDecoder().decode(listed.stdout)).toBe("claude\ncodex\ncursor\ngrok\nopencode\npi\n");
    expect(run("render", "--project", project, "--out", rendered).exitCode).toBe(0);
    expect(existsSync(join(rendered, ".agents", "skills", "example", "SKILL.md"))).toBe(true);

    const dryRun = run("install", "example", "--project", project, "--dry-run");
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout.toString()).toContain(".agents/skills/example/SKILL.md");
    expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(run("install", "example", "--project", project).exitCode).toBe(0);
    expect(existsSync(join(root, ".agents", "skills", "example", "SKILL.md"))).toBe(true);

    const customRoot = join(root, "custom");
    mkdirSync(customRoot);
    expect(run("install", "--project", project, "--harness", "opencode", "--root", customRoot, "--path", "skills=.config/opencode-v2/skills", "--path", "commands=.config/opencode-v2/commands").exitCode).toBe(0);
    expect(existsSync(join(customRoot, ".config", "opencode-v2", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(customRoot, ".config", "opencode", "skills", "example", "SKILL.md"))).toBe(false);
  });

  test("allows only one concurrent installation to own shared destinations", async () => {
    const firstProject = join(root, "first-owner");
    const secondProject = join(root, "second-owner");
    expect(run("init", "--dir", firstProject).exitCode).toBe(0);
    expect(run("init", "--dir", secondProject).exitCode).toBe(0);
    for (const projectRoot of [firstProject, secondProject]) {
      const references = join(projectRoot, "skills", "example", "references");
      mkdirSync(references, { recursive: true });
      for (let index = 0; index < 500; index++) writeFileSync(join(references, `${index}.md`), `${projectRoot}\n`);
    }
    const home = join(root, "shared-home");
    const state = join(root, "shared-state");
    mkdirSync(home);
    mkdirSync(state);
    const env = { HOME: home, XDG_STATE_HOME: state, PATH: "/nonexistent" };
    const start = (projectRoot: string) => Bun.spawn(
      [binary, "install", "--project", projectRoot, "--harness", "pi", "--root", home, "--force"],
      { stdout: "pipe", stderr: "pipe", env },
    );

    const first = start(firstProject);
    const second = start(secondProject);
    expect((await Promise.all([first.exited, second.exited])).sort()).toEqual([0, 1]);
    expect([
      Bun.spawnSync([binary, "install", "--project", firstProject, "--harness", "pi", "--root", home, "--force"], { stdout: "pipe", stderr: "pipe", env }).exitCode,
      Bun.spawnSync([binary, "install", "--project", secondProject, "--harness", "pi", "--root", home, "--force"], { stdout: "pipe", stderr: "pipe", env }).exitCode,
    ].sort()).toEqual([0, 1]);
  });
});
