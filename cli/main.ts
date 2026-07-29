#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { Argument, Command, CommanderError, Option } from "commander";
import { addDependency, fetchDependencies, updateDependencies } from "./deps.ts";
import { normalizeHarness } from "./harness.ts";
import { installProject } from "./install.ts";
import { checkCommand, diffCommand, inspectCommand, listCommand, manifestCommand, schemaCommand, type OutputFormat } from "./introspect.ts";
import { formatText, type HarnessId } from "./mod.ts";
import { discoverProject, initProject } from "./project.ts";
import { renderProject } from "./render.ts";

const collect = (value: string, previous: string[] = []) => [...previous, value];
function one(values: string[] | undefined, flag: string) {
  if (!values?.length) return undefined;
  if (values.length > 1) throw new CliUsageError(`duplicate ${flag}`, `Use ${flag} once.`);
  return values[0];
}
function assignments(values: string[] | undefined, flag: string) {
  const result: Record<string, string> = {};
  for (const value of values ?? []) {
    const equals = value.indexOf("=");
    if (equals <= 0 || equals === value.length - 1) throw new CliUsageError(`${flag} expects name=path`, `Use ${flag} name=path.`);
    const name = value.slice(0, equals);
    if (result[name]) throw new CliUsageError(`duplicate ${flag} name ${name}`, `Pass each ${flag} name once.`);
    result[name] = value.slice(equals + 1);
  }
  return result;
}
function extraRoots(skills: string[] | undefined, commands: string[] | undefined) {
  const convert = (values: string[] | undefined, flag: string) => Object.entries(assignments(values, flag)).map(([origin, path]) => ({ origin, path }));
  return { skills: convert(skills, "--extra-skill-root"), commands: convert(commands, "--extra-command-root") };
}
function harnesses(values: string[] | undefined) {
  const result: HarnessId[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeHarness(value);
    if (normalized.warning) console.error(normalized.warning);
    if (result.includes(normalized.name)) throw new CliUsageError(`duplicate harness ${normalized.name}`, "Select each harness once.");
    result.push(normalized.name);
  }
  return result;
}
function printChanges(verb: string, target: string, changes: Array<{ action: "add" | "change" | "delete"; path: string }>) {
  const counts = { add: 0, change: 0, delete: 0 };
  for (const change of changes) counts[change.action]++;
  console.log(`${verb} ${target}: ${counts.add} add, ${counts.change} change, ${counts.delete} delete`);
  for (const change of changes) console.log(`${change.action.padEnd(6)} ${change.path}`);
}

class CliUsageError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function hasRecovery(error: unknown): error is Error & { recovery: string } {
  return error instanceof Error && "recovery" in error && typeof error.recovery === "string";
}
function recoveryFor(error: unknown) {
  return hasRecovery(error) ? error.recovery : "Run `skillful --help` for supported commands.";
}
function printDomainError(error: unknown, json = false) {
  const message = error instanceof Error ? error.message : String(error);
  const recovery = recoveryFor(error).replace(/^Recovery:\s*/, "");
  const code = error instanceof CliUsageError ? "usage" : "runtime";
  if (json) console.log(JSON.stringify({ schemaVersion: 1, error: { code, message, hint: recovery } }));
  else console.error(`Error: ${message}\nRecovery: ${recovery}`);
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
function internalRootOption(flags: string, description: string) { return new Option(flags, description).argParser(collect).default([]).hideHelp(); }
function addSourceOptions(command: Command, withHarness = true) {
  command.addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]));
  if (withHarness) command.addOption(new Option("--harness <harness>", "select a harness; repeatable").argParser(collect).default([]));
  command.addOption(new Option("--format <format>", "output format").choices(["text", "json"]).default("text"));
  command.addOption(new Option("--override <name=path>", "satisfy a declared dependency locally; repeatable").argParser(collect).default([]));
  command.addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"));
  command.addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"));
  return command;
}
type SourceOptionValues = {
  project: string[];
  harness?: string[] | undefined;
  format: OutputFormat;
  override: string[];
  extraSkillRoot: string[];
  extraCommandRoot: string[];
};
function sourceArguments(options: SourceOptionValues) {
  return {
    project: discoverProject({ project: one(options.project, "--project") }),
    harnesses: options.harness ? harnesses(options.harness) : undefined,
    format: options.format,
    overrides: assignments(options.override, "--override"),
    extraRoots: extraRoots(options.extraSkillRoot, options.extraCommandRoot),
  };
}

export function createProgram() {
  const program = new Command()
    .name("skillful")
    .description("Author agent skills once, render them per harness.")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .allowExcessArguments(false)
    .exitOverride();

  program.command("init")
    .description("Create the shared basic project scaffold")
    .addOption(new Option("--dir <directory>", "destination directory").argParser(collect).default([]))
    .action((options: { dir: string[] }) => {
      const result = initProject(one(options.dir, "--dir") ?? process.cwd());
      console.log(result.created ? `Initialized skillful project in ${result.root}` : `Skillful project already initialized in ${result.root}`);
    });

  program.command("fmt")
    .description("Canonicalize skill.mod or check its format")
    .option("--check", "report noncanonical formatting without writing")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .action((options: { check?: boolean; project: string[] }) => {
      const resolved = discoverProject({ project: one(options.project, "--project") });
      const original = readFileSync(resolved.modPath, "utf8");
      const formatted = formatText(original, resolved.modPath);
      if (original === formatted) { console.log(`${resolved.modPath} is canonical`); return; }
      if (options.check) { console.error(`Error: ${resolved.modPath} is not canonical\n--- current\n+++ formatted\nRecovery: Run \`skillful fmt --project ${resolved.root}\` to rewrite it.`); process.exitCode = 1; return; }
      writeFileSync(resolved.modPath, formatted);
      console.log(`Formatted ${resolved.modPath}`);
    });

  program.command("add")
    .description("Declare, resolve, lock, and fetch one dependency")
    .argument("<ref>", "github:, git:, or path: reference")
    .addOption(new Option("--name <name>", "dependency alias").argParser(collect).default([]))
    .addOption(new Option("--only <skill>", "include only this skill; repeatable").argParser(collect).default([]))
    .addOption(new Option("--exclude <skill>", "exclude this skill; repeatable").argParser(collect).default([]))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .action(async (ref: string, options: { name: string[]; only: string[]; exclude: string[]; project: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const result = await addDependency(project, ref, { name: one(options.name, "--name"), only: options.only, exclude: options.exclude });
      console.log(result.entry ? `Added ${result.requirement.name} at ${result.entry.rev}` : `Added local dependency ${result.requirement.name}`);
    });

  program.command("fetch")
    .description("Fetch and verify exact existing pins without changing skill.lock")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .addOption(internalRootOption("--override <name=path>", "internal dependency override"))
    .action(async (options: { project: string[]; override: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const entries = await fetchDependencies(project, undefined, new Set(Object.keys(assignments(options.override, "--override"))));
      console.log(`Fetched ${entries.length} locked ${entries.length === 1 ? "dependency" : "dependencies"}`);
    });

  program.command("update")
    .description("Re-resolve and fetch selected dependency pins")
    .argument("[names...]", "dependency names; default: all")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .addOption(internalRootOption("--override <name=path>", "internal dependency override"))
    .action(async (names: string[], options: { project: string[]; override: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const entries = await updateDependencies(project, names, undefined, new Set(Object.keys(assignments(options.override, "--override"))));
      console.log(`Updated ${names.length || entries.length} locked ${names.length === 1 ? "dependency" : "dependencies"}`);
    });

  program.command("render")
    .description("Render a managed build tree without installing it")
    .addOption(new Option("--harness <harness>", "render only this harness; repeatable").argParser(collect).default([]))
    .addOption(new Option("--out <directory>", "managed output directory (default: ./rendered)").argParser(collect).default([]))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .option("--dry-run", "plan without changing the output")
    .option("--force", "replace listed unmanaged or edited output")
    .addOption(new Option("--override <name=path>", "satisfy a declared dependency from a local path; repeatable").argParser(collect).default([]))
    .addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"))
    .addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"))
    .action((options: { harness: string[]; out: string[]; project: string[]; dryRun?: boolean; force?: boolean; override: string[]; extraSkillRoot: string[]; extraCommandRoot: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const result = renderProject(project, {
        harnesses: harnesses(options.harness),
        out: one(options.out, "--out"),
        dryRun: options.dryRun,
        force: options.force,
        overrides: assignments(options.override, "--override"),
        extraRoots: extraRoots(options.extraSkillRoot, options.extraCommandRoot),
      });
      printChanges(options.dryRun ? "Would render" : "Rendered", result.out, result.changes);
    });

  program.command("install")
    .description("Safely install one harness into a destination root")
    .requiredOption("--harness <harness>", "harness to install")
    .addOption(new Option("--root <directory>", "destination root (default: current home)").argParser(collect).default([]))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect).default([]))
    .option("--dry-run", "plan without changing installed files or state")
    .option("--force", "replace listed unmanaged or edited files")
    .addOption(new Option("--override <name=path>", "satisfy a declared dependency from a local path; repeatable").argParser(collect).default([]))
    .addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"))
    .addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"))
    .action((options: { harness: string; root: string[]; project: string[]; dryRun?: boolean; force?: boolean; override: string[]; extraSkillRoot: string[]; extraCommandRoot: string[] }) => {
      const normalized = normalizeHarness(options.harness);
      if (normalized.warning) console.error(normalized.warning);
      const project = discoverProject({ project: one(options.project, "--project") });
      const result = installProject(project, {
        harness: normalized.name,
        root: one(options.root, "--root"),
        dryRun: options.dryRun,
        force: options.force,
        overrides: assignments(options.override, "--override"),
        extraRoots: extraRoots(options.extraSkillRoot, options.extraCommandRoot),
      });
      printChanges(options.dryRun ? "Would install into" : "Installed into", result.root, result.changes);
    });

  addSourceOptions(program.command("list").description("List delivered skills or public harnesses").addArgument(new Argument("<selector>", "skills or harnesses").choices(["skills", "harnesses"])))
    .action((selector: "skills" | "harnesses", options: SourceOptionValues) => { const source = sourceArguments(options); listCommand(source.project, selector, source); });

  addSourceOptions(program.command("inspect").description("Explain one skill across harnesses").argument("<skill>", "skill selector"))
    .option("--rendered", "include rendered bodies")
    .action((name: string, options: SourceOptionValues & { rendered?: boolean | undefined }) => { const source = sourceArguments(options); inspectCommand(source.project, name, { ...source, rendered: options.rendered }); });

  addSourceOptions(program.command("check").description("Validate the resolved project").argument("[skills...]", "optional skill selectors"))
    .option("--strict", "promote warnings to failure")
    .action((names: string[], options: SourceOptionValues & { strict?: boolean | undefined }) => { const source = sourceArguments(options); checkCommand(source.project, names, { ...source, strict: options.strict }); });

  addSourceOptions(program.command("diff").description("Compare one skill across harnesses or with a local revision").argument("<skill>", "skill selector"))
    .addOption(new Option("--against <revision>", "local Git revision").argParser(collect).default([]))
    .action((name: string, options: SourceOptionValues & { against: string[] }) => { const source = sourceArguments(options); diffCommand(source.project, name, { ...source, against: one(options.against, "--against") }); });

  addSourceOptions(program.command("manifest").description("Emit the resolved schemaVersion-1 manifest"))
    .action((options: SourceOptionValues) => { const source = sourceArguments(options); manifestCommand(source.project, source); });

  addSourceOptions(program.command("schema").description("Describe harness facts and renderer markup"), false)
    .action((options: SourceOptionValues) => { const source = sourceArguments(options); schemaCommand(source.project, source); });
  return program;
}

export async function main(argv = Bun.argv.slice(2)) {
  const json = argv.some((value, index) => value === "--format" && argv[index + 1] === "json");
  try { await createProgram().parseAsync(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
      const message = error.message.replace(/^error:\s*/i, "");
      const hint = "Run `skillful --help` or `skillful <command> --help`.";
      if (json) console.log(JSON.stringify({ schemaVersion: 1, error: { code: "usage", message, hint } }));
      else console.error(`Error: ${message}\nRecovery: ${hint}`);
      process.exitCode = 2;
      return;
    }
    printDomainError(error, json);
  }
}

if (import.meta.main) main();
