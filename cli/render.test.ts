import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProject } from "./project.ts";
import { commitStagedTree, renderProject, RenderOutputError } from "./render.ts";
import { contractFor, harnessPlan, migrateBodyFences, resolvePlan } from "./contract.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(v2 = false) {
  const root = mkdtempSync(join(tmpdir(), "skillful-render-test-"));
  roots.push(root);
  const project = join(root, "project");
  copyBasicFixture(project);
  if (v2) writeFileSync(join(project, "rules/global_agents.md"), "<!-- only pi -->\nPi rule.\n<!-- end -->\n");
  return { root, project, resolved: discoverProject({ project }) };
}
function text(path: string) { return readFileSync(path, "utf8"); }

test.each(["{{#pi}}", "{{^pi}}", "{{/}}", "{{tool/name}}"])("rejects %s in skillful 2 frontmatter even with a field override", (markup) => {
  const { project } = fixture(true);
  writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents pi\nexample.description on pi = "Pi guidance"\n');
  writeFileSync(join(project, "skills/example/SKILL.md"), `---\nname: example\ndescription: ${JSON.stringify(markup)}\n---\n`);
  const render = () => resolvePlan(discoverProject({ project }));
  expect(render).toThrow("skills/example/SKILL.md:3: legacy brace markup is not supported in skillful 2 frontmatter");
  try { render(); } catch (error) { expect(error).toHaveProperty("recovery", expect.stringContaining('<skill>.<field> on <agent> = "value"')); }
});

test("uses a per-agent field override for local skill frontmatter", () => {
  const { project } = fixture(true);
  writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents pi claude\nexample.description on pi = "Pi guidance"\n');
  writeFileSync(join(project, "skills/example/SKILL.md"), "---\nname: example\ndescription: Common guidance\n---\n");
  const plan = resolvePlan(discoverProject({ project }));
  expect(harnessPlan(plan, "pi").skills[0]?.body).toContain("description: Pi guidance");
  expect(harnessPlan(plan, "claude").skills[0]?.body).toContain("description: Common guidance");
});

test("renders a fence across body override values", () => {
  const { project } = fixture(true);
  writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents pi codex\nexample.body.append = "<!-- only pi -->\\n"\nexample.body.append = "Pi only.\\n<!-- end -->\\n"\n');
  writeFileSync(join(project, "skills/example/SKILL.md"), "Common.\n");
  const plan = resolvePlan(discoverProject({ project }));
  expect(harnessPlan(plan, "pi").skills.find(({ name }) => name === "example")?.body).toBe("Common.\nPi only.\n");
  expect(harnessPlan(plan, "codex").skills.find(({ name }) => name === "example")?.body).toBe("Common.\n");
});

test("reports authored paths and locations for render errors", () => {
  const { project } = fixture(true);
  renameSync(join(project, "skills"), join(project, "library"));
  renameSync(join(project, "commands"), join(project, "prompts"));
  const skill = join(project, "library/example/SKILL.md");
  const mod = join(project, "skill.mod");
  const header = "skillful 2\nlocal ./library ./prompts\nagents pi codex\n";
  const render = () => resolvePlan(discoverProject({ project }), { harnesses: ["pi"] });
  const frontmatter = "---\r\nname: example\r\ndescription: Example\r\n---\r\n";
  writeFileSync(skill, frontmatter + "First.\r\n");
  writeFileSync(mod, header + 'example.body.append on pi = "<!-- only pi -->\\n"\nexample.body.append on codex = "Codex."\nexample.description = "New description"\nexample.body.append = "Second.\\nThird.\\n"\n');
  expect(render).toThrow("library/example/SKILL.md (after skill.mod overrides at lines 4, 7): unclosed renderer fence");

  writeFileSync(mod, header + 'example.description = "First line.\\nSecond line."\nexample.body.append on codex = "Codex."\n');
  writeFileSync(skill, frontmatter + "First.\r\n<!-- end -->\r\n");
  expect(render).toThrow("library/example/SKILL.md:6: stray <!-- end -->");

  writeFileSync(skill, frontmatter + "First.\r\n");
  writeFileSync(join(project, "prompts/review.md"), "Prompt.\n<!-- end -->\n");
  for (const harness of ["pi", "codex"]) {
    expect(() => resolvePlan(discoverProject({ project }), { harnesses: [harness] })).toThrow("prompts/review.md:2: stray <!-- end -->");
  }
});

test("command frontmatter errors recommend a command-compatible fix", () => {
  const { project } = fixture(true);
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents codex\n");
  writeFileSync(join(project, "skills/example/SKILL.md"), "Example.\n");
  writeFileSync(join(project, "commands/standalone.md"), '---\ndescription: "{{tool/name}}"\n---\nPrompt.\n');
  expect(() => resolvePlan(discoverProject({ project }))).toThrow(expect.objectContaining({
    message: expect.stringContaining("commands/standalone.md:2:"),
    recovery: "Recovery: Remove the brace markup. For a token, write its literal value.",
  }));
});

test("protects indented and unclosed code fences and multiline code spans", () => {
  const { project } = fixture(true);
  const examples = [
    "- Examples:", "  ```markdown", "  <!-- end -->", "  ``", "  ~~~~", "  <!-- skip bogus -->", " \t`````",
    "\t~~~markdown", "\t{{^pi}}", "\t<!-- end -->", "\t~~~~",
    "A `` span with a single ` and", "{{tool/name}} <!-- end --> ``", "",
  ].join("\n");
  const unclosed = "\t```markdown\n<!-- end -->\n{{token}}\n";
  const skill = join(project, "skills/example/SKILL.md");
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\n");
  writeFileSync(skill, examples + "<!-- only pi -->\nSelected.\n<!-- end -->\n" + unclosed);
  const render = () => harnessPlan(resolvePlan(discoverProject({ project })), "pi").skills.find(({ name }) => name === "example")?.body;
  expect(render()).toBe(examples + "Selected.\n" + unclosed);

  writeFileSync(skill, "An unmatched `\n \t\n{{tool/name}}\nEnds with `.\n");
  expect(render).toThrow("skills/example/SKILL.md:3: legacy markup {{tool/name}}");
});

test("protects code fences opened on list marker lines without hiding later renderer fences", () => {
  const { project } = fixture(true);
  const skill = join(project, "skills/example/SKILL.md");
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\n");
  for (const [opener, indent, closer] of [["- ~~~text", "  ", "~~~"], ["* ```", "  ", "```"], ["1. ```sh", "   ", "```"]]) {
    const example = `${opener}\n${indent}<!-- end -->\n${indent}${closer}\n`;
    writeFileSync(skill, example + "<!-- only pi -->\nSelected.\n<!-- end -->\n");
    const plan = resolvePlan(discoverProject({ project }));
    expect(harnessPlan(plan, "pi").skills.find(({ name }) => name === "example")?.body).toBe(example + "Selected.\n");
  }
});

test("an escaped backtick does not open a span but closes one", () => {
  const { project } = fixture(true);
  const before = "A literal \\` before a renderer fence.\n";
  const span = "Windows paths end in `\\`. Write ``{{token}}\\``.\n";
  const after = "Then run `dir`.\n";
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\n");
  writeFileSync(join(project, "skills/example/SKILL.md"), before + "<!-- only pi -->\nSelected.\n<!-- end -->\n" + span + "<!-- skip pi -->\nNot pi.\n<!-- end -->\n" + after);
  const plan = resolvePlan(discoverProject({ project }));
  expect(harnessPlan(plan, "pi").skills.find(({ name }) => name === "example")?.body).toBe(before + "Selected.\n" + span + after);
});

test("leaves multiline comments that look like renderer fences unchanged", () => {
  const { project } = fixture(true);
  const comment = "<!-- only bogus\n{{token}} $@\n-->\n";
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents claude\n");
  writeFileSync(join(project, "skills/example/SKILL.md"), comment + "<!-- only claude -->\nSelected.\n<!-- end -->\n");
  const plan = resolvePlan(discoverProject({ project }));
  expect(harnessPlan(plan, "claude").skills.find(({ name }) => name === "example")?.body).toBe(comment + "Selected.\n");
});

test("treats braces on separate lines as prose in render and migrate", () => {
  const { project } = fixture(true);
  const source = "---\nname: example\ndescription: |-\n  An unmatched {{\n  followed by }}\n---\nWrite {{ on one line\nand }} on the next.\n";
  writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\n");
  writeFileSync(join(project, "skills/example/SKILL.md"), source);
  const plan = resolvePlan(discoverProject({ project }));
  expect(harnessPlan(plan, "pi").skills.find(({ name }) => name === "example")?.body).toBe(source);
  expect(migrateBodyFences(source, true, "SKILL.md")).toBe(source);
});

test("migrate recommends a fence remedy for legacy markers in prose", () => {
  for (const marker of ["{{#pi}}", "{{^pi}}", "{{/}}"]) {
    expect(() => migrateBodyFences(`Example: ${marker}\n`, false, "rules.md")).toThrow(expect.objectContaining({
      message: `rules.md:1: cannot migrate legacy markup ${marker} in body`,
      recovery: "Recovery: Move the fence to its own line, or put the example in a code span or fenced code block.",
    }));
  }
});

describe("TypeScript renderer", () => {
  test("renders comment fences in skills, commands, and rules without touching examples or ordinary comments", () => {
    const { project } = fixture(true);
    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi codex editor\nharness editor { skills .editor/skills }\n");
    const examples = "`<!-- only unknown -->`\n```markdown\n<!-- end -->\n{{token}} $@\n```\n<!-- note {{token}} $@ -->\n";
    const selected = "Selected.\n<!-- end of steps -->\n<!--\nonly bogus -->\nStill selected.\n";
    writeFileSync(join(project, "skills/example/SKILL.md"), `<!-- only pi editor -->\n${selected}<!--   end   -->\n<!-- skip pi editor -->\nInverted.\n<!-- end -->\n` + examples);
    writeFileSync(join(project, "commands/standalone.md"), "<!-- only pi -->\nPi prompt: $@\n<!-- end -->\nCommon prompt.\n");
    const plan = resolvePlan(discoverProject({ project }));
    const pi = harnessPlan(plan, "pi");
    const codex = harnessPlan(plan, "codex");
    const editor = harnessPlan(plan, "editor");
    expect(pi.skills.find(({ name }) => name === "example")?.body).toBe(selected + examples);
    expect(editor.skills.find(({ name }) => name === "example")?.body).toBe(selected + examples);
    expect(codex.skills.find(({ name }) => name === "example")?.body).toBe("Inverted.\n" + examples);
    expect(pi.commands[0]?.body).toBe("Pi prompt: $@\nCommon prompt.\n");
    expect(codex.skills.find(({ name }) => name === "standalone")?.body.split("---\n")[2]).toBe("\nCommon prompt.\n");
    expect(pi.rules.body).toBe("Pi rule.\n");
    expect(codex.rules.body).toBe("");
    expect(contractFor(plan).schema.markup).toEqual(["<!-- only AGENT … -->", "<!-- skip AGENT … -->", "<!-- end -->", "$@"]);
  });

  test.each([
    ["<!-- only -->", 5, "empty selector list", "Add at least one agent"],
    ["<!-- skip unknown -->", 5, 'unknown agent "unknown"', "Use one of: claude"],
    ["<!-- only model:example -->", 5, 'selector kind "model" is not supported yet', "Use agent names"],
    ["<!-- only version:2 -->", 5, 'selector kind "version" is not supported yet', "Use agent names"],
    ["<!-- only codex -->\n<!-- skip pi -->", 6, "nested renderer fences", "Close the current fence with <!-- end -->"],
    ["<!-- end -->", 5, "stray <!-- end -->", "Remove it or add its opening fence"],
    ["<!-- only pi -->\ntext", 5, "unclosed renderer fence", "Add <!-- end -->"],
    ["text <!-- skip pi -->", 5, "renderer fence is not on a line of its own", "on its own line"],
    ["<!-- only pi --> <!-- end -->", 5, "renderer fence is not on a line of its own", "on its own line"],
    ...["{{#pi}}", "{{^pi}}", "{{/}}", "{{tool/name}}"].map((old) => [old, 5, `legacy markup ${old}`, "Put examples in a code span or fenced code block."] as const),
  ] as const)("rejects invalid skillful 2 markup: %s", (body, line, message, remedy) => {
    const { project } = fixture(true);
    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents pi\n");
    writeFileSync(join(project, "skills/example/SKILL.md"), `---\nname: example\ndescription: Example\n---\n${body}\n`);
    const render = () => resolvePlan(discoverProject({ project }));
    expect(render).toThrow(`skills/example/SKILL.md:${line}: ${message}`);
    try { render(); } catch (error) { expect(error).toHaveProperty("recovery", expect.stringContaining(remedy)); }
  });
  test("shares one plan across contract and rendered skills, commands, rules, and support files", () => {
    const { project, resolved } = fixture();
    const plan = resolvePlan(resolved);
    const contract = contractFor(plan);
    expect(contract.schemaVersion).toBe(1);
    expect(contract.manifest.harnesses.pi?.assets).toEqual([]);
    expect(contract.manifest.harnesses.pi?.skills.map((skill) => skill.name)).toContain("example");

    renderProject(resolved);
    const claude = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    expect(claude).toContain("Claude Code");
    expect(claude).toContain("Claude keeps this line.");
    expect(claude).not.toContain("Other harnesses keep this line.");
    expect(claude).toContain("$ARGUMENTS");
    expect(existsSync(join(project, "rendered", "claude", "commands", "standalone.md"))).toBe(false);
    const claudePrompt = text(join(project, "rendered", "claude", "skills", "standalone", "SKILL.md"));
    expect(claudePrompt).toContain("disable-model-invocation: true");
    expect(claudePrompt).toContain("This command accepts: $ARGUMENTS");

    const pi = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    expect(pi).toContain("Pi");
    expect(pi).toContain("Other harnesses keep this line.");
    expect(pi).not.toContain("Claude keeps this line.");
    expect(pi).toContain("Arguments: $@");
    expect(text(join(project, "rendered", "pi", "commands", "standalone.md"))).toContain("This command accepts: $@");
    expect(existsSync(join(project, "rendered", "pi", "commands", "example.md"))).toBe(false);
    expect(text(join(project, "rendered", "pi", "rules.md"))).toContain("This line demonstrates rules rendering.");
    expect(text(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toContain("copied without rendering");
  });

  test("renders only harnesses declared by the project by default", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

harness pi (
  token audience "Pi"
)
`);

    const plan = resolvePlan(discoverProject({ project }));
    const contract = contractFor(plan);
    renderProject(discoverProject({ project }));

    expect(Object.keys(plan.harnesses)).toEqual(["pi"]);
    expect(Object.keys(contract.manifest.harnesses)).toEqual(["pi"]);
    expect(contract.schema.harnesses.codex.commandMerge).toBe("skill");
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "codex"))).toBe(false);
  });

  test("a fresh targeted render never shares a skill skipped by another declared reader", () => {
    const { project } = fixture(true);
    writeFileSync(join(project, "skill.mod"), 'skillful 2\nagents codex pi\nskip example on codex "Pi only."\n');
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
    const manifest = discoverProject({ project });
    const assertPrivate = () => {
      expect(existsSync(join(project, "rendered", ".agents", "skills", "example"))).toBe(false);
      expect(existsSync(join(project, "rendered", ".pi", "agent", "skills", "example", "SKILL.md"))).toBe(true);
    };
    renderProject(manifest, { harnesses: ["pi"] });
    assertPrivate();
    renderProject(manifest);
    renderProject(manifest, { harnesses: ["pi"] });
    assertPrivate();
  });

  test("a targeted shared-skill render leaves other harness commands alone", () => {
    const { project } = fixture(true);
    writeFileSync(join(project, "skill.mod"), "skillful 2\nagents codex pi\n");
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n");
    const prompt = join(project, "commands", "standalone.md");
    const piCommand = join(project, "rendered", "pi", "commands", "standalone.md");
    const manifest = discoverProject({ project });
    writeFileSync(prompt, "First prompt.\n");
    renderProject(manifest);
    writeFileSync(prompt, "Second prompt.\n");
    renderProject(manifest, { harnesses: ["codex"] });
    expect(text(piCommand)).toBe("First prompt.\n");
    expect(text(join(project, "rendered", "codex", "skills", "standalone", "SKILL.md"))).toContain("Second prompt.");
    writeFileSync(piCommand, "Local edit.\n");
    writeFileSync(prompt, "<!-- only pi -->\nPi prompt.\n<!-- end -->\nCodex prompt.\n");
    renderProject(manifest, { harnesses: ["codex"] });
    expect(text(piCommand)).toBe("Local edit.\n");
  });

  test("regrouping refreshes retained skill contracts without rerendering commands or rules", () => {
    const { project } = fixture(true);
    const mod = join(project, "skill.mod");
    const header = "skillful 2\nagents codex pi\n";
    writeFileSync(mod, header);
    writeFileSync(join(project, "skills/example/SKILL.md"), "Default body.\n");
    renderProject(discoverProject({ project }));
    const out = join(project, "rendered");
    const piContractPath = join(out, "pi/.skillful/contract.json");
    const pi = () => JSON.parse(text(piContractPath)).manifest.harnesses.pi;
    const before = pi();
    expect(before.skills[0].delivery.path).toBe(".agents/skills/example/SKILL.md");
    const command = join(out, "pi/commands/standalone.md");
    const rules = join(out, "pi/rules.md");
    const beforeRules = text(rules);
    writeFileSync(command, "Locally edited prompt.\n");
    writeFileSync(mod, header + 'example.body on pi = "Pi instructions."\n');

    const result = renderProject(discoverProject({ project }), { harnesses: ["codex"] });
    const regrouped = pi();
    const skill = regrouped.skills[0];
    expect(skill.delivery.path).toBe(".pi/agent/skills/example/SKILL.md");
    expect(text(join(out, skill.delivery.path))).toBe(skill.body);
    expect(skill.body).toBe("Pi instructions.");
    expect(skill.supportFiles[0].delivery.path).toBe(".pi/agent/skills/example/references/guide.md");
    expect(existsSync(join(out, skill.supportFiles[0].delivery.path))).toBe(true);
    expect(existsSync(join(out, before.skills[0].delivery.path))).toBe(false);
    expect(result.changes).toContainEqual({ path: "pi/.skillful/contract.json", action: "change" });
    expect(regrouped.commands).toEqual(before.commands);
    expect(regrouped.rules).toEqual(before.rules);
    expect(text(command)).toBe("Locally edited prompt.\n");
    expect(text(rules)).toBe(beforeRules);
    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("managed render file was modified: pi/commands/standalone.md");
    writeFileSync(command, before.commands[0].body);
    renderProject(discoverProject({ project }), { harnesses: ["pi"] });
  });

  test("shares identical skills and removes stale shared copies when selection or front matter differs", () => {
    const { project } = fixture(true);
    const mod = join(project, "skill.mod");
    const source = join(project, "skills", "example", "SKILL.md");
    const header = "skillful 2\nagents claude codex pi\n";
    const plain = "---\nname: example\ndescription: Example\n";
    const skill = (folder: string) => join(project, "rendered", folder, "skills", "example", "SKILL.md");
    const render = () => renderProject(discoverProject({ project }));
    writeFileSync(source, plain + "---\n");
    writeFileSync(mod, header);
    render();
    expect(existsSync(skill(".agents"))).toBe(true);
    expect(existsSync(skill(".claude"))).toBe(true);
    expect(existsSync(skill(".codex"))).toBe(false);
    expect(existsSync(skill(".pi/agent"))).toBe(false);

    writeFileSync(mod, header + 'skip example on codex "Pi only among shared agents."\n');
    renderProject(discoverProject({ project }), { harnesses: ["codex"] });
    expect(existsSync(skill(".agents"))).toBe(false);
    expect(existsSync(skill(".codex"))).toBe(false);
    expect(existsSync(skill(".pi/agent"))).toBe(true);

    writeFileSync(mod, header);
    writeFileSync(source, plain + "disable-model-invocation: true\n---\n");
    render();
    expect(existsSync(skill(".agents"))).toBe(false);
    expect(text(skill(".pi/agent"))).toContain("disable-model-invocation: true");
    expect(text(skill(".codex"))).not.toContain("disable-model-invocation");
  });
  test("renders Codex skills, fences, and standalone commands as skills", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["codex"] });

    const renderedSkill = text(join(project, "rendered", "codex", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Codex");
    expect(renderedSkill).toContain("Codex keeps this line.");
    expect(renderedSkill).toContain("the user's request that invoked this skill");
    const standalone = text(join(project, "rendered", "codex", "skills", "standalone", "SKILL.md"));
    expect(standalone).toContain("name: standalone");
    expect(standalone).toContain("A standalone fixture command");
    expect(text(join(project, "rendered", "codex", "skills", "standalone", "agents", "openai.yaml"))).toContain("allow_implicit_invocation: false");
    expect(existsSync(join(project, "rendered", "codex", "commands", "standalone.md"))).toBe(false);
  });

  test("renders Cursor skills, fences, and standalone commands as manual skills", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["cursor"] });

    const renderedSkill = text(join(project, "rendered", "cursor", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Cursor");
    expect(renderedSkill).toContain("Cursor keeps this line.");
    expect(renderedSkill).toContain("the user's request that invoked this skill");
    const standalone = text(join(project, "rendered", "cursor", "skills", "standalone", "SKILL.md"));
    expect(standalone).toContain("disable-model-invocation: true");
    expect(standalone).toContain("A standalone fixture command");
    expect(existsSync(join(project, "rendered", "cursor", "commands", "standalone.md"))).toBe(false);
  });

  test("renders Grok skills, native commands, rules, and fences", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["grok"] });

    const renderedSkill = text(join(project, "rendered", "grok", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Grok");
    expect(renderedSkill).toContain("Grok keeps this line.");
    expect(existsSync(join(project, "rendered", "grok", "commands", "example.md"))).toBe(false);
    expect(text(join(project, "rendered", "grok", "commands", "standalone.md"))).toContain("This command accepts: $ARGUMENTS");
    expect(text(join(project, "rendered", "grok", "rules.md"))).toContain("# Shared rules");
  });

  test("refuses a command attached to a skill folder", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "COMMAND.md"), "---\ndescription: Attached\n---\n\nRun it: $@\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("skills/example/COMMAND.md is not supported");
  });

  test("refuses a command that shares its name with a skill", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "example.md"), "---\ndescription: Same name\n---\n\nRun it: $@\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("commands share a name with skills for pi: example");
  });

  test("renders harness markup before parsing frontmatter", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), `---
name: example
description: >-
  {{audience}} metadata so the fence is not the first field.
{{#claude}}
disable-model-invocation: true
{{/}}
{{#opencode}}
user-invocable: false
{{/}}
---

Body.
`);
    const resolved = discoverProject({ project });
    const plan = resolvePlan(resolved, { harnesses: ["claude", "opencode", "pi"] });
    expect(harnessPlan(plan, "claude").skills.find((skill) => skill.name === "example")?.description).toBe("Claude Code metadata so the fence is not the first field.");

    renderProject(resolved, { harnesses: ["claude", "opencode", "pi"] });

    const claude = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    const opencode = text(join(project, "rendered", "opencode", "skills", "example", "SKILL.md"));
    expect(claude).toContain("disable-model-invocation: true");
    expect(opencode).not.toContain("disable-model-invocation");
    expect(existsSync(join(project, "rendered", "opencode", "commands", "example.md"))).toBe(false);
    expect(existsSync(join(project, "rendered", "pi", "commands", "example.md"))).toBe(false);
  });

  test("validates Agent Skill names only for selected harnesses", () => {
    const { project } = fixture();
    mkdirSync(join(project, "skills", "Upper"));
    writeFileSync(join(project, "skills", "Upper", "SKILL.md"), "---\nname: Upper\ndescription: Uppercase fixture\n---\n");
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}
setup pi-only (
  only-skill Upper
  pi
)
`);
    const resolved = discoverProject({ project });

    expect(() => renderProject(resolved, { harnesses: ["cursor"] })).toThrow("invalid Agent Skill name");
    expect(() => renderProject(resolved, { harnesses: ["claude"] })).not.toThrow();
    expect(() => renderProject(resolved, { setup: "pi-only" })).not.toThrow();
  });

  test("converts multiline command descriptions into valid manual skills", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "multiline.md"), `---
description: >-
  Run the multiline command
  when explicitly invoked.
---

Do the work.
`);

    renderProject(discoverProject({ project }), { harnesses: ["cursor"] });

    const rendered = text(join(project, "rendered", "cursor", "skills", "multiline", "SKILL.md"));
    expect(rendered).toContain('description: "Run the multiline command when explicitly invoked."');
  });

  test("rejects command names that cannot become Agent Skill names", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "deploy_db.md"), "Deploy it.\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["cursor"] })).toThrow("invalid Agent Skill name");
  });
  test("renders only a named setup and removes harnesses outside it", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}
setup personal (
  omit-skill hidden "Not here."
  pi
)
`);
    const selected = discoverProject({ project });
    const unmanaged = join(project, "rendered", "claude", "local.txt");
    writeFileSync(unmanaged, "mine");
    expect(() => renderProject(selected, { setup: "personal" })).toThrow("unmanaged files");
    expect(text(unmanaged)).toBe("mine");
    rmSync(unmanaged);
    const dry = renderProject(selected, { setup: "personal", dryRun: true });
    expect(dry.changes.some((change) => change.action === "delete" && change.path.startsWith("claude/"))).toBe(true);
    expect(existsSync(join(project, "rendered", "claude"))).toBe(true);

    renderProject(selected, { setup: "personal" });
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "pi", "skills", "hidden", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, "rendered", "claude"))).toBe(false);
    expect(existsSync(join(project, "rendered", "opencode"))).toBe(false);
  });
  test("a targeted harness render preserves other managed outputs", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    const claudeSkill = join(project, "rendered", "claude", "skills", "example", "SKILL.md");
    writeFileSync(claudeSkill, `${text(claudeSkill)}\nLocal edit.\n`);

    const dry = renderProject(resolved, { harnesses: ["pi"], dryRun: true });
    expect(dry.changes.some((change) => change.path.startsWith("claude/"))).toBe(false);

    renderProject(resolved, { harnesses: ["pi"] });
    expect(text(claudeSkill)).toEndWith("Local edit.\n");
    expect(existsSync(join(project, "rendered", "opencode", "skills", "example", "SKILL.md"))).toBe(true);
  });

  test("removes any retired managed harness render", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    const rendered = join(project, "rendered");
    renameSync(join(rendered, "opencode"), join(rendered, "retired-harness"));
    const statePath = join(rendered, "retired-harness", ".skillful", "render.json");
    const state = JSON.parse(text(statePath)) as Record<string, unknown>;
    state.harness = "retired-harness";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const dry = renderProject(resolved, { dryRun: true });
    expect(dry.changes.some((change) => change.action === "delete" && change.path.startsWith("retired-harness/"))).toBe(true);
    renderProject(resolved);
    expect(existsSync(join(rendered, "retired-harness"))).toBe(false);
  });



  test("preserves multiline values of supported frontmatter fields", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), `---
name: example
description: >-
  Use this skill when the description
  wraps across multiple lines.
metadata:
  owner: skillful
unsupported:
  nested: omitted
---

# Example
`);

    renderProject(discoverProject({ project }), { harnesses: ["pi"] });

    const rendered = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    expect(rendered).toStartWith(`---
name: example
description: >-
  Use this skill when the description
  wraps across multiple lines.
metadata:
  owner: skillful
---`);
    expect(rendered).not.toContain("unsupported:");
    expect(rendered).not.toContain("nested: omitted");
  });

  test("rejects unresolved markup before touching an existing output", () => {
    const { project, resolved } = fixture();
    renderProject(resolved, { harnesses: ["pi"] });
    const before = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\n---\n{{missing}}\n");
    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("skills/example/SKILL.md:4: unknown token {{missing}} for pi");
    expect(text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(before);
  });

  test("shows markup inside code as written and substitutes it elsewhere", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), [
      "---", "name: example", "description: Code example", "---", "",
      "Write a fence as `{{#claude}}` on its own line; `$@` marks the arguments.",
      "", "```text", "{{#pi}}", "echo $@", "{{/}}", "```", "",
      "Arguments: $@", "",
    ].join("\n"));

    renderProject(discoverProject({ project }), { harnesses: ["claude"] });

    const rendered = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    expect(rendered).toContain("Write a fence as `{{#claude}}` on its own line; `$@` marks the arguments.");
    expect(rendered).toContain("```text\n{{#pi}}\necho $@\n{{/}}\n```");
    expect(rendered).toContain("Arguments: $ARGUMENTS");
  });

  test("names the file and line of markup it cannot render", () => {
    const cases = [
      ["An inline {{#pi}} fence.", "skills/example/SKILL.md:6: renderer fence {{#pi}} is not on a line of its own"],
      ["An {{unknown}} token.", "skills/example/SKILL.md:6: unknown token {{unknown}} for pi"],
    ] as const;
    for (const [line, error] of cases) {
      const { project } = fixture();
      writeFileSync(join(project, "skills", "example", "SKILL.md"), `---\nname: example\ndescription: Broken\n---\n\n${line}\n`);
      expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow(error);
    }
  });

  test("dry-run writes nothing and managed rerenders remove stale support files", () => {
    const { project, resolved } = fixture();
    const dry = renderProject(resolved, { harnesses: ["pi"], dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(project, "rendered"))).toBe(false);
    renderProject(resolved, { harnesses: ["pi"] });
    rmSync(join(project, "skills", "example", "references", "guide.md"));
    const result = renderProject(discoverProject({ project }), { harnesses: ["pi"] });
    expect(result.changes).toContainEqual({ path: "pi/skills/example/references/guide.md", action: "delete" });
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toBe(false);
  });

  test("refuses unmanaged and edited output unless force is explicit", () => {
    const { project, resolved } = fixture();
    mkdirSync(join(project, "rendered"));
    writeFileSync(join(project, "rendered", "notes.txt"), "mine");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("unmanaged");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    const managed = join(project, "rendered", "pi", "skills", "example", "SKILL.md");
    writeFileSync(managed, "edited");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("was modified");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    expect(text(managed)).not.toBe("edited");
  });

  test("duplicate delivered names report both origins", () => {
    const { project } = fixture();
    const dep = join(project, "dep");
    mkdirSync(join(dep, "example"), { recursive: true });
    writeFileSync(join(dep, "example", "SKILL.md"), "---\nname: example\ndescription: duplicate\n---\n");
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}\nrequire path:dep as dependency\n`);
    expect(() => resolvePlan(discoverProject({ project }))).toThrow("example (canonical, dependency)");
  });
});

describe("render tree commit recovery", () => {
  test("restores the previous tree when installing the staged tree fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    writeFileSync(join(target, "old"), "old");
    writeFileSync(join(stage, "new"), "new");
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync(from, to) { renames++; if (renames === 2) throw new Error("injected install failure"); return renameSync(from, to); },
      rmSync,
    })).toThrow("injected install failure");
    expect(text(join(target, "old"))).toBe("old");
    expect(existsSync(join(target, "new"))).toBe(false);
  });

  test("retains recoverable paths when restoration also fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync() { renames++; if (renames >= 2) throw new Error(`failure ${renames}`); },
      rmSync,
    })).toThrow(RenderOutputError);
    expect(existsSync(stage)).toBe(true);
  });
});
