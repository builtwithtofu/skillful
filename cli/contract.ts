import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadHarnesses, type HarnessFacts } from "./harness.ts";
import { HARNESS_IDS, mapHarnesses, type HarnessId, type Omission, type Require, type Setup } from "./mod.ts";
import { resolveProjectPath, type Project } from "./project.ts";
import { cachedDependencyPaths } from "./deps.ts";

export type ExtraRoot = { origin: string; path: string };
export type ResolveOptions = {
  overrides?: Record<string, string> | undefined;
  extraRoots?: { skills?: ExtraRoot[] | undefined; commands?: ExtraRoot[] | undefined } | undefined;
  setup?: string | undefined;
};

type Source = { kind: string; origin?: string | null; path: string | null };
type Transformations = {
  fences: Array<{ kind: "fence"; mode: "include" | "exclude"; targets: HarnessId[]; outcome: "selected" | "omitted" }>;
  tokens: Array<{ kind: "token-substituted"; token: string; value: string }>;
  argSyntax: { kind: "arg-syntax-substituted"; from: "$@"; to: string } | null;
  command: string[];
};
export type SupportFilePlan = {
  source: { path: string };
  delivery: { kind: "file"; path: string };
  sha256: string;
  copied: "verbatim";
  markup: boolean;
  sourcePath: string;
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
  command: CommandDisposition;
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
export type CommandDisposition = {
  source: "co-located" | "standalone" | "generated" | "none";
  delivery: "injected" | "file" | "none";
  reason: string;
  authoring: Source | null;
  target: { path: string; sha256: string } | null;
  body: string | null;
  frontmatter?: FrontmatterPlan;
  transformations?: Transformations;
};
export type FrontmatterPlan = { source: string[]; retained: string[]; omitted: string[]; rendered: string[] };
export type HarnessPlan = {
  id: HarnessId;
  facts: HarnessFacts;
  profile: {
    argSyntax: string;
    installPaths: HarnessFacts["installPaths"];
    commandMerge: "inject" | "file";
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
export type ProjectPlan = { project: Project; harnesses: Record<HarnessId, HarnessPlan> };

type SkillEntry = { name: string; origin: string; root: string; sourceKind: "canonical" | "external" | "override" | "extra" };
type CommandEntry = { name: string; origin: string; root: string; sourceKind: "standalone" | "external" | "extra" };

export class ContractError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
function fail(message: string, recovery: string): never { throw new ContractError(message, `Recovery: ${recovery}`); }
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

function frontmatterEnd(lines: string[]) {
  if (lines[0] !== "---") return null;
  for (let index = 1; index < lines.length; index++) if (lines[index] === "---") return index;
  return null;
}
function keyOf(line: string) { return line.split(":", 1)[0] ?? ""; }
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
  const line = lines.slice(1, end).find((candidate) => keyOf(candidate) === key);
  if (!line) return null;
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (raw.includes('"')) {
    if (!(raw.startsWith('"') && raw.endsWith('"')) || raw.slice(1, -1).includes('"')) return null;
    try { return JSON.parse(raw) as string; } catch { return null; }
  }
  return raw;
}
function bodyOf(text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
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
function fenceMatch(line: string) { return line.match(/^\s*\{\{([#^])([a-z0-9 -]+)\}\}\s*$/); }
function canonicalHarness(name: string): HarnessId {
  if ((HARNESS_IDS as readonly string[]).includes(name)) return name as HarnessId;
  fail(`unknown harness ${name} in renderer fence`, `Use ${HARNESS_IDS.join(", ")}.`);
}
function fenceTransforms(id: HarnessId, text: string): Transformations["fences"] {
  return text.split("\n").flatMap((line) => {
    const match = fenceMatch(line);
    if (!match) return [];
    const targets = match[2]!.trim().split(/\s+/).map(canonicalHarness);
    const listed = targets.includes(id);
    const include = match[1] === "#";
    return [{ kind: "fence" as const, mode: include ? "include" as const : "exclude" as const, targets, outcome: ((include && listed) || (!include && !listed)) ? "selected" as const : "omitted" as const }];
  });
}
export function applyBlocks(id: HarnessId, text: string) {
  const out: string[] = [];
  let active = true;
  let inBlock = false;
  for (const line of text.split("\n")) {
    const open = fenceMatch(line);
    if (open) {
      if (inBlock) fail("nested renderer fences are not supported", "Close the current fence with {{/}} before opening another.");
      const targets = open[2]!.trim().split(/\s+/).map(canonicalHarness);
      const listed = targets.includes(id);
      active = open[1] === "#" ? listed : !listed;
      inBlock = true;
      continue;
    }
    if (/^\s*\{\{\/\}\}\s*$/.test(line)) {
      if (!inBlock) fail("stray {{/}} renderer fence", "Remove the close marker or add its opening fence.");
      active = true;
      inBlock = false;
      continue;
    }
    if (active) out.push(line);
  }
  if (inBlock) fail("unclosed {{#...}} or {{^...}} fence", "Add {{/}} on its own line.");
  return out.join("\n");
}
function renderText(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, text: string) {
  let rendered = applyBlocks(id, text);
  for (const name of Object.keys(tokens).sort()) rendered = rendered.replaceAll(`{{${name}}}`, tokens[name]!);
  rendered = rendered.replaceAll("$@", facts.argSyntax);
  const leftover = rendered.match(/\{\{([A-Za-z0-9_.^#/ -]*)\}\}/s);
  if (leftover) fail(`unresolved {{${leftover[1]}}} after rendering for ${id}`, `Define the token for ${id} or repair the fence. Known tokens: ${Object.keys(tokens).sort().join(", ") || "none"}.`);
  return rendered;
}
function transformations(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string): Transformations {
  return {
    fences: fenceTransforms(id, raw),
    tokens: Object.keys(tokens).sort().filter((name) => raw.includes(`{{${name}}}`)).map((name) => ({ kind: "token-substituted", token: name, value: tokens[name]! })),
    argSyntax: raw.includes("$@") ? { kind: "arg-syntax-substituted", from: "$@", to: facts.argSyntax } : null,
    command: [],
  };
}
function renderSkill(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string) {
  return filterFrontmatter(renderText(id, facts, tokens, raw), facts.skillFrontmatter);
}
function renderCommand(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string) {
  return filterFrontmatter(renderText(id, facts, tokens, raw), facts.commandFrontmatter);
}
function injectCommand(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, skillText: string, commandRaw: string) {
  const command = renderText(id, facts, tokens, commandRaw);
  const hint = frontmatterValue("argument-hint", command);
  const skillLines = skillText.split("\n");
  const end = frontmatterEnd(skillLines);
  const existing = end === null ? [] : skillLines.slice(1, end);
  if (hint && !existing.some((line) => keyOf(line) === "argument-hint") && facts.skillFrontmatter.includes("argument-hint")) existing.push(`argument-hint: ${hint}`);
  return `---\n${existing.join("\n")}\n---\n\n${bodyOf(command)}\n\n${bodyOf(skillText)}`;
}
function router(facts: HarnessFacts, name: string, skillRaw: string) {
  const hint = frontmatterValue("argument-hint", skillRaw);
  const fm = [`description: Run the ${name} workflow`];
  if (hint && facts.commandFrontmatter.includes("argument-hint")) fm.push(`argument-hint: ${hint}`);
  return `---\n${fm.join("\n")}\n---\n\nUse the \`${name}\` skill.\n\n${facts.argSyntax}\n`;
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
    return { source: { path: sourcePath(entry, path) }, delivery: { kind: "file", path: `${deliveryRoot}/${path.replaceAll("\\", "/")}` }, sha256: sha256(content), copied: "verbatim", markup: content.includes(Buffer.from("{{")) || content.includes(Buffer.from("$@")), sourcePath: join(dir, path), relativePath: path };
  });
}
function omissionCode(omission: Omission) {
  // schemaVersion 1 historically exposed stable codes. The generic manifest has
  // no code field, so preserve known legacy codes and use a stable generic code
  // for new omissions until schemaVersion 2 can carry explicit structured data.
  if (omission.selector === "image-to-svg" && omission.reason === "Requires pi image conversion tools.") return "requires-pi-image-tools";
  if (omission.selector === "subagents" && omission.reason === "Requires the pi subagent extension.") return "pi-extension-only";
  return "project-omission";
}
function publicSkill(skill: SkillPlan) {
  const { sourceDir: _sourceDir, ...publicPlan } = skill;
  return {
    ...publicPlan,
    supportFiles: publicPlan.supportFiles.map(({ sourcePath: _sourcePath, relativePath: _relativePath, ...support }) => support),
  };
}

function setupFor(project: Project, name: string): Setup {
  const setup = project.mod.setups[name];
  if (setup) return setup;
  const known = Object.keys(project.mod.setups).sort();
  fail(`unknown setup: ${name}`, `Choose one of: ${known.join(", ") || "none declared"}.`);
}

function resolveEntries(project: Project, options: ResolveOptions) {
  const overrides = options.overrides ?? {};
  const declared = new Set(project.mod.requires.map((requirement) => requirement.name));
  for (const name of Object.keys(overrides)) if (!declared.has(name)) fail(`override ${name} is not declared in skill.mod`, `Add a matching require or remove --override ${name}=PATH.`);
  const canonicalRoot = resolveProjectPath(project, project.mod.roots.skills, "directory");
  const skills: SkillEntry[] = sortedDirectoryNames(canonicalRoot).map((name) => ({ name, origin: "canonical", root: canonicalRoot, sourceKind: "canonical" }));
  for (const requirement of project.mod.requires) {
    const root = dependencyRoot(requirement, project, overrides);
    for (const name of sortedDirectoryNames(root.path).filter((candidate) => selectedBy(requirement, candidate))) skills.push({ name, origin: requirement.name, root: root.path, sourceKind: root.kind });
  }
  for (const extra of options.extraRoots?.skills ?? []) {
    if (!extra.origin) fail("extra skill root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra skill root ${extra.origin}`);
    for (const name of sortedDirectoryNames(root)) skills.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  for (const entry of skills) if (!existsSync(join(entry.root, entry.name, "SKILL.md"))) fail(`skill ${entry.name} from ${entry.origin} has no SKILL.md`, `Add ${join(entry.root, entry.name, "SKILL.md")} or exclude the skill.`);
  uniqueByName(skills, "skill");
  const setup = options.setup ? setupFor(project, options.setup) : undefined;
  const knownSkills = new Set(skills.map((entry) => entry.name));
  for (const selector of setup?.selectors ?? []) if (!knownSkills.has(selector.name)) fail(`unknown skill ${selector.name} in setup ${setup!.name}`, "Use an exact skill name from `skillful list skills`.");
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

  const commandRoot = resolveProjectPath(project, project.mod.roots.commands, "directory");
  const commands: CommandEntry[] = sortedMarkdown(commandRoot).map((name) => ({ name, origin: "canonical", root: commandRoot, sourceKind: "standalone" }));
  for (const extra of options.extraRoots?.commands ?? []) {
    if (!extra.origin) fail("extra command root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra command root ${extra.origin}`);
    for (const name of sortedMarkdown(root)) commands.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  uniqueByName(commands, "command");
  return { skills: selectedSkills, commands, setupOmissions };
}

function buildHarness(project: Project, id: HarnessId, facts: HarnessFacts, entries: ReturnType<typeof resolveEntries>): HarnessPlan {
  const config = project.mod.harnesses[id];
  const tokens = config?.tokens ?? {};
  const omissions = config?.omissions ?? [];
  const omittedSkills = { ...entries.setupOmissions, ...Object.fromEntries(omissions.filter((item) => item.kind === "omit-skill").map((item) => [item.selector, { code: omissionCode(item), message: item.reason }])) };
  const omittedCommands = new Set(omissions.filter((item) => item.kind === "omit-command").flatMap((item) => [item.selector, item.selector.endsWith(".md") ? item.selector : `${item.selector}.md`]));
  const selectedEntries = entries.skills.filter((entry) => !omittedSkills[entry.name]);
  const selectedNames = new Set(selectedEntries.map((entry) => entry.name));
  const canonicalEntries = selectedEntries.filter((entry) => entry.sourceKind === "canonical");
  const coLocated = new Map(canonicalEntries.filter((entry) => existsSync(join(entry.root, entry.name, "COMMAND.md"))).map((entry) => [entry.name, entry]));
  const standaloneBySelector = new Map(entries.commands.map((entry) => [entry.name.replace(/\.md$/, ""), entry]));
  const merge = facts.commandMerge === "inject";
  const commands: CommandPlan[] = [];

  if (!merge) for (const [name, entry] of coLocated) {
    const fileName = `${name}.md`;
    if (omittedCommands.has(fileName)) continue;
    const raw = readFileSync(join(entry.root, name, "COMMAND.md"), "utf8");
    const body = `${renderCommand(id, facts, tokens, raw)}\nUse the \`${name}\` skill.\n`;
    commands.push({ name: fileName, source: { kind: "co-located", origin: "canonical", path: `skills/${name}/COMMAND.md` }, delivery: { kind: "file", path: `${facts.installPaths.commands}/${fileName}` }, sha256: sha256(body), frontmatter: frontmatterPlan(raw, body), transformations: transformations(id, facts, tokens, raw), body });
  }
  for (const entry of entries.commands) {
    const selector = entry.name.replace(/\.md$/, "");
    if (omittedCommands.has(entry.name) || (merge && selectedNames.has(selector))) continue;
    const raw = readFileSync(join(entry.root, entry.name), "utf8");
    const body = renderCommand(id, facts, tokens, raw);
    commands.push({ name: entry.name, source: commandSource(entry), delivery: { kind: "file", path: `${facts.installPaths.commands}/${entry.name}` }, sha256: sha256(body), frontmatter: frontmatterPlan(raw, body), transformations: transformations(id, facts, tokens, raw), body });
  }
  const covered = new Set([...coLocated.keys(), ...entries.commands.map((entry) => entry.name.replace(/\.md$/, ""))]);
  if (!merge) for (const entry of canonicalEntries) {
    if (covered.has(entry.name) || omittedCommands.has(entry.name) || omittedCommands.has(`${entry.name}.md`)) continue;
    const raw = readFileSync(join(entry.root, entry.name, "SKILL.md"), "utf8");
    if (frontmatterValue("user-invocable", raw) === "false") continue;
    const body = router(facts, entry.name, raw);
    commands.push({ name: `${entry.name}.md`, source: { kind: "generated", origin: "canonical", path: null }, delivery: { kind: "file", path: `${facts.installPaths.commands}/${entry.name}.md` }, sha256: sha256(body), frontmatter: { source: [], retained: frontmatterKeys(body), omitted: [], rendered: frontmatterKeys(body) }, transformations: { fences: [], tokens: [], argSyntax: null, command: ["router-generated"] }, body });
  }
  const duplicateCommands = commands.map((command) => ({ name: command.name, origin: command.source.origin ?? command.source.kind }));
  uniqueByName(duplicateCommands, `delivered command for ${id}`);

  const commandFor = (name: string, kind?: string) => commands.find((command) => command.name === `${name}.md` && (!kind || command.source.kind === kind));
  const skills: SkillPlan[] = selectedEntries.map((entry) => {
    const raw = readFileSync(join(entry.root, entry.name, "SKILL.md"), "utf8");
    const rendered = renderSkill(id, facts, tokens, raw);
    const commandRaw = entry.sourceKind === "canonical" && coLocated.has(entry.name) ? readFileSync(join(entry.root, entry.name, "COMMAND.md"), "utf8") : null;
    const injected = merge && commandRaw !== null;
    const body = injected ? injectCommand(id, facts, tokens, rendered, commandRaw!) : rendered;
    const delivery = { kind: "file" as const, path: `${facts.installPaths.skills}/${entry.name}/SKILL.md` };
    const baseTransforms = transformations(id, facts, tokens, raw);
    if (injected) baseTransforms.command = ["command-injected", "authoring-file-omitted"];
    const plan: SkillPlan = {
      name: entry.name,
      description: frontmatterValue("description", raw),
      origin: entry.origin,
      source: skillSource(entry),
      delivery,
      sha256: sha256(body),
      frontmatter: frontmatterPlan(raw, body),
      transformations: baseTransforms,
      supportFiles: supportFiles(entry, `${facts.installPaths.skills}/${entry.name}`),
      command: { source: "none", delivery: "none", reason: "No co-located, standalone, or generated command is delivered for this skill.", authoring: null, target: null, body: null },
      body,
      sourceDir: join(entry.root, entry.name),
    };
    const standalone = standaloneBySelector.get(entry.name);
    const co = coLocated.get(entry.name);
    const coSpec = commandFor(entry.name, "co-located");
    const standaloneSpec = commandFor(entry.name, "standalone") ?? commandFor(entry.name, "external");
    const generatedSpec = commandFor(entry.name, "generated");
    if (co) {
      const authoring = { origin: "canonical", path: `skills/${entry.name}/COMMAND.md` } as Source;
      if (injected) plan.command = { source: "co-located", delivery: "injected", reason: "The profile injects the co-located command into the skill artifact.", authoring, target: { path: delivery.path, sha256: plan.sha256 }, body, frontmatter: frontmatterPlan(commandRaw!, renderText(id, facts, tokens, commandRaw!)), transformations: { ...transformations(id, facts, tokens, commandRaw!), command: ["command-injected", "authoring-file-omitted"] } };
      else if (coSpec) plan.command = { source: "co-located", delivery: "file", reason: "The profile emits the co-located command as a file.", authoring, target: { path: coSpec.delivery.path, sha256: coSpec.sha256 }, body: coSpec.body, frontmatter: coSpec.frontmatter, transformations: coSpec.transformations };
      else plan.command = { source: "co-located", delivery: "none", reason: "The profile excludes the co-located command file.", authoring, target: null, body: null };
    } else if (standalone) {
      const authoring = commandSource(standalone);
      if (standaloneSpec) plan.command = { source: "standalone", delivery: "file", reason: "A standalone command with the same selector is emitted as a file.", authoring, target: { path: standaloneSpec.delivery.path, sha256: standaloneSpec.sha256 }, body: standaloneSpec.body, frontmatter: standaloneSpec.frontmatter, transformations: standaloneSpec.transformations };
      else plan.command = { source: "standalone", delivery: "none", reason: "The profile does not emit the matching standalone command.", authoring, target: null, body: null };
    } else if (generatedSpec) plan.command = { source: "generated", delivery: "file", reason: "A generated router is the command surface for this user-invocable skill.", authoring: null, target: { path: generatedSpec.delivery.path, sha256: generatedSpec.sha256 }, body: generatedSpec.body, frontmatter: generatedSpec.frontmatter, transformations: generatedSpec.transformations };
    return plan;
  });

  const rulesPath = resolveProjectPath(project, project.mod.roots.rules, "file");
  const rulesRaw = readFileSync(rulesPath, "utf8");
  const rulesBody = renderText(id, facts, tokens, rulesRaw);
  return {
    id,
    facts,
    profile: { argSyntax: facts.argSyntax, installPaths: facts.installPaths, commandMerge: facts.commandMerge, exclusions: omittedSkills, excludeCommands: [...omittedCommands].sort(), commandExclude: [] },
    omittedSkills,
    skills,
    commands,
    rules: { source: { kind: "canonical", path: "rules/global_agents.md" }, delivery: facts.installPaths.rules ? { kind: "file", path: facts.installPaths.rules } : null, sha256: sha256(rulesBody), body: rulesBody },
    assets: [],
  };
}

export function resolvePlan(project: Project, options: ResolveOptions = {}): ProjectPlan {
  const facts = loadHarnesses();
  const entries = resolveEntries(project, { ...options, overrides: cachedDependencyPaths(project, options.overrides) });
  return { project, harnesses: mapHarnesses((id) => buildHarness(project, id, facts[id], entries)) };
}
export function contractFor(plan: ProjectPlan) {
  const facts = loadHarnesses();
  return {
    schemaVersion: 1,
    schema: {
      markup: ["{{token}}", "{{#harness}}", "{{^harness}}", "{{/}}", "$@"],
      harnesses: mapHarnesses((id) => {
        const value = facts[id];
        return { argSyntax: value.argSyntax, tokens: plan.project.mod.harnesses[id]?.tokens ?? {}, skillFrontmatter: value.skillFrontmatter, commandFrontmatter: value.commandFrontmatter, commandMerge: value.commandMerge };
      }),
    },
    manifest: {
      setups: Object.fromEntries(Object.values(plan.project.mod.setups).sort((a, b) => a.name.localeCompare(b.name)).map((setup) => [setup.name, {
        root: setup.root,
        selection: { mode: setup.mode ?? "all", skills: setup.selectors.map(({ name, reason }) => ({ name, ...(reason ? { reason } : {}) })) },
        harnesses: setup.harnesses.map((harness) => ({ name: harness.id, paths: harness.paths })),
      }])),
      harnesses: mapHarnesses((id) => {
        const harness = plan.harnesses[id];
        return { profile: harness.profile, skills: harness.skills.map(publicSkill), omittedSkills: harness.omittedSkills, commands: harness.commands, rules: { source: harness.rules.source, delivery: harness.rules.delivery, sha256: harness.rules.sha256 }, assets: [] };
      }),
    },
  };
}
