import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { contractFor, resolvePlan, sha256, type ResolveOptions } from "./contract.ts";
import type { HarnessId } from "./mod.ts";
import { discoverProject, type Project } from "./project.ts";

export type OutputFormat = "text" | "json";
export class IntrospectionError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new IntrospectionError(message, `Recovery: ${recovery}`); }
function selectedHarnesses(plan: ReturnType<typeof resolvePlan>, harnesses?: HarnessId[]) { return harnesses?.length ? harnesses : Object.keys(plan.harnesses) as HarnessId[]; }
function emit(value: unknown, format: OutputFormat, text: () => string) { console.log(format === "json" ? JSON.stringify(value, null, 2) : text()); }
function publicSkill(skill: ReturnType<typeof resolvePlan>["harnesses"][HarnessId]["skills"][number], rendered: boolean) {
  const { sourceDir: _sourceDir, ...value } = skill;
  const supportFiles = value.supportFiles.map(({ sourcePath: _sourcePath, relativePath: _relativePath, ...support }) => support);
  return rendered ? { ...value, supportFiles } : { ...value, supportFiles, body: undefined, command: { ...value.command, body: undefined } };
}
export function manifestCommand(project: Project, options: ResolveOptions & { harnesses?: HarnessId[]; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const contract = contractFor(plan);
  const ids = selectedHarnesses(plan, options.harnesses);
  const manifest = { schemaVersion: 1, harnesses: Object.fromEntries(ids.map((id) => [id, contract.manifest.harnesses[id]])) };
  emit(manifest, options.format, () => ids.map((id) => `${id}: ${plan.harnesses[id].skills.length} skills, ${plan.harnesses[id].commands.length} commands`).join("\n"));
}
export function schemaCommand(project: Project, options: ResolveOptions & { format: OutputFormat }) {
  const schema = contractFor(resolvePlan(project, options)).schema;
  emit({ schemaVersion: 1, schema }, options.format, () => ["schemaVersion: 1", `harnesses: ${Object.keys(schema.harnesses).join(", ")}`, `markup: ${schema.markup.join(", ")}`].join("\n"));
}
export function listCommand(project: Project, selector: "skills" | "harnesses", options: ResolveOptions & { harnesses?: HarnessId[]; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const ids = selectedHarnesses(plan, options.harnesses);
  if (selector === "harnesses") {
    const value = { schemaVersion: 1, harnesses: ids.map((id) => ({ name: id, profile: plan.harnesses[id].profile })) };
    emit(value, options.format, () => ids.map((id) => id).join("\n"));
    return;
  }
  const names = [...new Set(ids.flatMap((id) => plan.harnesses[id].skills.map((skill) => skill.name)))].sort();
  const rows = names.map((name) => ({ name, harnesses: Object.fromEntries(ids.map((id) => {
    const skill = plan.harnesses[id].skills.find((entry) => entry.name === name);
    const omission = plan.harnesses[id].omittedSkills[name];
    return [id, skill ? { status: "included", origin: skill.origin } : omission ? { status: "omitted", reason: omission.message } : { status: "absent" }];
  })) }));
  emit({ schemaVersion: 1, skills: rows }, options.format, () => rows.map((row) => `${row.name}\t${ids.map((id) => `${id}:${row.harnesses[id]!.status}`).join(" ")}`).join("\n"));
}
export function inspectCommand(project: Project, name: string, options: ResolveOptions & { harnesses?: HarnessId[]; rendered?: boolean; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const ids = selectedHarnesses(plan, options.harnesses);
  const harnesses = Object.fromEntries(ids.map((id) => {
    const skill = plan.harnesses[id].skills.find((entry) => entry.name === name);
    return [id, skill ? { status: "included", skill: publicSkill(skill, Boolean(options.rendered)) } : plan.harnesses[id].omittedSkills[name] ? { status: "omitted", omission: plan.harnesses[id].omittedSkills[name] } : { status: "absent" }];
  }));
  if (Object.values(harnesses).every((entry) => entry.status === "absent")) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
  emit({ schemaVersion: 1, name, harnesses }, options.format, () => ids.map((id) => {
    const entry = harnesses[id]!;
    if (entry.status !== "included") return `${id}: ${entry.status}`;
    return `${id}: included (${entry.skill.origin})${options.rendered ? `\n${entry.skill.body}` : ""}`;
  }).join("\n\n"));
}
export function checkCommand(project: Project, names: string[], options: ResolveOptions & { harnesses?: HarnessId[]; strict?: boolean; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const ids = selectedHarnesses(plan, options.harnesses);
  const known = new Set(ids.flatMap((id) => plan.harnesses[id].skills.map((skill) => skill.name)));
  for (const name of names) if (!known.has(name)) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
  const selected = names.length ? new Set(names) : null;
  const warnings: Array<{ code: string; harness: HarnessId; skill?: string; message: string }> = [];
  for (const id of ids) {
    for (const skill of plan.harnesses[id].skills) if ((!selected || selected.has(skill.name)) && !skill.body.trim()) warnings.push({ code: "empty-skill", harness: id, skill: skill.name, message: "rendered skill body is empty" });
    for (const command of plan.harnesses[id].commands) if (!command.body.trim()) warnings.push({ code: "empty-command", harness: id, message: `${command.name} renders empty` });
  }
  const ok = warnings.length === 0 || !options.strict;
  emit({ schemaVersion: 1, ok, strict: Boolean(options.strict), warnings }, options.format, () => warnings.length ? warnings.map((warning) => `${warning.harness}: ${warning.message}`).join("\n") : "OK");
  if (!ok) process.exitCode = 1;
}
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" } });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    fail(`local Git command failed: git ${args.join(" ")}`, `${detail ? `${detail}. ` : ""}Prepare the revision locally and retry; skillful never fetches during diff.`);
  }
  return result.stdout;
}
function historicalProject(project: Project, revision: string) {
  const repo = new TextDecoder().decode(git(project.root, ["rev-parse", "--show-toplevel"])).trim();
  git(repo, ["cat-file", "-e", `${revision}^{commit}`]);
  const archive = git(repo, ["archive", "--format=tar", revision]);
  const temp = mkdtempSync(join(tmpdir(), "skillful-diff-"));
  const archivePath = join(temp, ".skillful-archive.tar");
  writeFileSync(archivePath, Buffer.from(archive));
  const extract = Bun.spawnSync(["tar", "-xf", archivePath, "-C", temp], { stdout: "pipe", stderr: "pipe" });
  unlinkSync(archivePath);
  if (extract.exitCode !== 0) {
    const detail = new TextDecoder().decode(extract.stderr).trim();
    rmSync(temp, { recursive: true, force: true });
    fail(`cannot materialize local revision ${revision}`, `${detail ? `${detail}. ` : ""}Ensure tar is available and the revision is committed locally.`);
  }
  const relativeProject = relative(repo, project.root);
  try { return { temp, project: discoverProject({ project: join(temp, relativeProject) }) }; }
  catch { rmSync(temp, { recursive: true, force: true }); fail(`revision ${revision} has no current skill.mod project at ${relativeProject || "."}`, "Choose a TypeScript-era revision containing skill.mod; legacy contract fallbacks are intentionally unsupported."); }
}
function lineDiff(before: string, after: string) {
  if (before === after) return "";
  const left = before.split("\n"); const right = after.split("\n");
  return ["--- before", "+++ after", ...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)].join("\n");
}
export function diffCommand(project: Project, name: string, options: ResolveOptions & { against?: string; harnesses?: HarnessId[]; format: OutputFormat }) {
  const current = resolvePlan(project, options);
  const ids = selectedHarnesses(current, options.harnesses);
  let historical: ReturnType<typeof historicalProject> | undefined;
  try {
    const previous = options.against ? (historical = historicalProject(project, options.against)).project : null;
    const oldPlan = previous ? resolvePlan(previous, options) : null;
    const comparisons = Object.fromEntries(ids.map((id) => {
      const currentSkill = current.harnesses[id].skills.find((skill) => skill.name === name);
      const beforeSkill = oldPlan?.harnesses[id].skills.find((skill) => skill.name === name);
      const before = beforeSkill?.body ?? (options.against ? null : current.harnesses[ids[0]!].skills.find((skill) => skill.name === name)?.body ?? null);
      const after = currentSkill?.body ?? null;
      return [id, { status: before === after ? "identical" : before === null ? "added" : after === null ? "removed" : "changed", beforeSha256: before === null ? null : sha256(before), afterSha256: after === null ? null : sha256(after), diff: before === null || after === null ? null : lineDiff(before, after) }];
    }));
    if (Object.values(comparisons).every((entry) => entry.beforeSha256 === null && entry.afterSha256 === null)) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
    emit({ schemaVersion: 1, name, against: options.against ?? null, harnesses: comparisons }, options.format, () => ids.map((id) => `${id}: ${comparisons[id]!.status}${comparisons[id]!.diff ? `\n${comparisons[id]!.diff}` : ""}`).join("\n\n"));
  } finally { if (historical) rmSync(historical.temp, { recursive: true, force: true }); }
}
