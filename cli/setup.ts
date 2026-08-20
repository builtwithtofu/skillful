import { join } from "node:path";
import { resolvePlan, type ResolveOptions } from "./contract.ts";
import { loadHarnesses } from "./harness.ts";
import { pathConflict, resolveInstallPaths, type InstallPaths } from "./install.ts";
import type { HarnessId } from "./mod.ts";
import type { Project } from "./project.ts";

export type ResolvedSetupFile = { harness: HarnessId; artifact: string };
export type ResolvedSetup = {
  name: string;
  root: "home" | "project";
  selection: { mode: "all" | "only" | "omit"; skills: Array<{ name: string; reason?: string | undefined }> };
  harnesses: Array<{ name: HarnessId; paths: InstallPaths }>;
  files: Record<string, ResolvedSetupFile>;
};

export class SetupError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
function fail(message: string, recovery: string): never { throw new SetupError(message, `Recovery: ${recovery}`); }

export function resolveSetup(project: Project, name: string, options: ResolveOptions = {}): ResolvedSetup {
  const plan = resolvePlan(project, { ...options, setup: name });
  const setup = project.mod.setups[name]!;
  const facts = loadHarnesses();
  const harnesses = setup.harnesses.map((harness) => ({ name: harness.id, paths: resolveInstallPaths(facts[harness.id], harness.paths, setup.root) }));
  const destinations = harnesses.flatMap((harness) => Object.values(harness.paths));
  for (const [index, left] of destinations.entries()) for (const right of destinations.slice(index + 1)) {
    if (pathConflict(left, right)) fail(`setup ${name} has overlapping destinations: ${left} and ${right}`, "Choose harness paths that do not share a destination region.");
  }
  const files: Record<string, ResolvedSetupFile> = {};
  const add = (destination: string, harness: HarnessId, artifact: string) => {
    files[destination] = { harness, artifact };
  };
  for (const output of harnesses) {
    const harness = plan.harnesses[output.name];
    for (const skill of harness.skills) {
      add(join(output.paths.skills, skill.name, "SKILL.md").replaceAll("\\", "/"), output.name, `${output.name}/skills/${skill.name}/SKILL.md`);
      for (const support of skill.supportFiles) add(join(output.paths.skills, skill.name, support.relativePath).replaceAll("\\", "/"), output.name, `${output.name}/skills/${skill.name}/${support.relativePath.replaceAll("\\", "/")}`);
    }
    if (output.paths.commands) for (const command of harness.commands) add(join(output.paths.commands, command.name).replaceAll("\\", "/"), output.name, `${output.name}/commands/${command.name}`);
    if (output.paths.rules) add(output.paths.rules, output.name, `${output.name}/rules.md`);
  }
  return {
    name,
    root: setup.root,
    selection: { mode: setup.mode ?? "all", skills: setup.selectors.map(({ name: skill, reason }) => ({ name: skill, ...(reason ? { reason } : {}) })) },
    harnesses,
    files,
  };
}
