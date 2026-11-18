import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cacheKey, narHash } from "./nar.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const dirs: string[] = [];
const temp = () => { const dir = join(tmpdir(), `skillful-main-${crypto.randomUUID()}`); mkdirSync(dir); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const runIn = (cwd: string, home: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".state") } });
const output = (result: ReturnType<typeof run>) => ({ stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) });

function piClaudeRenderFiles(dir: string) {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.endsWith(".skillful"))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const name = relative(dir, path).replaceAll("\\", "/")
        .replace(/^\.claude\//, "claude/").replace(/^\.pi\/agent\//, "pi/");
      return [name, readFileSync(path)];
    }));
}

describe("project CLI", () => {
  function machineFixture() {
    const project = temp();
    expect(run(project, "init").exitCode).toBe(0);
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\nDefault body.\n");
    const header = "skillful 2\nagents codex pi\nmachine desk\n";
    const mod = join(project, "skill.mod");
    const split = () => writeFileSync(mod, header + 'example.body on pi = "Pi instructions."\n');
    writeFileSync(mod, header);
    return { project, home: temp(), split };
  }

  test("install picks the short hostname and a named machine overrides it", () => {
    const { project, home } = machineFixture();
    const host = hostname().toLowerCase().split(".")[0]!;
    const other = host === "desk" ? "laptop" : "desk";
    writeFileSync(join(project, "skill.mod"), `skillful 2\nagents claude\nmachine ${host}\nmachine ${other} skip example\n`);
    const named = runIn(project, home, "install", other, "--dry-run");
    expect(named.exitCode, output(named).stderr).toBe(0);
    expect(output(named).stdout).not.toContain(".claude/skills/example/SKILL.md");
    const automatic = runIn(project, home, "install");
    expect(automatic.exitCode, output(automatic).stderr).toBe(0);
    expect(readFileSync(join(home, ".claude/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
  });

  test("a four-line skill.mod checks and installs without local sources", () => {
    const root = temp();
    const project = join(root, "project");
    const source = join(root, "source");
    const home = temp();
    mkdirSync(join(root, ".git"));
    mkdirSync(project);
    mkdirSync(join(source, "example"), { recursive: true });
    writeFileSync(join(source, "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\nImported body.\n");
    const mod = join(project, "skill.mod");
    writeFileSync(mod, `skillful 2\nuse path:${relative(project, source)} { example }\nagents claude pi codex\nmachine laptop\n`);
    for (const args of [["check"], ["install", "laptop"], ["fmt"], ["check"]]) {
      const result = runIn(project, home, ...args);
      expect(result.exitCode, output(result).stderr).toBe(0);
    }
    for (const agent of [".claude", ".agents"]) {
      expect(readFileSync(join(home, agent, "skills/example/SKILL.md"), "utf8")).toContain("Imported body.");
    }
    expect(existsSync(join(home, ".claude/CLAUDE.md"))).toBe(false);
    expect(readdirSync(project)).toEqual(["skill.mod"]);
  });

  test.each([
    ["local ./skills ./commands", "directory path does not exist: ./commands"],
    ["rules ./rules/global_agents.md", "file path does not exist: ./rules/global_agents.md"],
  ])("check requires explicitly declared sources: %s", (directive, message) => {
    const project = temp();
    mkdirSync(join(project, "skills"));
    writeFileSync(join(project, "skill.mod"), `skillful 2\n${directive}\nagents claude\nmachine laptop\n`);
    const result = run(project, "check");
    expect(result.exitCode).not.toBe(0);
    expect(output(result).stderr).toContain(message);
  });

  test("harness paths merge by field, including for a new agent", () => {
    const { project, home } = machineFixture();
    const mod = join(project, "skill.mod");
    writeFileSync(join(project, "commands", "prompt.md"), "Run the prompt.\n");
    writeFileSync(join(project, "rules", "global_agents.md"), "House rules.\n");
    writeFileSync(mod, `skillful 2
agents claude cursor local-agent
harness local-agent { skills ".local/custom skills" commands .local/prompts rules .local/GENERAL.md }
machine desk
machine work {
  harness local-agent {
    // Work instructions are different.
    rules .local/WORK.md
  }
  skip example
}
`);
    const formatted = run(project, "fmt");
    expect(formatted.exitCode, output(formatted).stderr).toBe(0);
    expect(readFileSync(mod, "utf8")).toContain("// Work instructions are different.");
    expect(run(project, "fmt", "--check").exitCode).toBe(0);
    const desk = runIn(project, home, "install", "desk");
    expect(desk.exitCode, output(desk).stderr).toBe(0);
    expect(readFileSync(join(home, ".local/custom skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    expect(readFileSync(join(home, ".local/prompts/prompt.md"), "utf8")).toContain("Run the prompt.");
    expect(readFileSync(join(home, ".local/GENERAL.md"), "utf8")).toBe("House rules.\n");
    expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe("House rules.\n");
    expect(readFileSync(join(home, ".cursor/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    expect(existsSync(join(home, ".cursor/rules"))).toBe(false);
    const workHome = temp();
    const work = runIn(project, workHome, "install", "work");
    expect(work.exitCode, output(work).stderr).toBe(0);
    expect(existsSync(join(workHome, ".local/custom skills/example/SKILL.md"))).toBe(false);
    expect(existsSync(join(workHome, ".local/GENERAL.md"))).toBe(false);
    expect(readFileSync(join(workHome, ".local/WORK.md"), "utf8")).toBe("House rules.\n");
    expect(readFileSync(join(workHome, ".local/prompts/prompt.md"), "utf8")).toContain("Run the prompt.");
  });

  test("a machine can define an agent that opts into shared skills", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 2
agents pi local-agent
machine desk {
  harness local-agent { skills .local/skills reads-shared }
}
`);
    const result = runIn(project, home, "install", "desk");
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(readFileSync(join(home, ".agents/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    expect(existsSync(join(home, ".local/skills/example/SKILL.md"))).toBe(false);
    expect(existsSync(join(home, ".pi/agent/skills/example/SKILL.md"))).toBe(false);
  });

  test("check accepts an agent whose skills path is declared on the machine", () => {
    const { project } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 2
agents pi editor
harness editor { reads-shared }
machine desk {
  harness editor { skills .editor/skills }
}
`);
    for (const args of [[], ["--harness", "editor"], ["--harness", "pi"]]) {
      const result = run(project, "check", ...args);
      expect(result.exitCode, output(result).stderr).toBe(0);
      expect(output(result).stdout.trim()).toBe("OK");
    }
  });

  test("render and inspect accept a declared custom harness", () => {
    const { project } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 2
agents pi editor
harness editor { skills .editor/skills }
machine desk
`);
    const rendered = run(project, "render", "--harness", "editor");
    expect(rendered.exitCode, output(rendered).stderr).toBe(0);
    expect(readFileSync(join(project, "rendered/.harness-editor/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    const inspected = run(project, "inspect", "example", "--harness", "editor");
    expect(inspected.exitCode, output(inspected).stderr).toBe(0);
    expect(output(inspected).stdout).toContain("editor: included");
  });

  test("a renderer fence selects only its declared custom harness", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi editor\nharness editor { skills .editor/skills }\nmachine desk\n");
    writeFileSync(join(project, "skills/example/SKILL.md"), "---\nname: example\ndescription: Example\n---\nDefault body.\n{{#editor}}\nEditor only.\n{{/}}\n");
    const checked = run(project, "check", "--harness", "pi");
    expect(checked.exitCode, output(checked).stderr).toBe(0);
    const installed = runIn(project, home, "install", "desk");
    expect(installed.exitCode, output(installed).stderr).toBe(0);
    expect(readFileSync(join(home, ".editor/skills/example/SKILL.md"), "utf8")).toContain("Editor only.");
    expect(readFileSync(join(home, ".pi/agent/skills/example/SKILL.md"), "utf8")).not.toContain("Editor only.");
  });

  test("unused rules paths do not prevent a machine install", () => {
    const { project, home } = machineFixture();
    rmSync(join(project, "rules"), { recursive: true });
    writeFileSync(join(project, "skill.mod"), `skillful 2
agents pi editor
harness editor { skills .editor/skills rules .pi/agent/AGENTS.md }
machine desk
`);
    const install = () => runIn(project, home, "install", "desk");
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(existsSync(join(home, ".editor/skills/example/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".pi/agent/skills/example/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".pi/agent/AGENTS.md"))).toBe(false);
    const shown = run(project, "setup", "show", "desk");
    expect(shown.exitCode, output(shown).stderr).toBe(0);
    expect(output(shown).stdout).not.toContain("rules=");
    mkdirSync(join(project, "rules"));
    writeFileSync(join(project, "rules/global_agents.md"), "Rules.\n");
    expect(output(install()).stderr).toContain("overlapping destinations");
  });

  test("changing skip to an equivalent only keeps the existing shared skill", () => {
    const { project, home } = machineFixture();
    const header = "skillful 2\nagents claude codex pi\nmachine desk\n";
    const manifest = join(project, "skill.mod");
    const install = () => runIn(project, home, "install", "desk");
    writeFileSync(manifest, header + 'skip example on claude "For shared readers."\n');
    expect(install().exitCode).toBe(0);
    expect(existsSync(join(home, ".agents/skills/example/SKILL.md"))).toBe(true);
    writeFileSync(manifest, header + 'only example on codex pi "For shared readers."\n');
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(output(result).stdout).toContain("0 add, 0 change, 0 delete");
  });

  test.each(["pi", "pi codex"])("a machine takes over the earlier one-agent install: %s", (agents) => {
    const { project, home } = machineFixture();
    const manifest = join(project, "skill.mod");
    const prior = join(home, ".pi/agent/skills/example/SKILL.md");
    writeFileSync(manifest, "skillful 1\nharness pi (\n)\n");
    expect(runIn(project, home, "install", "--harness", "pi").exitCode).toBe(0);
    const body = readFileSync(prior, "utf8");
    writeFileSync(manifest, `skillful 2\nagents ${agents}\nmachine desk\n`);
    const install = () => runIn(project, home, "install", "desk");
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    if (agents.includes("codex")) {
      expect(readFileSync(join(home, ".agents/skills/example/SKILL.md"), "utf8")).toBe(body);
      expect(existsSync(prior)).toBe(false);
    } else expect(readFileSync(prior, "utf8")).toBe(body);
    expect(output(install()).stdout).toContain("0 add, 0 change, 0 delete");
  });

  test.each(["harness codex", "setup work"])("a private install refuses a shared copy owned by %s", (owner) => {
    const { project, home } = machineFixture();
    const manifest = join(project, "skill.mod");
    if (owner === "harness codex") {
      writeFileSync(manifest, "skillful 1\nharness codex (\n)\n");
      expect(runIn(project, home, "install", "--harness", "codex").exitCode).toBe(0);
      writeFileSync(manifest, "skillful 2\nagents pi\nmachine desk\n");
    } else {
      writeFileSync(manifest, "skillful 2\nagents pi editor\nharness editor { skills .editor/skills }\nmachine desk\nmachine work {\n  harness editor { reads-shared }\n}\n");
      rmSync(join(project, "commands"), { recursive: true });
      rmSync(join(project, "rules"), { recursive: true });
      expect(runIn(project, home, "install", "work").exitCode).toBe(0);
    }
    const shared = join(home, ".agents/skills/example/SKILL.md");
    expect(existsSync(shared)).toBe(true);
    const result = runIn(project, home, "install", "desk", "--force");
    expect(result.exitCode, output(result).stderr).toBe(1);
    expect(output(result).stderr).toContain(owner);
    expect(output(result).stderr).toContain(".agents/skills/example/SKILL.md");
    expect(existsSync(shared)).toBe(true);
    expect(existsSync(join(home, ".pi/agent/skills/example/SKILL.md"))).toBe(false);
  });

  test("a shared install refuses a private copy owned by another machine", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi editor\nharness editor { skills .editor/skills }\nmachine desk\nmachine work {\n  harness editor { reads-shared }\n}\n");
    rmSync(join(project, "commands"), { recursive: true });
    rmSync(join(project, "rules"), { recursive: true });
    const desk = runIn(project, home, "install", "desk");
    expect(desk.exitCode, output(desk).stderr).toBe(0);
    const work = runIn(project, home, "install", "work", "--force");
    expect(work.exitCode, output(work).stderr).toBe(1);
    expect(output(work).stderr).toContain("skillful install desk --remove --root ");
    expect(output(work).stderr).toContain("skills/example/SKILL.md");
    expect(existsSync(join(home, ".pi/agent/skills/example/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".agents/skills/example/SKILL.md"))).toBe(false);
  });
  test("migrate treats the explicit v1 Codex default as the shared destination", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1
harness codex (
)
harness pi (
)
setup desk (
  pi
  codex (
    skills .agents/skills
  )
)
`);
    const install = () => runIn(project, home, "install", "desk");
    expect(install().exitCode).toBe(0);
    expect(run(project, "migrate").exitCode).toBe(0);
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(existsSync(join(home, ".agents/skills/example/SKILL.md"))).toBe(true);
    for (const root of [".pi/agent", ".codex"]) expect(existsSync(join(home, root, "skills/example/SKILL.md"))).toBe(false);
  });
  test("migrate treats Pi's explicit shared skills path as shared", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1
harness codex (
)
harness pi (
)
setup desk (
  pi (
    skills .agents/skills
  )
  codex (
    skills .work/skills
  )
)
`);
    const install = () => runIn(project, home, "install", "desk");
    const before = install();
    expect(before.exitCode, output(before).stderr).toBe(0);
    expect(existsSync(join(home, ".work/skills/example/SKILL.md"))).toBe(true);
    expect(run(project, "migrate").exitCode).toBe(0);
    const after = install();
    expect(after.exitCode, output(after).stderr).toBe(0);
    expect(existsSync(join(home, ".agents/skills/example/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".work/skills/example/SKILL.md"))).toBe(false);
  });
  test("migrate keeps a machine's install path override", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1
harness pi (
)
setup desk (
  pi (
    skills .work/skills
  )
)
`);
    const install = () => runIn(project, home, "install", "desk");
    expect(install().exitCode).toBe(0);
    expect(run(project, "migrate").exitCode).toBe(0);
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(output(result).stdout).toContain("0 add, 0 change, 0 delete");
    expect(readFileSync(join(home, ".work/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
  });

  test("refreshing Pi retains the delivery of a machine-defined shared reader", () => {
    const { project } = machineFixture();
    writeFileSync(join(project, "skill.mod"), `skillful 2
agents pi editor
harness editor { skills .editor/skills }
machine desk {
  harness editor { reads-shared }
}
`);
    expect(run(project, "render", "desk").exitCode).toBe(0);
    const rendered = run(project, "render", "--harness", "pi");
    expect(rendered.exitCode, output(rendered).stderr).toBe(0);
    const root = join(project, "rendered");
    const { manifest } = JSON.parse(readFileSync(join(root, "editor/.skillful/contract.json"), "utf8"));
    const skill = manifest.harnesses.editor.skills.find((item: { name: string }) => item.name === "example");
    expect(readFileSync(join(root, skill.delivery.path), "utf8")).toContain("Default body.");
  });

  test("a partial render cannot strand a former shared reader's delivery", () => {
    const { project } = machineFixture();
    const manifest = join(project, "skill.mod");
    const header = "skillful 2\nagents pi editor\nharness editor { skills .editor/skills }\n";
    writeFileSync(manifest, header + "machine desk {\n  harness editor { reads-shared }\n}\n");
    expect(run(project, "render", "desk").exitCode).toBe(0);
    writeFileSync(manifest, header + "machine desk\n");
    const result = run(project, "render", "--harness", "pi");
    expect(result.exitCode, output(result).stderr).toBe(1);
    expect(output(result).stderr).toContain("skillful render desk");
    const root = join(project, "rendered");
    const { manifest: contract } = JSON.parse(readFileSync(join(root, "editor/.skillful/contract.json"), "utf8"));
    expect(readFileSync(join(root, contract.harnesses.editor.skills[0].delivery.path), "utf8")).toContain("Default body.");
    expect(run(project, "render", "desk").exitCode).toBe(0);
    expect(existsSync(join(root, ".harness-editor/skills/example/SKILL.md"))).toBe(true);
  });
  test("install lists declared machines when the hostname does not match", () => {
    const { project, home } = machineFixture();
    const host = hostname().toLowerCase().split(".")[0];
    const machines = ["desk", "laptop", "work"].filter((name) => name !== host).slice(0, 2);
    writeFileSync(join(project, "skill.mod"), `skillful 2\nagents claude\n${machines.map((name) => `machine ${name}\n`).join("")}`);
    const result = runIn(project, home, "install");
    expect(result.exitCode).toBe(2);
    expect(output(result).stderr).toContain(`Declared machines: ${machines.join(", ")}.`);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("skillful 2 install rejects --harness", () => {
    const { project, home } = machineFixture();
    const result = runIn(project, home, "install", "--harness", "pi");
    expect(result.exitCode).toBe(2);
    expect(output(result).stderr).toContain("skillful 2 install does not accept --harness");
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });

  test("install moves an only skill out of shared storage and delivers it only to the named agents", () => {
    const { project, home } = machineFixture();
    const manifest = join(project, "skill.mod");
    const shared = join(home, ".agents/skills/example/SKILL.md");
    const baseline = runIn(project, home, "install", "desk");
    expect(baseline.exitCode, output(baseline).stderr).toBe(0);
    expect(existsSync(shared)).toBe(true);

    writeFileSync(manifest, 'skillful 2\nagents claude codex pi\nmachine desk\nonly example on pi "Uses Pi tools."\n');
    const formatted = run(project, "fmt");
    expect(formatted.exitCode, output(formatted).stderr).toBe(0);
    expect(readFileSync(manifest, "utf8")).toContain('only example on pi "Uses Pi tools."');
    const installed = runIn(project, home, "install", "desk");
    expect(installed.exitCode, output(installed).stderr).toBe(0);
    expect(readFileSync(join(home, ".pi/agent/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    expect(existsSync(shared)).toBe(false);
    expect(existsSync(join(home, ".codex/skills/example/SKILL.md"))).toBe(false);
    expect(existsSync(join(home, ".claude/skills/example/SKILL.md"))).toBe(false);
  });

  test("a Pi-only machine moves formerly shared skills into Pi's own folder", () => {
    const { project, home } = machineFixture();
    const install = () => runIn(project, home, "install", "desk");
    const shared = join(home, ".agents/skills");
    expect(install().exitCode).toBe(0);
    expect(existsSync(join(shared, "example/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".pi/agent/skills/example"))).toBe(false);
    expect(existsSync(join(home, ".codex/skills/example"))).toBe(false);

    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\nmachine desk\n");
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(existsSync(shared)).toBe(false);
    expect(readFileSync(join(home, ".pi/agent/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
  });

  test("render and install honor a skip for a shared reader outside the agents list", () => {
    const { project, home } = machineFixture();
    writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents pi\nskip example on codex "Pi only."\nmachine desk\n');
    const rendered = run(project, "render", "--harness", "pi");
    expect(rendered.exitCode, output(rendered).stderr).toBe(0);
    const installed = runIn(project, home, "install", "desk", "--root", home);
    expect(installed.exitCode, output(installed).stderr).toBe(0);
    for (const root of [join(project, "rendered"), home]) {
      expect(existsSync(join(root, ".agents/skills/example/SKILL.md"))).toBe(false);
      expect(readFileSync(join(root, ".pi/agent/skills/example/SKILL.md"), "utf8")).toContain("Default body.");
    }
  });

  test("incompatible front matter gets the same private placement with LF or CRLF", () => {
    const { project, home } = machineFixture();
    const source = "---\nname: example\ndescription: Example\ndisable-model-invocation: true\n---\nDefault body.\n";
    for (const newline of ["\n", "\r\n"]) {
      writeFileSync(join(project, "skills/example/SKILL.md"), source.replaceAll("\n", newline));
      const rendered = run(project, "render", "desk");
      expect(rendered.exitCode, output(rendered).stderr).toBe(0);
      const installed = runIn(project, home, "install", "desk", "--root", home);
      expect(installed.exitCode, output(installed).stderr).toBe(0);
      for (const root of [join(project, "rendered"), home]) {
        expect(existsSync(join(root, ".agents/skills/example/SKILL.md")), JSON.stringify(newline)).toBe(false);
        expect(readFileSync(join(root, ".pi/agent/skills/example/SKILL.md"), "utf8")).toContain("disable-model-invocation: true");
        expect(readFileSync(join(root, ".codex/skills/example/SKILL.md"), "utf8")).not.toContain("disable-model-invocation");
      }
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed skill split leaves the shared install intact and can be retried", () => {
    const { project, home, split } = machineFixture();
    const install = () => runIn(project, home, "install", "desk", "--root", home);
    expect(install().exitCode).toBe(0);
    split();
    const shared = join(home, ".agents/skills/example/SKILL.md");
    const codex = join(home, ".codex/skills/example/SKILL.md");
    const pi = join(home, ".pi/agent/skills/example/SKILL.md");
    const readOnly = join(home, ".pi/agent");
    chmodSync(readOnly, 0o555);
    try {
      const failure = install();
      expect(failure.exitCode).not.toBe(0);
      expect(readFileSync(shared, "utf8")).toContain("Default body.");
      expect(existsSync(codex)).toBe(false);
      expect(existsSync(pi)).toBe(false);
    } finally { chmodSync(readOnly, 0o755); }
    const retry = install();
    expect(retry.exitCode, output(retry).stderr).toBe(0);
    expect(existsSync(shared)).toBe(false);
    expect(existsSync(codex)).toBe(true);
    expect(existsSync(pi)).toBe(true);
  });

  test("a long reference filename survives a shared-to-private install", () => {
    const { project, home, split } = machineFixture();
    const path = `references/${"r".repeat(220)}.md`;
    writeFileSync(join(project, "skills/example", path), "Reference.\n");
    const install = () => runIn(project, home, "install", "desk");
    const baseline = install();
    expect(baseline.exitCode, output(baseline).stderr).toBe(0);
    expect(readFileSync(join(home, ".agents/skills/example", path), "utf8")).toBe("Reference.\n");
    split();
    const result = install();
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(existsSync(join(home, ".agents/skills/example", path))).toBe(false);
    expect(readFileSync(join(home, ".pi/agent/skills/example", path), "utf8")).toBe("Reference.\n");
  });
  test.skipIf(process.platform === "win32")("restarts a shared-to-private move interrupted after a rename", async () => {
    const { project, home } = machineFixture();
    const references = join(project, "skills/example/references");
    for (let i = 0; i < 300; i++) writeFileSync(join(references, `ref-${i}.md`), `Reference ${i}\n`);
    const install = () => runIn(project, home, "install", "desk");
    expect(install().exitCode).toBe(0);
    const shared = join(home, ".agents/skills/example/SKILL.md");
    writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents codex pi\nmachine desk\nonly example on pi "Pi only."\n');
    const child = Bun.spawn(["bun", join(import.meta.dir, "main.ts"), "install", "desk"], {
      cwd: project, stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".state") },
    });
    const deadline = Date.now() + 5000;
    while (existsSync(shared) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(1);
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(shared)).toBe(false);
    const lock = readdirSync(home).find((name) => name.startsWith(".skillful-install-") && name.endsWith(".lock"));
    expect(lock).toBeDefined();
    rmSync(join(home, lock!), { recursive: true });
    const retry = install();
    expect(retry.exitCode, output(retry).stderr).toBe(0);
    expect(existsSync(join(home, ".agents/skills/example"))).toBe(false);
    expect(readFileSync(join(home, ".pi/agent/skills/example/references/ref-299.md"), "utf8")).toBe("Reference 299\n");
    expect(output(install()).stdout).toContain("0 add, 0 change, 0 delete");
  });
  test("a machine render contract points at the shared and private installed files", () => {
    const { project, home, split } = machineFixture();
    for (const [codex, pi] of [[".agents/skills", ".agents/skills"], [".codex/skills", ".pi/agent/skills"]]) {
      expect(run(project, "render", "desk").exitCode).toBe(0);
      expect(runIn(project, home, "install", "desk", "--root", home).exitCode).toBe(0);
      const { manifest } = JSON.parse(readFileSync(join(project, "rendered/codex/.skillful/contract.json"), "utf8"));
      for (const [id, root] of [["codex", codex], ["pi", pi]]) {
        const skill = manifest.harnesses[id!].skills.find((item: { name: string }) => item.name === "example");
        expect(skill.delivery.path).toBe(`${root}/example/SKILL.md`);
        expect(existsSync(join(home, skill.delivery.path))).toBe(true);
        expect(skill.supportFiles[0].delivery.path).toBe(`${root}/example/references/guide.md`);
        expect(existsSync(join(home, skill.supportFiles[0].delivery.path))).toBe(true);
      }
      split();
    }
  });

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
    const rendered = (folder: string) => readFileSync(join(root, "rendered", folder, "skills", "angular-developer", "SKILL.md"), "utf8");
    expect(rendered(".pi/agent")).toContain("description: Angular guidance Not for other frontends. Pi only.\n");
    expect(rendered(".claude")).toContain("description: Angular guidance Not for other frontends.\n");
    expect(rendered(".claude")).toContain("when_to_use: On Angular projects");
    expect(rendered(".pi/agent")).not.toContain("when_to_use");
    expect(rendered(".pi/agent")).toEndWith("\n\nOriginal instructions.\n");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("description: Upstream");
  });

  test("renders the ketchup passage override and rejects missing or repeated text at the locked revision", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---");
    const source = temp();
    mkdirSync(join(source, "ketchup"));
    const passage = "Draw a Mermaid diagram of the flow.";
    writeFileSync(join(source, "ketchup", "SKILL.md"), `---\nname: ketchup\ndescription: Ketchup\n---\n\n${passage}\n`);
    const hash = narHash(source);
    const cached = join(root, ".cache", "skillful", cacheKey(hash));
    mkdirSync(join(root, ".cache", "skillful"), { recursive: true });
    renameSync(source, cached);
    const rev = "a".repeat(40);
    writeFileSync(join(root, "skill.lock"), `old-ketchup-name github:example/skills@main ${rev} ${hash}\n`);
    const mod = join(root, "skill.mod");
    const header = "skillful 2\nuse github:example/skills@main { ketchup }\nagents pi claude codex\n";
    const replacement = 'ketchup.body.replace "Draw a Mermaid diagram of the flow." with "Describe the flow as a numbered list."\n';
    writeFileSync(join(root, "pi.txt"), "Use a short list.");
    writeFileSync(join(root, "claude.md"), "\nWrite a paragraph.\n");
    writeFileSync(mod, header + 'ketchup.body.replace on pi "Describe the flow as a numbered list." with ./pi.txt\n' + replacement + 'ketchup.body on claude = ./claude.md\nketchup.body.append on claude = "Keep it short.\\n"\nexample.body = "New instructions."\n');
    expect(run(root, "fmt").exitCode).toBe(0);
    expect(run(root, "fmt", "--check").exitCode).toBe(0);
    const render = () => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "render", "--force"], { cwd: root, env: { ...process.env, XDG_CACHE_HOME: join(root, ".cache") } });
    const result = render();
    expect(result.exitCode, output(result).stderr).toBe(0);
    const rendered = (folder: string) => readFileSync(join(root, "rendered", folder, "skills", "ketchup", "SKILL.md"), "utf8");
    expect(rendered(".pi/agent")).toEndWith("description: Ketchup\n---\n\nUse a short list.\n");
    expect(rendered(".claude")).toEndWith("description: Ketchup\n---\n\nWrite a paragraph.\nKeep it short.\n");
    expect(rendered(".codex")).toEndWith("\n\nDescribe the flow as a numbered list.\n");
    expect(readFileSync(join(root, "rendered", ".agents", "skills", "example", "SKILL.md"), "utf8")).toEndWith("\n---\nNew instructions.");
    for (const before of ['ketchup.body = "No diagram."\n', `ketchup.body.append = ${JSON.stringify(passage)}\n`]) {
      writeFileSync(mod, header + before + replacement);
      const failure = render();
      expect(failure.exitCode).not.toBe(0);
      expect(output(failure).stderr).toContain(`ketchup.body.replace expected ${JSON.stringify(passage)} exactly once (locked revision ${rev})`);
    }
  });

  test.each([
    ["adds a description without front matter", "Plain instructions.\n", 'example.description = "New guidance"', "---\ndescription: New guidance\n---\nPlain instructions.\n"],
    ["replaces only the body with CRLF front matter", "---\r\nname: example\r\ndescription: Example\r\n---\r\nOriginal body.\r\n", 'example.body = "New body"', "---\nname: example\ndescription: Example\n---\nNew body"],
  ])("a skillful 2 override %s", (_name, upstream, override, expected) => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), upstream);
    writeFileSync(join(root, "skill.mod"), `skillful 2\nagents pi\n${override}\n`);
    const result = run(root, "manifest", "--format", "json");
    expect(result.exitCode, output(result).stderr).toBe(0);
    expect(JSON.parse(output(result).stdout).harnesses.pi.skills.find(({ name }: { name: string }) => name === "example").body.replaceAll("\r\n", "\n")).toBe(expected);
  });
  test("check reports drift only for replaced upstream fields, including after updating", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const skill = join(root, "skills", "example", "SKILL.md");
    const upstream = (description: string, license: string, body = "Body.") => writeFileSync(skill, `---\nname: example\ndescription: ${description}\nlicense: ${license}\n---\n\n${body}\n`);
    upstream("Original", "MIT");
    writeFileSync(join(root, "skill.mod"), `skillful 2
agents pi claude
example.description on pi = "Local wording"
example.license.append = " (see LICENSE)"
example.body on claude = "Local instructions."
example.body.append = " More."
example.body.replace "More." with "Extra."
`);
    expect(run(root, "update").exitCode).toBe(0);
    upstream("Original", "Apache-2.0");
    expect(output(run(root, "check")).stdout).toBe("OK\n");
    upstream("Changed", "Apache-2.0", "Changed body.");
    expect(run(root, "update").exitCode).toBe(0);
    const result = run(root, "check", "--strict", "--format", "json");
    expect(result.exitCode, output(result).stderr).toBe(1);
    expect(JSON.parse(output(result).stdout).warnings).toEqual([
      expect.objectContaining({ harness: "claude", skill: "example", message: expect.stringContaining("example.body") }),
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
    writeFileSync(join(root, "skill.mod"), "skillful 1\nharness opencode (\n)\n");
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
    copyBasicFixture(project);
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
      expect(piClaudeRenderFiles(after)).toEqual(piClaudeRenderFiles(before));
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

  test("migrate can be retried after removing a confirmed retired omission", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills", "example", "SKILL.md"), "Example body.\n");
    writeFileSync(join(root, "skill.mod"), 'skillful 1\nharness pi (\n  omit-skill retired "Removed upstream"\n)\n');
    expect(run(root, "render", "--dry-run").exitCode).toBe(0);
    expect(run(root, "migrate").exitCode).toBe(1);
    writeFileSync(join(root, "skill.mod"), "skillful 1\nharness pi (\n)\n");
    expect(run(root, "migrate").exitCode).toBe(0);
    const result = run(root, "render", "--dry-run");
    expect(result.exitCode, output(result).stderr).toBe(0);
  });

  test("migrate refuses to drop an omission when its extra root is not supplied", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    writeFileSync(join(root, "skills/example/SKILL.md"), "Local body.\n");
    mkdirSync(join(root, "ext/vendor"), { recursive: true });
    writeFileSync(join(root, "ext/vendor/SKILL.md"), "Vendor body.\n");
    const mod = join(root, "skill.mod");
    const original = 'skillful 1\nharness pi (\n  omit-skill vendor "Not for Pi"\n)\nharness claude (\n)\n';
    writeFileSync(mod, original);
    const render = run(root, "render", "--extra-skill-root", "ext=./ext");
    expect(render.exitCode, output(render).stderr).toBe(0);
    expect(existsSync(join(root, "rendered/pi/skills/vendor/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "rendered/claude/skills/vendor/SKILL.md"))).toBe(true);

    const migrated = run(root, "migrate");
    expect(migrated.exitCode, output(migrated).stderr).toBe(1);
    expect(output(migrated).stderr).toContain("omit-skill vendor for pi");
    expect(readFileSync(mod, "utf8")).toBe(original);
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
    for (const [i, args] of targets.entries()) {
      const result = run(root, "render", ...args, "--out", `v2-${i}`);
      expect(result.exitCode, output(result).stderr).toBe(0);
      const before = join(root, `v1-${i}`);
      const after = join(root, `v2-${i}`);
      expect(piClaudeRenderFiles(after)).toEqual(piClaudeRenderFiles(before));
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
    ['missing.body.append = "value"', "unknown skill missing in body override"],
    ['example.body on', 'expected an agent after on'],
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

    const perHarness = run(root, "render", "--per-harness");
    expect(perHarness.exitCode).toBe(2);
    expect(output(perHarness).stderr).toContain("unknown option '--per-harness'");

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
