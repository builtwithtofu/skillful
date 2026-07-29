import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey } from "./nar.ts";

const dirs: string[] = [];
const temp = () => { const dir = join(tmpdir(), `skillful-main-${crypto.randomUUID()}`); mkdirSync(dir); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const output = (result: ReturnType<typeof run>) => ({ stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) });

describe("project CLI", () => {
  test("Commander help leads with the user journey", () => {
    const result = run(temp(), "--help");
    expect(result.exitCode).toBe(0);
    expect(output(result).stdout).toContain("init [options]");
    expect(output(result).stdout).toContain("render [options]");
    expect(output(result).stdout).toContain("install [options]");
  });

  test("init then fmt --check is a Bun-only journey", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const mod = join(root, "skill.mod");
    writeFileSync(mod, "skillful 1\nharness pi (\n token x \"one\"\n omit-skill b \"b\"\n omit-command a \"a\"\n)\n");
    const changed = run(root, "fmt", "--check");
    expect(changed.exitCode).toBe(1);
    expect(output(changed).stderr).toContain("not canonical");
    expect(run(root, "fmt").exitCode).toBe(0);
    expect(run(root, "fmt", "--check").exitCode).toBe(0);
    expect(readFileSync(mod, "utf8")).toContain("omit-command a");
  });

  test("unknown command options are usage errors", () => {
    const root = temp();
    const result = run(root, "fmt", "--harness", "pi");
    expect(result.exitCode).toBe(2);
    expect(output(result).stderr).toContain("unknown option");
  });

  test.skipIf(process.platform === "win32")("runtime failures without a recovery hint remain structured JSON errors", () => {
    const root = temp();
    const project = join(root, "project");
    const cache = join(root, "cache");
    cpSync(join(import.meta.dir, "..", "tests", "fixtures", "locked-project"), project, { recursive: true });
    const hash = readFileSync(join(project, "skill.lock"), "utf8").match(/sha256-[A-Za-z0-9+/]{43}=/)?.[0];
    if (!hash) throw new Error("locked fixture lost its NAR hash");
    const cacheEntry = join(cache, "skillful", cacheKey(hash));
    mkdirSync(cacheEntry, { recursive: true });
    const unsupported = join(cacheEntry, "unsupported");
    const fifo = Bun.spawnSync(["mkfifo", unsupported], { stdout: "pipe", stderr: "pipe" });
    if (fifo.exitCode !== 0) throw new Error(`cannot create FIFO fixture: ${new TextDecoder().decode(fifo.stderr)}`);

    const result = Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "manifest", "--project", project, "--format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_CACHE_HOME: cache },
    });
    const actual = output(result);
    expect(result.exitCode).toBe(1);
    expect(actual.stdout).toBe(`${JSON.stringify({ schemaVersion: 1, error: { code: "runtime", message: `unsupported filesystem kind for NAR: ${unsupported}`, hint: "Run `skillful --help` for supported commands." } })}\n`);
    expect(actual.stderr).toBe("");
  });
});
