import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadHarnesses, type HarnessFacts, type HarnessInstallPaths } from "./harness.ts";
import { isScalar, parseDocument } from "yaml";
import { agentReadsShared, HARNESS_IDS, mapHarnesses, ModError, type BuiltinHarnessId, type FieldOverride, type HarnessId, type Omission, type Require, type Setup, type SkillMod } from "./mod.ts";
import { resolveLocalRoot, resolveProjectPath, type Project } from "./project.ts";
import { cachedDependencyPaths } from "./deps.ts";
import { readLock, readOverrideBaselines } from "./lock.ts";

export type ExtraRoot = { origin: string; path: string };
export type ResolveOptions = {
  overrides?: Record<string, string> | undefined;
  extraRoots?: { skills?: ExtraRoot[] | undefined; commands?: ExtraRoot[] | undefined } | undefined;
  setup?: string | undefined;
  harnesses?: HarnessId[] | undefined;
};

type Source = { kind: string; origin?: string | null; path: string | null };
type Transformations = {
  fences: Array<{ kind: "fence"; mode: "include" | "exclude"; targets: HarnessId[]; outcome: "selected" | "omitted" }>;
  tokens: Array<{ kind: "token-substituted"; token: string; value: string }>;
  argSyntax: { kind: "arg-syntax-substituted"; from: "$@"; to: string } | null;
  command: string[];
};
export type SupportFilePlan = {
  source: { path: string | null };
  delivery: { kind: "file"; path: string };
  sha256: string;
  copied: "verbatim" | "generated";
  markup: boolean;
  sourcePath: string | null;
  generatedBody: string | null;
  relativePath: string;
};
export type SkillPlan = {
  name: string;
  description: string | null;
  origin: string;
  source: Source;
  delivery: { kind: "file"; path: string };
  sha256: string;
  frontmatter: FrontmatterPlan;
  transformations: Transformations;
  supportFiles: SupportFilePlan[];
  body: string;
  sourceDir: string;
};
export type CommandPlan = {
  name: string;
  source: Source;
  delivery: { kind: "file"; path: string };
  sha256: string;
  frontmatter: FrontmatterPlan;
  transformations: Transformations;
  body: string;
};
export type FrontmatterPlan = { source: string[]; retained: string[]; omitted: string[]; rendered: string[] };
export type HarnessPlan = {
  id: HarnessId;
  facts: HarnessFacts;
  profile: {
    argSyntax: string;
    installPaths: HarnessInstallPaths;
    commandMerge: "file" | "skill";
    exclusions: Record<string, { code: string; message: string }>;
    excludeCommands: string[];
    commandExclude: string[];
  };
  omittedSkills: Record<string, { code: string; message: string }>;
  skills: SkillPlan[];
  commands: CommandPlan[];
  rules: { source: Source; delivery: { kind: "file"; path: string } | null; sha256: string; body: string };
  assets: never[];
};
type SkillPlacement = { id: HarnessId; root: string; skill: SkillPlan };
export type ProjectPlan = { project: Project; harnesses: Partial<Record<HarnessId, HarnessPlan>>; placements: SkillPlacement[]; regroupedSkills: Map<HarnessId, SkillPlan[]>; changedOverrides: FieldOverride[] };

type SkillEntry = { name: string; origin: string; root: string; sourceKind: "canonical" | "external" | "override" | "extra" };
type CommandEntry = { name: string; origin: string; root: string; sourceKind: "standalone" | "external" | "extra" };

export class ContractError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
function fail(message: string, recovery: string): never { throw new ContractError(message, `Recovery: ${recovery}`); }
export function harnessIds(plan: ProjectPlan) { return Object.keys(plan.harnesses).sort(); }
export function harnessPlan(plan: ProjectPlan, id: HarnessId) {
  const harness = plan.harnesses[id];
  if (!harness) fail(`harness ${id} is not selected`, "Declare it in skill.mod, select it through a setup, or pass --harness.");
  return harness;
}
export function sha256(text: string | Buffer) { return createHash("sha256").update(text).digest("hex"); }
function sortedDirectoryNames(path: string) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
function sortedMarkdown(path: string) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
}
function ensureInsideProject(project: Project, raw: string, label: string) {
  const path = resolve(project.root, raw);
  const rel = relative(project.root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} escapes the project root: ${raw}`, `Choose a path inside ${project.root}.`);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(`${label} is not an existing directory: ${raw}`, "Create the directory or correct the configured path.");
  const real = realpathSync(path);
  const realRel = relative(project.root, real);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} resolves outside the project root: ${raw}`, "Do not use a symlink that escapes the project.");
  return real;
}
function resolveOverride(path: string, project: Project, label: string) {
  const selected = resolve(project.root, path);
  if (!existsSync(selected) || !lstatSync(selected).isDirectory()) fail(`${label} is not an existing directory: ${path}`, "Pass an existing content directory.");
  return realpathSync(selected);
}
function dependencyRoot(requirement: Require, project: Project, overrides: Record<string, string>) {
  if (overrides[requirement.name]) return { path: resolveOverride(overrides[requirement.name]!, project, `override ${requirement.name}`), kind: "override" as const };
  if (requirement.ref.startsWith("path:")) return { path: ensureInsideProject(project, requirement.ref.slice(5), `path dependency ${requirement.name}`), kind: "external" as const };
  fail(`dependency ${requirement.name} (${requirement.ref}) is not available locally`, `Pass --override ${requirement.name}=PATH during M2; locked dependencies use skillful fetch in M4.`);
}
function selectedBy(requirement: Require, name: string) {
  if (!requirement.mode) return true;
  return requirement.mode === "only" ? requirement.selectors.includes(name) : !requirement.selectors.includes(name);
}
function sourcePath(entry: SkillEntry, file: string) {
  return entry.sourceKind === "canonical" ? `skills/${entry.name}/${file}` : `external/${entry.origin}/${entry.name}/${file}`;
}
function skillSource(entry: SkillEntry): Source {
  return { kind: entry.sourceKind === "canonical" ? "canonical" : "external", origin: entry.sourceKind === "canonical" ? "canonical" : entry.origin, path: sourcePath(entry, "SKILL.md") };
}
function commandSource(entry: CommandEntry): Source {
  return entry.sourceKind === "standalone"
    ? { kind: "standalone", origin: "canonical", path: `commands/${entry.name}` }
    : { kind: "external", origin: entry.origin, path: `external/${entry.origin}/${entry.name}` };
}
function uniqueByName<T extends { name: string; origin: string }>(entries: T[], kind: string) {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) grouped.set(entry.name, [...(grouped.get(entry.name) ?? []), entry]);
  const duplicates = [...grouped].filter(([, values]) => values.length > 1);
  if (duplicates.length) fail(`duplicate ${kind} names: ${duplicates.map(([name, values]) => `${name} (${values.map((value) => value.origin).join(", ")})`).join("; ")}`, `Use only/exclude or rename one conflicting ${kind}.`);
}

function frontmatterEnd(lines: string[], crlf = false) {
  const delimiter = (line: string | undefined) => line === "---" || (crlf && line === "---\r");
  if (!delimiter(lines[0])) return null;
  for (let index = 1; index < lines.length; index++) if (delimiter(lines[index])) return index;
  return null;
}
function topLevelKeyOf(line: string) { return line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*):/)?.[1] ?? null; }
export function frontmatterKeys(text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return [];
  return lines.slice(1, end).map(topLevelKeyOf).filter((key): key is string => key !== null);
}
function frontmatterValue(key: string, text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return null;
  const source = lines.slice(1, end).join("\n");
  const document = parseDocument(source);
  if (document.errors.length) fail(`invalid YAML frontmatter: ${document.errors[0]!.message}`, "Fix the frontmatter and retry.");
  const node = document.get(key, true);
  return isScalar(node) ? node.value === null ? "" : String(node.value) : null;
}
function skillDocument(mod: SkillMod, raw: string, id: HarnessId, source: string) {
  const lines = raw.split("\n");
  const end = frontmatterEnd(lines, true);
  const yaml = end === null ? "" : lines.slice(1, end).join("\n");
  const projected = applyBlocks(mod, id, yaml, source);
  const document = parseDocument(projected);
  if (document.errors.length) fail(`invalid YAML frontmatter: ${document.errors[0]!.message}`, "Fix the frontmatter and retry.");
  return { document, body: end === null ? raw : lines.slice(end + 1).join("\n") };
}

function applyFieldOverrides(project: Project, entry: SkillEntry, id: HarnessId, raw: string) {
  if (project.mod.version !== 2) return raw;
  const overrides = project.mod.fieldOverrides.filter((item) => item.skill === entry.name);
  const applicable = [...overrides.filter((item) => !item.agent), ...overrides.filter((item) => item.agent === id)];
  if (!applicable.length) return raw;
  const upstreamBody = bodyOf(raw, true);
  let body = upstreamBody;
  const document = applicable.some((item) => item.field !== "body") ? skillDocument(project.mod, raw, id, entry.name).document : null;
  const readValue = (value: FieldOverride["value"]) => value.kind === "string" ? value.text : readFileSync(resolveProjectPath(project, value.text, "file"), "utf8");
  for (const item of applicable) {
    if (item.operation === "replace") {
      const match = readValue(item.match);
      const start = body.indexOf(match);
      if (!match || start < 0 || body.indexOf(match, start + 1) >= 0) {
        const pin = entry.sourceKind === "canonical" || entry.sourceKind === "extra" ? undefined : readLock(project.root, false).find(({ ref }) => ref === entry.origin);
        fail(`${project.modPath}:${item.line}: ${item.skill}.body.replace${item.agent ? ` on ${item.agent}` : ""} expected ${JSON.stringify(item.match.text)} exactly once (${pin ? `locked revision ${pin.rev}` : "no locked revision"})`, "Use text that occurs exactly once in the skill body at this override, or remove the override.");
      }
      body = body.slice(0, start) + readValue(item.value) + body.slice(start + match.length);
    } else if (item.field === "body") {
      const value = readValue(item.value);
      body = item.operation === "append" ? body + value : value;
    } else {
      const value = readValue(item.value);
      const old = document!.get(item.field);
      document!.set(item.field, item.operation === "append" ? (old == null ? "" : String(old)) + value : value);
    }
  }
  if (document) return `---\n${document.toString({ lineWidth: 0 })}---\n${body}`;
  const prefix = raw.slice(0, raw.length - upstreamBody.length).replaceAll("\r\n", "\n");
  return prefix + (prefix && body && !prefix.endsWith("\n") ? "\n" : "") + body;
}
function bodyOf(text: string, crlf = false) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines, crlf);
  return end === null ? text : lines.slice(end + 1).join("\n");
}
function filterFrontmatter(text: string, allowed: string[]) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return text;
  let retainedField = false;
  const kept = lines.slice(1, end).filter((line) => {
    const key = topLevelKeyOf(line);
    if (key !== null) {
      retainedField = allowed.includes(key);
      return retainedField;
    }
    if (line === "" || line.startsWith("#")) return true;
    return /^\s/.test(line) && retainedField;
  });
  return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}
function frontmatterPlan(raw: string, rendered: string): FrontmatterPlan {
  const source = frontmatterKeys(raw);
  const result = frontmatterKeys(rendered);
  return { source, retained: source.filter((key) => result.includes(key)), omitted: source.filter((key) => !result.includes(key)), rendered: result };
}
function fenceMatch(line: string) { return line.match(/^\s*\{\{([#^])([a-z0-9 ._-]+)\}\}\s*$/); }
function fenceTargets(mod: SkillMod, list: string): HarnessId[] {
  const known: readonly string[] = mod.version === 2 ? [...new Set([...HARNESS_IDS, ...mod.agents.ids])] : HARNESS_IDS;
  const targets = list.trim().split(/\s+/);
  for (const name of targets) {
    if (!known.includes(name)) fail(`unknown harness ${name} in renderer fence`, `Use ${known.join(", ")}.`);
  }
  return targets;
}
function fenceTransforms(mod: SkillMod, id: HarnessId, text: string): Transformations["fences"] {
  return text.split("\n").flatMap((line) => {
    const match = fenceMatch(line);
    if (!match) return [];
    const targets = fenceTargets(mod, match[2]!);
    const listed = targets.includes(id);
    const include = match[1] === "#";
    return [{ kind: "fence" as const, mode: include ? "include" as const : "exclude" as const, targets, outcome: ((include && listed) || (!include && !listed)) ? "selected" as const : "omitted" as const }];
  });
}
// Code blocks and spans show markup as written, so examples of fences, tokens and $@ survive rendering.
// Hiding it character-for-character keeps line numbers for error locations.
const CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$|`[^`\n]+`/gm;
const HIDDEN_MARKUP: ReadonlyArray<readonly [string, string]> = [["{{", "\uE000"], ["}}", "\uE001"], ["$@", "\uE002"]];
function hideCodeMarkup(text: string) {
  return text.replace(CODE, (code) => HIDDEN_MARKUP.reduce((value, [markup, hidden]) => value.replaceAll(markup, hidden), code));
}
function showCodeMarkup(text: string) {
  return HIDDEN_MARKUP.reduce((value, [markup, hidden]) => value.replaceAll(hidden, markup), text);
}
function lineOf(text: string, needle: string) {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : text.slice(0, index).split("\n").length;
}
function applyBlocks(mod: SkillMod, id: HarnessId, text: string, source: string) {
  const out: string[] = [];
  let active = true;
  let inBlock = false;
  for (const [index, line] of text.split("\n").entries()) {
    const at = `${source}:${index + 1}`;
    const open = fenceMatch(line);
    if (open) {
      if (inBlock) fail(`${at}: nested renderer fences are not supported`, "Close the current fence with {{/}} before opening another.");
      const targets = fenceTargets(mod, open[2]!);
      const listed = targets.includes(id);
      active = open[1] === "#" ? listed : !listed;
      inBlock = true;
      continue;
    }
    if (/^\s*\{\{\/\}\}\s*$/.test(line)) {
      if (!inBlock) fail(`${at}: stray {{/}} renderer fence`, "Remove the close marker or add its opening fence.");
      active = true;
      inBlock = false;
      continue;
    }
    if (active) out.push(line);
  }
  if (inBlock) fail(`${source}: unclosed {{#...}} or {{^...}} fence`, "Add {{/}} on its own line.");
  return out.join("\n");
}
function renderText(mod: SkillMod, id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, text: string, source: string) {
  const hidden = hideCodeMarkup(text);
  let rendered = applyBlocks(mod, id, hidden, source);
  for (const name of Object.keys(tokens).sort()) rendered = rendered.replaceAll(`{{${name}}}`, tokens[name]!);
  rendered = rendered.replaceAll("$@", facts.argSyntax);
  const leftover = rendered.match(/\{\{([A-Za-z0-9_.^#/ -]*)\}\}/s);
  if (leftover) {
    const marker = `{{${leftover[1]}}}`;
    const at = `${source}:${lineOf(hidden, marker)}`;
    const asWritten = "or put it in a code span or code block to show it as written";
    if (/^[#^/]/.test(leftover[1]!)) fail(`${at}: renderer fence ${marker} is not on a line of its own`, `Move the fence to its own line, ${asWritten}.`);
    const known = Object.keys(tokens).sort().join(", ");
    fail(`${at}: unknown token ${marker} for ${id}`, `Define it in skill.mod${known ? ` (known tokens: ${known})` : ""}, ${asWritten}.`);
  }
  return showCodeMarkup(rendered);
}
function transformations(mod: SkillMod, id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, source: string): Transformations {
  const raw = hideCodeMarkup(source);
  return {
    fences: fenceTransforms(mod, id, raw),
    tokens: Object.keys(tokens).sort().filter((name) => raw.includes(`{{${name}}}`)).map((name) => ({ kind: "token-substituted", token: name, value: tokens[name]! })),
    argSyntax: raw.includes("$@") ? { kind: "arg-syntax-substituted", from: "$@", to: facts.argSyntax } : null,
    command: [],
  };
}
function renderSkill(mod: SkillMod, id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string, source: string) {
  return filterFrontmatter(renderText(mod, id, facts, tokens, raw, source), facts.skillFrontmatter);
}
function renderCommand(mod: SkillMod, id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string, source: string) {
  return filterFrontmatter(renderText(mod, id, facts, tokens, raw, source), facts.commandFrontmatter);
}
function walkSupport(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return walkSupport(root, path);
    if (entry.isFile()) return [path];
    fail(`unsupported support file kind: ${join(root, path)}`, "Use regular files and directories in skill support content.");
  }).sort();
}
function supportFiles(entry: SkillEntry, deliveryRoot: string): SupportFilePlan[] {
  const dir = join(entry.root, entry.name);
  return walkSupport(dir).filter((path) => !["SKILL.md", "COMMAND.md", "SOURCE.md"].includes(path)).map((path) => {
    const content = readFileSync(join(dir, path));
    return { source: { path: sourcePath(entry, path) }, delivery: { kind: "file", path: `${deliveryRoot}/${path.replaceAll("\\", "/")}` }, sha256: sha256(content), copied: "verbatim", markup: content.includes(Buffer.from("{{")) || content.includes(Buffer.from("$@")), sourcePath: join(dir, path), generatedBody: null, relativePath: path };
  });
}
function omissionCode(omission: Omission) {
  // schemaVersion 1 established stable omission codes. Preserve them in later
  // manifests even though the generic model has no dedicated code field.
  if (omission.selector === "image-to-svg" && omission.reason === "Requires pi image conversion tools.") return "requires-pi-image-tools";
  if (omission.selector === "subagents" && omission.reason === "Requires the pi subagent extension.") return "pi-extension-only";
  return "project-omission";
}
export function publicSkill(skill: SkillPlan) {
  const { sourceDir: _sourceDir, ...publicPlan } = skill;
  return {
    ...publicPlan,
    supportFiles: publicPlan.supportFiles.map(({ sourcePath: _sourcePath, generatedBody: _generatedBody, relativePath: _relativePath, ...support }) => support),
  };
}

function setupFor(project: Project, name: string): Setup {
  const setup = project.mod.setups[name];
  if (setup) return setup;
  const known = Object.keys(project.mod.setups).sort();
  fail(`unknown setup: ${name}`, `Choose one of: ${known.join(", ") || "none declared"}.`);
}

function unknownSkill(project: Project, line: number, name: string, context: string): never {
  throw new ModError(project.modPath, line, 1, `unknown skill ${name} ${context}`, "Use an exact skill name provided by the declared source or selected by this project.");
}
export function resolveSkills(project: Project, overrides: Record<string, string>, extras: ExtraRoot[] = []) {
  const declared = new Set(project.mod.requires.map((requirement) => requirement.name));
  for (const name of Object.keys(overrides)) if (!declared.has(name)) fail(`override ${name} is not declared in skill.mod`, `Add a matching require or remove --override ${name}=PATH.`);
  const canonicalRoot = resolveLocalRoot(project, "skills");
  const skills: SkillEntry[] = canonicalRoot ? sortedDirectoryNames(canonicalRoot).map((name) => ({ name, origin: "canonical", root: canonicalRoot, sourceKind: "canonical" })) : [];
  for (const requirement of project.mod.requires) {
    const root = dependencyRoot(requirement, project, overrides);
    const names = sortedDirectoryNames(root.path).filter((candidate) => selectedBy(requirement, candidate));
    if (requirement.line !== undefined) {
      for (const name of requirement.selectors) if (!names.includes(name) || !existsSync(join(root.path, name, "SKILL.md"))) unknownSkill(project, requirement.line, name, `in use ${requirement.ref}`);
    }
    for (const name of names) skills.push({ name, origin: requirement.name, root: root.path, sourceKind: root.kind });
  }
  for (const extra of extras) {
    if (!extra.origin) fail("extra skill root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra skill root ${extra.origin}`);
    for (const name of sortedDirectoryNames(root)) skills.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  for (const entry of skills) if (!existsSync(join(entry.root, entry.name, "SKILL.md"))) fail(`skill ${entry.name} from ${entry.origin} has no SKILL.md`, `Add ${join(entry.root, entry.name, "SKILL.md")} or exclude the skill.`);
  uniqueByName(skills, "skill");
  return skills;
}

function resolveEntries(project: Project, options: ResolveOptions) {
  const skills = resolveSkills(project, options.overrides ?? {}, options.extraRoots?.skills);
  const setup = options.setup ? setupFor(project, options.setup) : undefined;
  const knownSkills = new Set(skills.map((entry) => entry.name));
  const mod = project.mod;
  if (mod.version === 2) {
    for (const skip of mod.skips) for (const name of skip.skills) if (!knownSkills.has(name)) unknownSkill(project, skip.line, name, "in skip");
    for (const only of mod.only) for (const name of only.skills) if (!knownSkills.has(name)) unknownSkill(project, only.line, name, "in only");
    for (const { skill, field, line } of mod.fieldOverrides) if (!knownSkills.has(skill)) unknownSkill(project, line, skill, `in ${field === "body" ? "body" : "front-matter"} override`);
    for (const machine of Object.values(mod.setups)) for (const selector of machine.selectors) {
      if (!knownSkills.has(selector.name)) unknownSkill(project, selector.line!, selector.name, `in machine ${machine.name}`);
    }
  } else {
    for (const selector of setup?.selectors ?? []) if (!knownSkills.has(selector.name)) fail(`unknown skill ${selector.name} in setup ${setup!.name}`, "Use an exact skill name from `skillful list skills`.");
  }
  const selectedSkills = setup?.mode === "only"
    ? skills.filter((entry) => setup.selectors.some((selector) => selector.name === entry.name))
    : setup?.mode === "omit"
      ? skills.filter((entry) => !setup.selectors.some((selector) => selector.name === entry.name))
      : skills;
  const selectedNames = new Set(selectedSkills.map((entry) => entry.name));
  const setupOmissions = Object.fromEntries(skills.filter((entry) => !selectedNames.has(entry.name)).map((entry) => {
    const selector = setup?.selectors.find((candidate) => candidate.name === entry.name);
    return [entry.name, { code: "setup-omission", message: selector?.reason ?? `Not selected by setup ${setup!.name}.` }];
  }));

  const commandRoot = resolveLocalRoot(project, "commands");
  const commands: CommandEntry[] = commandRoot ? sortedMarkdown(commandRoot).map((name) => ({ name, origin: "canonical", root: commandRoot, sourceKind: "standalone" })) : [];
  for (const extra of options.extraRoots?.commands ?? []) {
    if (!extra.origin) fail("extra command root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra command root ${extra.origin}`);
    for (const name of sortedMarkdown(root)) commands.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  uniqueByName(commands, "command");
  return { skills: selectedSkills, allSkills: skills, commands, setupOmissions };
}

export function replacementKey(origin: string, item: FieldOverride) {
  return sha256(JSON.stringify([origin, item.skill, item.field, item.agent]));
}

export function replacementHash(mod: SkillMod, raw: string, item: FieldOverride) {
  return item.field === "body" ? sha256(bodyOf(raw, true)) : sha256(JSON.stringify((item.agent ? [item.agent] : HARNESS_IDS).map((id) => {
    const { document } = skillDocument(mod, raw, id, item.skill);
    return [document.has(item.field), document.toJS({ mapAsMap: true })?.get(item.field)];
  }), (_, value) => value instanceof Map ? Object.fromEntries(value) : value));
}

export const sharedSkillsPath = ".agents/skills";
export function skillRoot(id: HarnessId) {
  return id === "pi" ? ".pi/agent" : (HARNESS_IDS as readonly string[]).includes(id) ? `.${id}` : `.harness-${id}`;
}

function skillOmissions(project: Project, id: HarnessId, setupOmissions: HarnessPlan["omittedSkills"]) {
  const mod = project.mod;
  const omissions = mod.harnesses[id]?.omissions ?? [];
  const excluded = new Map<string, HarnessPlan["omittedSkills"][string]>();
  if (mod.version === 2) {
    const included = new Set(mod.only.filter(({ agents }) => agents.includes(id)).flatMap(({ skills }) => skills));
    for (const { skills, reason } of mod.only) for (const selector of skills) {
      if (!included.has(selector)) excluded.set(selector, { code: "project-omission", message: reason });
    }
  }
  return { ...setupOmissions, ...Object.fromEntries(excluded), ...Object.fromEntries(omissions.filter((item) => item.kind === "omit-skill").map((item) => [item.selector, { code: omissionCode(item), message: item.reason }])) };
}

const agentSkillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function buildAuthoredSkills(project: Project, id: HarnessId, facts: HarnessFacts, skillPath: string, selectedEntries: SkillEntry[]): SkillPlan[] {
  const tokens = project.mod.harnesses[id]?.tokens ?? {};
  const v2 = project.mod.version === 2;
  return selectedEntries.map((entry) => {
    const raw = readFileSync(join(entry.root, entry.name, "SKILL.md"), "utf8");
    const overridden = applyFieldOverrides(project, entry, id, raw);
    const source = v2 ? overridden.replaceAll("\r\n", "\n") : overridden;
    const body = renderSkill(project.mod, id, facts, tokens, source, sourcePath(entry, "SKILL.md"));
    if (facts.agentSkillNames && (entry.name.length > 64 || !agentSkillName.test(entry.name))) fail(`invalid Agent Skill name ${JSON.stringify(entry.name)} rendered for ${id}`, "Rename the skill using at most 64 lowercase letters, numbers, and single hyphens.");
    return {
      name: entry.name,
      description: frontmatterValue("description", body),
      origin: entry.origin,
      source: skillSource(entry),
      delivery: { kind: "file", path: `${skillPath}/${entry.name}/SKILL.md` },
      sha256: sha256(body),
      frontmatter: frontmatterPlan(v2 ? raw.replaceAll("\r\n", "\n") : raw, body),
      transformations: transformations(project.mod, id, facts, tokens, source),
      supportFiles: supportFiles(entry, `${skillPath}/${entry.name}`),
      body,
      sourceDir: join(entry.root, entry.name),
    };
  });
}

function skillPlacements(mod: Project["mod"], skills: ReadonlyMap<HarnessId, SkillPlan[]>, readsShared: (id: HarnessId) => boolean) {
  const readers = [...skills.keys()].filter(readsShared);
  const privateSkills = new Set(mod.version === 2 ? [
    ...mod.skips.filter(({ agents }) => agents.some(readsShared)).flatMap(({ skills }) => skills),
  ] : []);
  const placements: SkillPlacement[] = [];
  const candidates = new Map<string, SkillPlacement[]>();
  for (const [id, plans] of skills) for (const skill of plans) {
    const perHarness = mod.version === 1 || skill.transformations.command.length > 0;
    const placement = { id, skill, root: perHarness ? id : skillRoot(id) };
    placements.push(placement);
    if (!perHarness && readsShared(id) && !privateSkills.has(skill.name)) {
      const group = candidates.get(skill.name) ?? [];
      group.push(placement);
      candidates.set(skill.name, group);
    }
  }
  for (const group of candidates.values()) {
    const first = group[0]!.skill;
    if (group.length < 2 || group.length !== readers.length || !group.every(({ skill }) => skill.sha256 === first.sha256 &&
      skill.supportFiles.length === first.supportFiles.length && skill.supportFiles.every((file, i) =>
        file.relativePath === first.supportFiles[i]!.relativePath && file.sha256 === first.supportFiles[i]!.sha256))) continue;
    for (const placement of group) {
      placement.root = ".agents";
      const { skill } = placement;
      const root = `${sharedSkillsPath}/${skill.name}`;
      skill.delivery.path = `${root}/SKILL.md`;
      for (const file of skill.supportFiles) file.delivery.path = `${root}/${file.relativePath.replaceAll("\\", "/")}`;
    }
  }
  return placements;
}

function buildHarness(project: Project, id: HarnessId, facts: HarnessFacts, installPaths: HarnessInstallPaths, entries: ReturnType<typeof resolveEntries>): HarnessPlan {
  const config = project.mod.harnesses[id];
  const tokens = config?.tokens ?? {};
  const omissions = config?.omissions ?? [];
  const omittedSkills = skillOmissions(project, id, entries.setupOmissions);
  const omittedCommands = new Set(omissions.filter((item) => item.kind === "omit-command").flatMap((item) => [item.selector, item.selector.endsWith(".md") ? item.selector : `${item.selector}.md`]));
  const selectedEntries = entries.skills.filter((entry) => !omittedSkills[entry.name]);
  const selectedCommands = entries.commands.filter((entry) => !omittedCommands.has(entry.name));
  const attached = selectedEntries.find((entry) => entry.sourceKind === "canonical" && existsSync(join(entry.root, entry.name, "COMMAND.md")));
  if (attached) fail(`skills/${attached.name}/COMMAND.md is not supported`, "A command is a saved prompt, separate from any skill. Move it to commands/ under a name no skill uses, or delete it and invoke the skill directly.");
  const skillNames = new Set(selectedEntries.map((entry) => entry.name));
  const clashes = selectedCommands.map((entry) => entry.name.replace(/\.md$/, "")).filter((name) => skillNames.has(name));
  // Harnesses that deliver commands as skills, or register skills as commands, cannot hold both under one name.
  if (clashes.length) fail(`commands share a name with skills for ${id}: ${clashes.join(", ")}`, "Rename the command or omit one of them.");
  const commandsAsSkills = facts.commandMerge === "skill";
  const commandRoot = installPaths.commands;
  if (!commandsAsSkills && !commandRoot) fail(`harness ${id} has no command destination`, "Repair its bundled harness facts.");

  const commands: CommandPlan[] = commandsAsSkills ? [] : selectedCommands.map((entry) => {
    const raw = readFileSync(join(entry.root, entry.name), "utf8");
    const body = renderCommand(project.mod, id, facts, tokens, raw, commandSource(entry).path!);
    return { name: entry.name, source: commandSource(entry), delivery: { kind: "file", path: `${commandRoot!}/${entry.name}` }, sha256: sha256(body), frontmatter: frontmatterPlan(raw, body), transformations: transformations(project.mod, id, facts, tokens, raw), body };
  });
  uniqueByName(commands.map((command) => ({ name: command.name, origin: command.source.origin ?? command.source.kind })), `delivered command for ${id}`);

  const authoredSkills = buildAuthoredSkills(project, id, facts, installPaths.skills, selectedEntries);

  // Without saved prompts, a command becomes a skill only the person can invoke.
  const syntheticSkills: SkillPlan[] = commandsAsSkills ? selectedCommands.map((entry) => {
    const name = entry.name.replace(/\.md$/, "");
    if (facts.agentSkillNames && (name.length > 64 || !agentSkillName.test(name))) fail(`invalid Agent Skill name ${JSON.stringify(name)} synthesized from command ${entry.name} for ${id}`, "Rename the command using at most 64 lowercase letters, numbers, and single hyphens.");
    const raw = readFileSync(join(entry.root, entry.name), "utf8");
    const rendered = renderText(project.mod, id, facts, tokens, raw, commandSource(entry).path!);
    const description = frontmatterValue("description", rendered) ?? `Run the ${name} prompt when explicitly invoked.`;
    const hint = frontmatterValue("argument-hint", rendered);
    const extra = [
      ...(hint && facts.skillFrontmatter.includes("argument-hint") ? [`argument-hint: ${JSON.stringify(hint)}`] : []),
      ...Object.entries(facts.syntheticSkillFrontmatter ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : JSON.stringify(value)}`),
    ];
    const body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${extra.length ? `\n${extra.join("\n")}` : ""}\n---\n\n${bodyOf(rendered).replace(/^\n/, "")}`;
    const commandTransforms = transformations(project.mod, id, facts, tokens, raw);
    commandTransforms.command = ["command-synthesized-as-skill"];
    return {
      name,
      description,
      origin: entry.origin,
      source: commandSource(entry),
      delivery: { kind: "file", path: `${installPaths.skills}/${name}/SKILL.md` },
      sha256: sha256(body),
      frontmatter: frontmatterPlan(raw, body),
      transformations: commandTransforms,
      supportFiles: Object.entries(facts.syntheticSkillFiles ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([path, generatedBody]) => ({ source: { path: null }, delivery: { kind: "file", path: `${installPaths.skills}/${name}/${path}` }, sha256: sha256(generatedBody), copied: "generated", markup: false, sourcePath: null, generatedBody, relativePath: path })),
      body,
      sourceDir: entry.root,
    };
  }) : [];
  const skills = [...authoredSkills, ...syntheticSkills].sort((left, right) => left.name.localeCompare(right.name));

  const rulesPath = resolveLocalRoot(project, "rules");
  const rulesBody = rulesPath ? renderText(project.mod, id, facts, tokens, readFileSync(rulesPath, "utf8"), project.mod.roots.rules) : "";
  return {
    id,
    facts,
    profile: { argSyntax: facts.argSyntax, installPaths, commandMerge: facts.commandMerge, exclusions: omittedSkills, excludeCommands: [...omittedCommands].sort(), commandExclude: [] },
    omittedSkills,
    skills,
    commands,
    rules: { source: { kind: "canonical", path: "rules/global_agents.md" }, delivery: rulesPath && installPaths.rules ? { kind: "file", path: installPaths.rules } : null, sha256: sha256(rulesBody), body: rulesBody },
    assets: [],
  };
}

export function resolvePlan(project: Project, options: ResolveOptions = {}, previouslyRendered: HarnessId[] = []): ProjectPlan {
  const setup = options.setup ? setupFor(project, options.setup) : null;
  const selected = [...new Set(options.harnesses?.length
    ? options.harnesses
    : setup
      ? setup.harnesses.map((harness) => harness.id)
      : project.mod.version === 2
        ? project.mod.agents.ids
        : HARNESS_IDS.filter((id) => project.mod.harnesses[id] !== undefined))];
  if (!selected.length) fail("project selects no harnesses", project.mod.version === 2 ? "List agents in skill.mod or pass --harness." : "Declare a harness in skill.mod, select one through a setup, or pass --harness.");
  const facts = loadHarnesses();
  const paths = cachedDependencyPaths(project, options.overrides);
  const entries = resolveEntries(project, { ...options, overrides: paths });
  const scope = setup?.root ?? "home";
  const harnesses: ProjectPlan["harnesses"] = Object.create(null);
  const mod = project.mod;
  const declarations = (id: HarnessId) => mod.version === 2
    ? [mod.declarations.find((entry) => entry.id === id), setup?.declarations?.find((entry) => entry.id === id)]
    : [];
  const readsShared = (id: HarnessId) => agentReadsShared(mod, id, setup);
  const profile = (id: HarnessId) => {
    const builtin = Object.hasOwn(facts, id) ? facts[id as BuiltinHarnessId] : undefined;
    const overrides = Object.assign({}, ...declarations(id).map((entry) => entry?.paths));
    const installPaths: HarnessInstallPaths = {
      ...builtin?.installPaths[scope],
      ...(mod.version === 2 && id === "codex" ? { skills: ".codex/skills" } : {}),
      ...(mod.version === 2 && id === "claude" ? { rules: ".claude/CLAUDE.md" } : {}),
      ...overrides,
    };
    if (!installPaths.skills) fail(`agent ${id} has no skills path${setup ? ` on machine ${setup.name}` : ""}`, `Declare a skills path in harness ${id}.`);
    const resolved: HarnessFacts = {
      name: id, argSyntax: "$@",
      skillFrontmatter: ["name", "description"], commandFrontmatter: ["description", "argument-hint"], commandMerge: "skill",
      ...builtin,
      installPaths: { home: installPaths, project: installPaths },
      ...(overrides.commands ? { commandMerge: "file" } : {}),
    };
    return { facts: resolved, installPaths };
  };
  const skills = new Map<HarnessId, SkillPlan[]>();
  for (const id of selected) {
    const resolved = profile(id);
    const plan = buildHarness(project, id, resolved.facts, resolved.installPaths, entries);
    harnesses[id] = plan;
    skills.set(id, plan.skills);
  }
  if (mod.version === 2 && options.harnesses?.some(readsShared)) {
    for (const id of [...(setup?.harnesses.map(({ id }) => id) ?? mod.agents.ids), ...previouslyRendered]) {
      if (!readsShared(id) || skills.has(id)) continue;
      const omitted = skillOmissions(project, id, entries.setupOmissions);
      const resolved = profile(id);
      skills.set(id, buildAuthoredSkills(project, id, resolved.facts, resolved.installPaths.skills, entries.skills.filter((entry) => !omitted[entry.name])));
    }
  }
  const placements: SkillPlacement[] = [];
  const placed = new Set<string>();
  for (const placement of skillPlacements(mod, skills, readsShared)) {
    const { id, root, skill } = placement;
    if (!selected.includes(id) && !previouslyRendered.includes(id)) continue;
    const path = `${root}/skills/${skill.name}`;
    if (placed.has(path)) continue;
    placed.add(path);
    placements.push(placement);
  }
  const baselines = project.mod.version === 2 && project.mod.fieldOverrides.some((item) => item.operation === "set") ? readOverrideBaselines(project.root) : new Map<string, string>();
  const changedOverrides = baselines.size && project.mod.version === 2 ? project.mod.fieldOverrides.filter((item) => {
    if (item.operation !== "set") return false;
    const entry = entries.allSkills.find(({ name }) => name === item.skill)!;
    const old = baselines.get(replacementKey(entry.origin, item));
    return old !== undefined && old !== replacementHash(project.mod, readFileSync(join(entry.root, entry.name, "SKILL.md"), "utf8"), item);
  }) : [];
  const regroupedSkills = new Map(previouslyRendered.filter((id) => !selected.includes(id)).map((id) => [id, skills.get(id)!]));
  return { project, harnesses, placements, regroupedSkills, changedOverrides };
}
export function schemaFor(project: Project) {
  const facts = loadHarnesses();
  return {
    markup: ["{{token}}", "{{#harness}}", "{{^harness}}", "{{/}}", "$@"],
    harnesses: mapHarnesses((id) => {
      const value = facts[id];
      return { argSyntax: value.argSyntax, tokens: project.mod.harnesses[id]?.tokens ?? {}, skillFrontmatter: value.skillFrontmatter, commandFrontmatter: value.commandFrontmatter, commandMerge: value.commandMerge, agentSkillNames: value.agentSkillNames === true };
    }),
  };
}
export function contractFor(plan: ProjectPlan) {
  return {
    schemaVersion: 1,
    schema: schemaFor(plan.project),
    manifest: {
      setups: Object.fromEntries(Object.values(plan.project.mod.setups).sort((a, b) => a.name.localeCompare(b.name)).map((setup) => [setup.name, {
        root: setup.root,
        selection: { mode: setup.mode ?? "all", skills: setup.selectors.map(({ name, reason }) => ({ name, ...(reason ? { reason } : {}) })) },
        harnesses: setup.harnesses.map((harness) => ({ name: harness.id, paths: harness.paths })),
      }])),
      harnesses: Object.fromEntries(harnessIds(plan).map((id) => {
        const harness = harnessPlan(plan, id);
        return [id, { profile: harness.profile, skills: harness.skills.map(publicSkill), omittedSkills: harness.omittedSkills, commands: harness.commands, rules: { source: harness.rules.source, delivery: harness.rules.delivery, sha256: harness.rules.sha256 }, assets: [] }];
      })),
    },
  };
}
