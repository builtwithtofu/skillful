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
  test("root help orients humans and agents without a Nix story", () => {
    const result = run(temp(), "--help");
    const { stdout } = output(result);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Author agent skills once, render them per harness.");
    expect(stdout).toContain("skillful skills tree");
    expect(stdout).toContain("skillful <command> --help");
    expect(stdout).toContain("init [options]");
    expect(stdout).toContain("render [options]");
    expect(stdout).toContain("install [options]");
    expect(stdout.toLowerCase()).not.toContain("nix");

    const formatHelp = run(temp(), "list", "--help");
    expect(formatHelp.exitCode).toBe(0);
    expect(output(formatHelp).stdout).toContain("default: text");
    expect(output(formatHelp).stdout).not.toContain('default: "text"');
  });
  test("no-args help orients without treating help as a usage error", () => {
    const result = run(temp());
    const { stdout, stderr } = output(result);
    expect(result.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Author agent skills once, render them per harness.");
    expect(stderr).toContain("skillful skills tree");
    expect(stderr).not.toContain("(outputHelp)");
    expect(stderr).not.toContain("Error:");
  });

  test("skills help is not a synonym command", () => {
    const listed = run(temp(), "skills", "--help");
    expect(listed.exitCode).toBe(0);
    expect(output(listed).stdout).toContain("skillful skills tree");
    expect(output(listed).stdout).not.toContain("help [command]");

    const synonym = run(temp(), "skills", "help");
    const { stdout, stderr } = output(synonym);
    expect(synonym.exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("Error: unknown command 'help'\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");
  });

  test("skills tree lists legal topic names and show loads that topic", () => {
    const tree = run(temp(), "skills", "tree");
    expect(tree.exitCode).toBe(0);
    const treeText = output(tree).stdout;
    expect(treeText).toContain("core");
    expect(treeText).toContain("author");
    expect(treeText).toContain("mod");
    expect(treeText).toContain("deps");
    expect(treeText).toContain("inspect");
    expect(treeText).toContain("render");
    expect(treeText).toContain("skillful skills show <topic>");
    expect(treeText.toLowerCase()).not.toContain("nix");

    const shown = run(temp(), "skills", "show", "core");
    expect(shown.exitCode).toBe(0);
    const shownText = output(shown).stdout;
    expect(shownText).toContain("skillful guides › core");
    expect(shownText).toContain("next (`skillful skills show <topic>`):");
    expect(shownText).toContain("  author");
    expect(shownText.toLowerCase()).not.toContain("nix");

    const miss = run(temp(), "skills", "show", "lock");
    expect(miss.exitCode).toBe(1);
    expect(output(miss).stderr).toContain("unknown guide topic");
    expect(output(miss).stderr).toContain("skillful skills tree");
    expect(output(miss).stderr).toContain("author");
  });

  test("add help leads with inferred dependency choices", () => {
    const result = run(temp(), "add", "--help");
    const { stdout } = output(result);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("skillful add agent-browser");
    expect(stdout).toContain("default to @HEAD");
    expect(stdout).not.toContain("(default: [])");
    expect(stdout.toLowerCase()).not.toContain("nix");
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
    const unknown = run(root, "fmt", "--harness", "pi");
    expect(unknown.exitCode).toBe(2);
    expect(output(unknown).stderr).toBe("Error: unknown option '--harness'\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");

    const excess = run(root, "manifest", "extra", "args");
    expect(excess.exitCode).toBe(2);
    expect(output(excess).stderr).toBe("Error: too many arguments for 'manifest'. Expected 0 arguments but got 2: extra, args.\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");

    const json = run(root, "list", "skills", "--format", "json", "--nope");
    expect(json.exitCode).toBe(2);
    expect(output(json).stdout).toBe(`${JSON.stringify({ schemaVersion: 1, error: { code: "usage", message: "unknown option '--nope'", hint: "Run `skillful --help` or `skillful <command> --help`." } })}\n`);
    expect(output(json).stderr).toBe("");
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
