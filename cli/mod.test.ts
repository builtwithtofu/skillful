import { describe, expect, test } from "bun:test";
import { ModError, formatMod, formatText, parseMod } from "./mod.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPlan, resolvePlan } from "./contract.ts";
import { discoverProject } from "./project.ts";

const full = `// Project comment
skillful 1

// root comment
skills ./my-skills
commands "./my commands"
rules ./rules.md

// dependency
require github:owner/repo@main as demo (
  only zebra
  only alpha
)

// harness
harness pi (
  token audience "Pi \\uD83E\\uDD16"
  omit-skill hidden "Not available."
  omit-command deploy "Requires approval."
)
`;

describe("skill.mod", () => {
  test("formats multiline operands without changing literal whitespace or escapes", () => {
    const text = String.raw`skillful 2


example.body.replace """
  Before.
    Indented.
  """ with """

  // literal \n

  """
example.description = "One line"

skip example on pi """
  First reason.
  Second reason.
  """
`;
    const escaped = String.raw`skillful 2
example.body.replace "Before.\n  Indented." with "\n// literal \\n\n"
example.description = """
  One line
  """
skip example on pi "First reason.\nSecond reason."
`;
    expect(formatText(escaped)).toBe(text);
    expect(formatText(text)).toBe(text);
    const mod = parseMod(text);
    expect(mod).toMatchObject({
      fieldOverrides: [{ match: { text: "Before.\n  Indented." }, value: { text: "\n// literal \\n\n" } }, { value: { text: "One line" } }],
      skips: [{ reason: "First reason.\nSecond reason." }],
    });
  });

  test.each(["line\n  \"\"\"", "line\r\nnext"])("keeps JSON when a raw block cannot encode %j", (value) => {
    const text = `skillful 2\n\n\nexample.body = ${JSON.stringify(value)}\n`;
    expect(formatText(text)).toBe(text);
  });

  test.each([
    ['example.body = """ extra', "custom.mod:2:16: block opener must end its line"],
    ['example.body = """\n text\n  """', "custom.mod:3:1: block content does not match closing delimiter indentation"],
    ['example.body.replace """\n  old\n  """ with """\n  new', "custom.mod:4:12: unterminated block value"],
  ])("reports the physical location of an invalid block", (directive, error) => {
    expect(() => parseMod(`skillful 2\n${directive}`, "custom.mod")).toThrow(error);
  });

  test("body.replace errors explain multiline operand syntax", () => {
    expect(() => parseMod('skillful 2\nexample.body.replace "old" with')).toThrow(expect.objectContaining({
      recovery: expect.stringContaining('For a multiline operand, use a """ block.'),
    }));
    expect(() => parseMod('skillful 2\nexample.body.replace """\nold')).toThrow(expect.objectContaining({
      recovery: expect.stringContaining('Start a closing """ at the beginning of a line; the rest of the directive can follow it.'),
    }));
  });
  test.each([
    ["set", "example.body = ./override.md", "Pi only.\n", "Elsewhere.\n"],
    ["append", "example.body.append = ./override.md", "Before.\nPi only.\n", "Before.\nElsewhere.\n"],
    ["replace", 'example.body.replace "Before.\\n" with ./override.md', "Pi only.\n", "Elsewhere.\n"],
  ])("renders fences after a body %s override", (_operation, directive, pi, claude) => {
    const project = mkdtempSync(join(tmpdir(), "skillful-mod-test-"));
    try {
      mkdirSync(join(project, "skills/example"), { recursive: true });
      writeFileSync(join(project, "skills/example/SKILL.md"), "Before.\n");
      writeFileSync(join(project, "override.md"), "<!-- only pi -->\nPi only.\n<!-- end -->\n<!-- skip pi -->\nElsewhere.\n<!-- end -->\n");
      writeFileSync(join(project, "skill.mod"), `skillful 2\nagents pi claude\n${directive}\n`);
      const plan = resolvePlan(discoverProject({ project }));
      expect(harnessPlan(plan, "pi").skills[0]?.body).toBe(pi);
      expect(harnessPlan(plan, "claude").skills[0]?.body).toBe(claude);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
  test("parses defaults, JSON escapes, comments, and blocks", () => {
    const mod = parseMod(full, "skill.mod");
    expect(mod.roots).toEqual({ skills: "./my-skills", commands: "./my commands", rules: "./rules.md" });
    expect(mod.requires[0]).toMatchObject({ ref: "github:owner/repo@main", alias: "demo", mode: "only", selectors: ["zebra", "alpha"] });
    const pi = mod.harnesses.pi;
    if (!pi) throw new Error("expected the parsed pi harness");
    expect(pi.tokens.audience).toBe("Pi 🤖");
    expect(mod.leadingComments).toHaveLength(4);
  });

  test("formats canonically, preserves leading comments, and is idempotent", () => {
    const once = formatText(full, "skill.mod");
    expect(once).toBe(`// Project comment
skillful 1

// root comment
skills ./my-skills
commands "./my commands"
rules ./rules.md

// dependency
require github:owner/repo@main as demo (
  only alpha
  only zebra
)

// harness
harness pi (
  token audience "Pi 🤖"
  omit-command deploy "Requires approval."
  omit-skill hidden "Not available."
)
`);
    expect(formatText(once, "skill.mod")).toBe(once);
    expect(formatMod(parseMod(once, "skill.mod"))).toBe(once);
  });
  test("parses and canonically formats named setup outputs", () => {
    const text = `skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

setup personal (
  omit-skill company-database "Work only."
  pi claude
)

setup work-mac (
  root project
  pi

  claude (
    skills .claude2/skills
    commands .claude2/commands
  )
)
`;
    const mod = parseMod(text, "skill.mod");
    expect(mod.setups.personal).toMatchObject({
      name: "personal",
      root: "home",
      mode: "omit",
      selectors: [{ name: "company-database", reason: "Work only." }],
      harnesses: [{ id: "pi", paths: {} }, { id: "claude", paths: {} }],
    });
    expect(mod.setups["work-mac"]?.harnesses[1]).toMatchObject({ id: "claude", paths: { skills: ".claude2/skills", commands: ".claude2/commands" } });
    expect(formatText(text, "skill.mod")).toBe(text);
  });
  test.each([
    ["missing header", "skills ./skills", "first semantic directive"],
    ["unknown version", "skillful 3", "unsupported skillful version"],
    ["unknown directive", "skillful 1\nwat nope", "unknown directive"],
    ["duplicate root", "skillful 1\nskills ./a\nskills ./b", "may appear at most once"],
    ["unknown harness", "skillful 1\nharness nope (\n)", "unknown harness"],
    ["retired harness", "skillful 1\nharness opencode-v2 (\n)", "retired harness"],
    ["duplicate setup", "skillful 1\nsetup mine (\n pi\n)\nsetup mine (\n claude\n)", "duplicate setup"],
    ["empty setup", "skillful 1\nsetup mine (\n)", "at least one harness"],
    ["duplicate setup harness", "skillful 1\nsetup mine (\n pi pi\n)", "duplicate harness"],
    ["mixed setup selection", "skillful 1\nsetup mine (\n only-skill a\n omit-skill b \"No.\"\n pi\n)", "cannot mix"],
    ["unsafe setup path", "skillful 1\nsetup mine (\n pi (\n  skills ../escape\n )\n)", "unsafe setup path"],
    ["nested block", "skillful 1\nrequire path:x (\n  only x (\n)", "nested blocks"],
    ["stray close", "skillful 1\n)", "stray block close"],
    ["trailing open", "skillful 1\nharness pi ( trailing", "must be the final token"],
    ["unclosed quote", "skillful 1\nharness pi (\n token x \"oops", "unterminated JSON string"],
    ["duplicate selector", "skillful 1\nrequire path:x (\n only x\n only x\n)", "duplicate only selector"],
    ["mixed selectors", "skillful 1\nrequire path:x (\n only x\n exclude y\n)", "cannot mix only and exclude"],
    ["alias collision", "skillful 1\nrequire path:a as same\nrequire path:b as same", "duplicate require alias"],
    ["bad alias", "skillful 1\nrequire path:a as Bad", "invalid require alias"],
    ["duplicate token", "skillful 1\nharness pi (\n token x \"a\"\n token x \"b\"\n)", "duplicate token"],
  ])("rejects %s with a location and recovery", (_name, text, expected) => {
    try {
      parseMod(text, "skill.mod");
      throw new Error("expected parser failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModError);
      const modError = error as ModError;
      expect(modError.message).toContain(expected);
      expect(modError.message).toMatch(/skill\.mod:\d+:\d+/);
      expect(modError.recovery).toContain("Recovery:");
    }
  });
});
