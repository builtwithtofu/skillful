import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cacheKey } from "./nar.ts";

const dirs: string[] = [];
const temp = () => { const dir = join(tmpdir(), `skillful-main-${crypto.randomUUID()}`); mkdirSync(dir); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const runIn = (cwd: string, home: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".state") } });
const output = (result: ReturnType<typeof run>) => ({ stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) });

describe("project CLI", () => {
  test("renders skillful 2 front-matter overrides before agent field filtering", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
    const skill = join(root, "vendor", "angular-developer");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: angular-developer\ndescription: Upstream\n---\n\nOriginal instructions.\n");
    writeFileSync(join(root, "description.txt"), "Angular guidance");
    writeFileSync(join(root, "skill.mod"), `skillful 2
use path:./vendor { angular-developer }
agents pi claude
angular-developer.description.append on pi = " Pi only."
angular-developer.description = ./description.txt
angular-developer.description.append = " Not for other frontends."
angular-developer.when_to_use = "On Angular projects"
`);
    expect(run(root, "fmt").exitCode).toBe(0);
    const result = run(root, "render");
    expect(result.exitCode, output(result).stderr).toBe(0);
    const rendered = (agent: string) => readFileSync(join(root, "rendered", agent, "skills", "angular-developer", "SKILL.md"), "utf8");
    expect(rendered("pi")).toContain("description: Angular guidance Not for other frontends. Pi only.\n");
    expect(rendered("claude")).toContain("description: Angular guidance Not for other frontends.\n");
    expect(rendered("claude")).toContain("when_to_use: On Angular projects");
    expect(rendered("pi")).not.toContain("when_to_use");
    expect(rendered("pi")).toEndWith("\n\nOriginal instructions.\n");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("description: Upstream");
  });

  test("check reports drift only for replaced upstream fields, including after updating", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const skill = join(root, "skills", "example", "SKILL.md");
    const upstream = (description: string, license: string) => writeFileSync(skill, `---\nname: example\ndescription: ${description}\nlicense: ${license}\n---\n\nBody.\n`);
    upstream("Original", "MIT");
    writeFileSync(join(root, "skill.mod"), `skillful 2
agents pi claude
example.description on pi = "Local wording"
example.license.append = " (see LICENSE)"
`);
    expect(run(root, "update").exitCode).toBe(0);
    upstream("Original", "Apache-2.0");
    expect(output(run(root, "check")).stdout).toBe("OK\n");
    upstream("Changed", "Apache-2.0");
    expect(run(root, "update").exitCode).toBe(0);
    const result = run(root, "check", "--strict", "--format", "json");
    expect(result.exitCode, output(result).stderr).toBe(1);
    expect(JSON.parse(output(result).stdout).warnings).toEqual([
      expect.objectContaining({ harness: "pi", skill: "example", message: expect.stringContaining("example.description") }),
    ]);
  });
  test("root help orients humans and agents without a Nix story", () => {
    const result = run(temp(), "--help");
    const { stdout } = output(result);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Author agent skills once, render them per harness.");
    expect(stdout).toContain("skillful skills tree");
    expect(stdout).toContain("skillful <command> --help");
    expect(stdout).toContain("A command is a saved prompt the person runs by name, separate from any skill");
    expect(stdout).toContain("init [options]");
    expect(stdout).toContain("render [options]");
    expect(stdout).toContain("install [options]");
    expect(stdout.toLowerCase()).not.toContain("nix");
    expect(stdout).toContain("--version");

    const formatHelp = run(temp(), "list", "--help");
    expect(formatHelp.exitCode).toBe(0);
    expect(output(formatHelp).stdout).toContain("default: text");
    expect(output(formatHelp).stdout).not.toContain('default: "text"');
  });

  test("prints the package version without discovering a project", () => {
    const result = run(temp(), "--version");
    expect(result.exitCode).toBe(0);
    expect(output(result).stdout).toBe("skillful 0.1.0\n");
    expect(output(result).stderr).toBe("");
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
    expect(treeText).toContain("setup");
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

  test("install help documents custom paths and rejects unknown categories", () => {
    const help = run(temp(), "install", "--help");
    expect(help.exitCode).toBe(0);
    expect(output(help).stdout).toContain("--path");
    expect(output(help).stdout).toContain("--remove");
    expect(output(help).stdout).toContain("skills=.config/opencode-v2/skills");
    expect(output(help).stdout).toContain("source overrides are ignored");
    expect(output(help).stdout.toLowerCase()).not.toContain("nix");

    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const unknown = run(root, "install", "--harness", "opencode", "--path", "tools=.config/tools");
    expect(unknown.exitCode).toBe(2);
    expect(output(unknown).stderr).toContain("unknown --path tools");
    const missing = run(root, "install");
    expect(missing.exitCode).toBe(2);
    expect(output(missing).stderr).toContain("setup name or --harness");
    const removeMissing = run(root, "install", "--remove");
    expect(removeMissing.exitCode).toBe(2);
    expect(output(removeMissing).stderr).toContain("needs a setup name");
    expect(run(root, "install", "old", "--remove", "--harness", "pi").exitCode).toBe(2);
    expect(run(root, "install", "old", "--remove", "--path", "skills=.old").exitCode).toBe(2);
    const malformedOverride = run(root, "install", "old", "--remove", "--override", "typo");
    expect(malformedOverride.exitCode).toBe(2);
    expect(output(malformedOverride).stderr).toContain("expects name=path");
    const duplicateOverride = run(root, "install", "old", "--remove", "--override", "dep=one", "--override", "dep=two");
    expect(duplicateOverride.exitCode).toBe(2);
    expect(output(duplicateOverride).stderr).toContain("duplicate --override name");

  });
  test("lists, shows, renders, installs, and removes a named setup", () => {
    const root = temp();
    const project = join(root, "project");
    const home = join(root, "home");
    mkdirSync(home);
    expect(run(root, "init", "--dir", project).exitCode).toBe(0);
    const mod = join(project, "skill.mod");
    writeFileSync(mod, `${readFileSync(mod, "utf8").trimEnd()}

setup personal (
  omit-skill hidden "Not personal."
  pi claude
)

setup work-mac (
  pi

  claude (
    skills .claude2/skills
  )
)
`);

    const listed = runIn(root, home, "list", "setups", "--project", project);
    expect(listed.exitCode).toBe(0);
    expect(output(listed).stdout).toBe("personal\nwork-mac\n");
    const shown = runIn(root, home, "setup", "show", "work-mac", "--project", project, "--format", "json");
    expect(shown.exitCode).toBe(0);
    const shownValue = JSON.parse(output(shown).stdout) as { setup: { harnesses: Array<{ name: string }>; files: Record<string, { harness: string }> } };
    expect(shownValue.setup.harnesses.map((harness) => harness.name)).toEqual(["pi", "claude"]);
    expect(shownValue.setup.files[".claude2/skills/example/SKILL.md"]?.harness).toBe("claude");

    expect(runIn(root, home, "install", "personal", "--project", project, "--root", home).exitCode).toBe(0);
    const installedSkill = join(home, ".pi", "agent", "skills", "example", "SKILL.md");
    expect(existsSync(installedSkill)).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "skills", "hidden", "SKILL.md"))).toBe(false);

    writeFileSync(mod, readFileSync(mod, "utf8").replace(/\nsetup personal \([\s\S]*?\n\)\n/, "\n"));
    const forcedRemoval = runIn(root, home, "install", "personal", "--remove", "--force", "--project", project, "--root", home);
    expect(forcedRemoval.exitCode).toBe(2);
    expect(output(forcedRemoval).stderr).toContain("cannot mix with --force");
    expect(runIn(root, home, "install", "personal", "--remove", "--override", "wrapper-source=../source", "--project", project, "--root", home).exitCode).toBe(0);
    expect(existsSync(installedSkill)).toBe(false);

    expect(runIn(root, home, "render", "work-mac", "--project", project).exitCode).toBe(0);
    expect(existsSync(join(project, "rendered", "claude", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "opencode"))).toBe(false);
    expect(runIn(root, home, "install", "work-mac", "--harness", "pi", "--project", project).exitCode).toBe(2);
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

  test("migrate rewrites skill.mod in place without changing delivered files or skill.lock", () => {
    const root = temp();
    const project = join(root, "agent");
    expect(run(root, "init", "--dir", project).exitCode).toBe(0);
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example guidance\n---\n\nLocal body\n");
    for (const name of ["external", "unused"]) {
      const dir = join(project, "vendor", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} guidance\n---\n\nBody\n`);
    }
    const mod = join(project, "skill.mod");
    writeFileSync(mod, `// Header
skillful 1

require path:./vendor as vendor (
  // Selected from vendor
  only external
)

harness claude (
  omit-skill external "Only for Pi."
)
harness pi (
)
setup laptop (
  omit-skill external "Not needed on laptop."
  pi claude
)
`);
    const lock = join(project, "skill.lock");
    const originalLock = "\n";
    writeFileSync(lock, originalLock);
    for (const setup of [[], ["laptop"]]) {
      const result = run(project, "render", ...setup, "--out", join(root, `before-${setup.join()}`));
      expect(output(result).stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    const migrated = run(root, "migrate", "--project", project);
    expect(output(migrated).stderr).toBe("");
    expect(migrated.exitCode).toBe(0);
    const text = readFileSync(mod, "utf8");
    expect(text).toStartWith("// Header\nskillful 2\n");
    expect(text).toContain("use path:./vendor { external }");
    expect(text).toContain("// Selected from vendor");
    expect(readFileSync(lock, "utf8")).toBe(originalLock);
    expect(run(project, "fmt", "--check").exitCode).toBe(0);
    expect(run(project, "migrate").exitCode).toBe(0);
    expect(readFileSync(mod, "utf8")).toBe(text);
    for (const setup of [[], ["laptop"]]) {
      const after = join(root, `after-${setup.join()}`);
      const result = run(project, "render", ...setup, "--out", after);
      expect(output(result).stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const before = join(root, `before-${setup.join()}`);
      const diff = Bun.spawnSync(["diff", "-r", "-x", ".skillful", before, after]);
      expect(output(diff).stdout).toBe("");
      expect(diff.exitCode).toBe(0);
    }
  });

  test.each(["all", "exclude", "split"])("migrate preserves dependency selections: %s", (selection) => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), "Example body.\n");
    for (const name of ["one", "two"]) {
      const dir = join(root, "vendor", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `${name} body.\n`);
    }
    const requires = selection === "split"
      ? "require path:./vendor as first (\n  only one\n)\nrequire path:./vendor as second (\n  only two\n)\n"
      : `require path:./vendor as vendor${selection === "exclude" ? " (\n  exclude two\n)" : ""}\n`;
    writeFileSync(join(root, "skill.mod"), `skillful 1\nharness pi (\n)\n${requires}`);
    const skills = () => {
      const result = run(root, "manifest", "--format", "json");
      expect(result.exitCode, output(result).stderr).toBe(0);
      return JSON.parse(output(result).stdout).harnesses.pi.skills.map(({ name, body }: { name: string; body: string }) => [name, body]);
    };
    const before = skills();
    const migrated = run(root, "migrate");
    expect(migrated.exitCode, output(migrated).stderr).toBe(0);
    expect(skills()).toEqual(before);
  });

  test("migrate leaves a renderable project when a harness omits a retired skill", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), "Example body.\n");
    writeFileSync(join(root, "skill.mod"), 'skillful 1\nharness pi (\n  omit-skill retired "Removed upstream"\n)\n');
    expect(run(root, "render", "--dry-run").exitCode).toBe(0);
    expect(run(root, "migrate").exitCode).toBe(0);
    const result = run(root, "render", "--dry-run");
    expect(result.exitCode, output(result).stderr).toBe(0);
  });
  test("migrate leaves a manifest alone when it cannot translate a render setting", () => {
    const project = temp();
    const mod = join(project, "skill.mod");
    const original = 'skillful 1\nharness pi (\n  token tool "run"\n)\n';
    writeFileSync(mod, original);
    const result = run(project, "migrate");
    expect(result.exitCode).toBe(1);
    expect(output(result).stderr).toContain("cannot migrate tokens for pi");
    expect(readFileSync(mod, "utf8")).toBe(original);
  });

  test("fmt canonicalizes skillful 2 without changing its version or losing the description line", () => {
    const root = temp();
    const mod = join(root, "skill.mod");
    const original = `// Project
skillful   2
machine work
  agents     claude pi
local   ./my-skills "./my commands"
rules ./rules.md
// Upstream skills
use git:https://example.invalid/tool.git@main#skills{tool}
use github:angular/skills@main { angular-developer  angular-new-app }
angular-developer.description="Custom description."
skip angular-new-app   on  pi  "Only use \\"Claude\\"."
machine personal  skip    tool
`;
    writeFileSync(mod, original);
    expect(run(root, "fmt", "--check").exitCode).toBe(1);
    expect(readFileSync(mod, "utf8")).toBe(original);
    expect(run(root, "fmt").exitCode).toBe(0);
    expect(readFileSync(mod, "utf8")).toBe(`// Project
skillful 2

local ./my-skills "./my commands"
rules ./rules.md

// Upstream skills
use git:https://example.invalid/tool.git@main#skills { tool }
use github:angular/skills@main { angular-developer angular-new-app }

angular-developer.description = "Custom description."

agents claude pi

skip angular-new-app on pi "Only use \\"Claude\\"."

machine work
machine personal skip tool
`);
    expect(run(root, "fmt", "--check").exitCode).toBe(0);
  });

  test("skillful 2 delivers the same files as skillful 1 with agent and machine skips", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    renameSync(join(root, "skills"), join(root, "local-skills"));
    const example = join(root, "local-skills", "example", "SKILL.md");
    writeFileSync(example, readFileSync(example, "utf8").replace("{{audience}}", "each agent"));
    renameSync(join(root, "commands"), join(root, "prompts"));
    renameSync(join(root, "rules", "global_agents.md"), join(root, "rules.md"));
    for (const name of ["foreign", "unselected"]) {
      const skill = join(root, "upstream", name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: From the dependency.\n---\n`);
    }
    const mod = join(root, "skill.mod");
    writeFileSync(mod, `skillful 1
skills ./local-skills
commands ./prompts
rules ./rules.md
require path:./upstream as dep (
  only foreign
)
harness claude (
  omit-skill hidden "Pi only."
)
harness pi (
)
setup work (
  claude pi
)
setup personal (
  omit-skill foreign "Work only."
  omit-skill example "Work only."
  claude pi
)
`);
    const targets = [[], ["work"], ["personal"]];
    for (const [i, args] of targets.entries()) {
      const result = run(root, "render", ...args, "--out", `v1-${i}`);
      expect(result.exitCode, output(result).stderr).toBe(0);
    }
    writeFileSync(mod, `skillful 2
local ./local-skills ./prompts
rules ./rules.md
use path:./upstream { foreign }
agents claude pi
skip hidden on claude "Pi only."
machine work
machine personal skip foreign example
`);
    const delivered = (dir: string) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.parentPath.endsWith(".skillful"))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [relative(dir, path), readFileSync(path)];
      }));
    for (const [i, args] of targets.entries()) {
      const result = run(root, "render", ...args, "--out", `v2-${i}`);
      expect(result.exitCode, output(result).stderr).toBe(0);
      const before = join(root, `v1-${i}`);
      const after = join(root, `v2-${i}`);
      expect(delivered(after)).toEqual(delivered(before));
    }
  });

  test.each([
    ["bogus value", 'unknown directive "bogus"'],
    ["agents claude imaginary", 'unknown agent "imaginary"'],
    ['skip example on imaginary "reason"', 'unknown agent "imaginary"'],
    ["use path:./commands { example }", "unknown skill example in use"],
    ['skip missing on pi "reason"', "unknown skill missing in skip"],
    ["machine laptop skip missing", "unknown skill missing in machine laptop"],
    ['missing.description = "value"', "unknown skill missing in front-matter override"],
  ])("skillful 2 reports the line for %s", (directive, message) => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skill.mod"), `skillful 2\n\n${directive}\n${directive.startsWith("agents ") ? "" : "agents pi\n"}`);
    const result = run(root, "render");
    expect(result.exitCode).toBe(1);
    expect(output(result).stderr).toMatch(/skill\.mod:3:\d+:/);
    expect(output(result).stderr).toContain(message);
    expect(existsSync(join(root, "rendered"))).toBe(false);
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
    const project = join(import.meta.dir, "..", "tests", "fixtures", "locked-project");
    const cache = join(root, "cache");
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
