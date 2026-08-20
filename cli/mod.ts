import { posix } from "node:path";

export const HARNESS_IDS = ["claude", "codex", "cursor", "grok", "opencode", "pi"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export function mapHarnesses<T>(value: (id: HarnessId) => T): Record<HarnessId, T> {
  return Object.fromEntries(HARNESS_IDS.map((id) => [id, value(id)])) as Record<HarnessId, T>;
}


type Comments = string[];
type WithComments<T> = T & { comments: Comments };
export type Require = WithComments<{
  ref: string;
  alias: string | undefined;
  name: string;
  mode: "only" | "exclude" | undefined;
  selectors: string[];
}>;
export type Omission = WithComments<{ kind: "omit-skill" | "omit-command"; selector: string; reason: string }>;
export type Harness = WithComments<{
  id: HarnessId;
  tokens: Record<string, string>;
  tokenComments: Record<string, Comments>;
  omissions: Omission[];
}>;
export type SetupSelector = WithComments<{ kind: "only-skill" | "omit-skill"; name: string; reason?: string | undefined }>;
export type SetupHarness = WithComments<{
  id: HarnessId;
  paths: Partial<Record<"skills" | "commands" | "rules", string>>;
  pathComments: Partial<Record<"skills" | "commands" | "rules", Comments>>;
}>;
export type Setup = WithComments<{
  name: string;
  root: "home" | "project";
  rootComments: Comments;
  mode: "only" | "omit" | undefined;
  selectors: SetupSelector[];
  harnesses: SetupHarness[];
}>;
export type SkillMod = {
  headerComments: Comments;
  roots: { skills: string; commands: string; rules: string };
  rootComments: Record<"skills" | "commands" | "rules", Comments>;
  requires: Require[];
  harnesses: Record<string, Harness>;
  setups: Record<string, Setup>;
  /** Compatibility view for callers that only need comment accounting. */
  leadingComments: Comments;
};

export class ModError extends Error {
  constructor(readonly filename: string, readonly line: number, readonly column: number, message: string, readonly recovery: string) {
    super(`${filename}:${line}:${column}: ${message}`);
  }
}

const defaults = { skills: "./skills", commands: "./commands", rules: "./rules/global_agents.md" };
const aliasPattern = /^[a-z0-9][a-z0-9._-]*$/;
const barePattern = /^(?!.*\/\/)[^\s()"]+$/;
function setupPath(value: string, filename: string, line: number, column: number) {
  const portable = value.replaceAll("\\", "/");
  if (!portable || portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || portable.split("/").includes("..")) fail(filename, line, column, `unsafe setup path ${JSON.stringify(value)}`, "Use a relative path that remains inside the selected root.");
  const normalized = posix.normalize(portable);
  return normalized === "." ? normalized : normalized.replace(/\/+$/, "");
}

type Token = { value: string; column: number };
type ParseBlock =
  | { kind: "require"; value: Require; line: number }
  | { kind: "harness"; value: Harness; line: number }
  | { kind: "setup"; value: Setup; line: number }
  | { kind: "setup-harness"; value: SetupHarness; setup: Setup; line: number; setupLine: number };
function fail(filename: string, line: number, column: number, message: string, recovery: string): never {
  throw new ModError(filename, line, column, message, `Recovery: ${recovery}`);
}

function tokensFor(raw: string, filename: string, line: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index]!)) index++;
    if (index === raw.length) break;
    const column = index + 1;
    if (raw[index] === '"') {
      let escaped = false;
      let end = index + 1;
      for (; end < raw.length; end++) {
        const char = raw[end]!;
        if (!escaped && char === '"') break;
        escaped = !escaped && char === "\\";
        if (char !== "\\") escaped = false;
      }
      if (end === raw.length) fail(filename, line, column, "unterminated JSON string", "Close the quoted value with a JSON double quote.");
      const literal = raw.slice(index, end + 1);
      try { tokens.push({ value: JSON.parse(literal), column }); }
      catch { fail(filename, line, column, "invalid JSON string", "Use a JSON-escaped double-quoted value."); }
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < raw.length && !/\s/.test(raw[end]!)) end++;
    const value = raw.slice(index, end);
    if (value !== "(" && value !== ")" && !barePattern.test(value)) fail(filename, line, column, `invalid bare token ${JSON.stringify(value)}`, "Use a quoted JSON string for whitespace, //, parentheses, or quotes.");
    tokens.push({ value, column });
    index = end;
  }
  return tokens;
}

function canonicalName(ref: string) {
  const at = ref.lastIndexOf("@");
  return at > 0 ? ref.slice(0, at) : ref;
}
function quote(value: string) { return barePattern.test(value) ? value : JSON.stringify(value); }
function emitComments(lines: string[], comments: Comments) { lines.push(...comments); }

export function parseMod(text: string, filename = "skill.mod"): SkillMod {
  if (text.includes("\r")) fail(filename, 1, 1, "skill.mod must use LF line endings", "Run `skillful fmt` to rewrite the manifest with LF line endings.");
  const roots = { ...defaults };
  const rootComments: SkillMod["rootComments"] = { skills: [], commands: [], rules: [] };
  const mod: SkillMod = { headerComments: [], roots, rootComments, requires: [], harnesses: {}, setups: {}, leadingComments: [] };
  const seenRoots = new Set<string>();
  const seenRequireNames = new Set<string>();
  let pending: Comments = [];
  let sawHeader = false;
  let block: ParseBlock | undefined;
  const lines = text.split("\n");

  for (let offset = 0; offset < lines.length; offset++) {
    const line = offset + 1;
    const raw = lines[offset]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) { pending.push(trimmed); mod.leadingComments.push(trimmed); continue; }
    const tokens = tokensFor(raw, filename, line);
    if (!tokens.length) continue;
    const first = tokens[0]!;

    if (!sawHeader) {
      if (first.value !== "skillful" || tokens.length !== 2 || tokens[1]!.value !== "1") {
        if (first.value === "skillful") fail(filename, line, first.column, "unsupported skillful version", "Use exactly `skillful 1` as the first semantic directive.");
        fail(filename, line, first.column, "the first semantic directive must be exactly `skillful 1`", "Put `skillful 1` before roots, requires, or harnesses.");
      }
      sawHeader = true;
      mod.headerComments = pending;
      pending = [];
      continue;
    }

    if (block) {
      if (first.value === ")") {
        if (tokens.length !== 1) fail(filename, line, tokens[1]!.column, "trailing tokens after `)`", "Put `)` on its own semantic line.");
        if (block.kind === "setup-harness") block = { kind: "setup", value: block.setup, line: block.setupLine };
        else {
          if (block.kind === "setup" && !block.value.harnesses.length) fail(filename, line, first.column, `setup ${JSON.stringify(block.value.name)} needs at least one harness`, `Add one of: ${HARNESS_IDS.join(", ")}.`);
          block = undefined;
        }
        continue;
      }
      if (block.kind === "setup-harness") {
        if (tokens.some((token) => token.value === "(" || token.value === ")")) fail(filename, line, first.column, "nested setup harness blocks are not allowed", "Put skills, commands, or rules paths inside this harness block.");
        if ((first.value !== "skills" && first.value !== "commands" && first.value !== "rules") || tokens.length !== 2) fail(filename, line, first.column, "setup harness blocks contain only skills, commands, or rules paths", "Use `<skills|commands|rules> <relative-path>`.");
        if (block.value.paths[first.value]) fail(filename, line, first.column, `duplicate ${first.value} path for ${block.value.id}`, "Keep one path per category.");
        block.value.paths[first.value] = setupPath(tokens[1]!.value, filename, line, tokens[1]!.column);
        block.value.pathComments[first.value] = pending;
        pending = [];
        continue;
      }
      if (block.kind === "setup") {
        const setup = block.value;
        const addHarness = (token: Token, comments: Comments) => {
          if (!(HARNESS_IDS as readonly string[]).includes(token.value)) fail(filename, line, token.column, `unknown setup harness ${JSON.stringify(token.value)}`, `Use one of: ${HARNESS_IDS.join(", ")}.`);
          if (setup.harnesses.some((entry) => entry.id === token.value)) fail(filename, line, token.column, `duplicate harness ${JSON.stringify(token.value)} in setup ${JSON.stringify(setup.name)}`, "List each harness once.");
          const harness: SetupHarness = { id: token.value as HarnessId, paths: {}, pathComments: {}, comments };
          setup.harnesses.push(harness);
          return harness;
        };
        if (first.value === "root") {
          if (tokens.length !== 2 || tokens[1]!.value !== "project") fail(filename, line, first.column, "setup root accepts only project", "Use `root project`, or omit root to use home.");
          if (setup.root === "project") fail(filename, line, first.column, `duplicate root in setup ${JSON.stringify(setup.name)}`, "Keep one root declaration.");
          setup.root = "project";
          setup.rootComments = pending;
          pending = [];
          continue;
        }
        if (first.value === "only-skill" || first.value === "omit-skill") {
          const mode = first.value === "only-skill" ? "only" : "omit";
          const expected = mode === "only" ? 2 : 3;
          if (tokens.length !== expected) fail(filename, line, first.column, `${first.value} has the wrong arguments`, mode === "only" ? "Use `only-skill <name>`." : "Use `omit-skill <name> <JSON-string-reason>`." );
          if (setup.mode && setup.mode !== mode) fail(filename, line, first.column, `setup ${JSON.stringify(setup.name)} cannot mix only-skill and omit-skill`, "Use one selection mode per setup.");
          const name = tokens[1]!.value;
          if (setup.selectors.some((entry) => entry.name === name)) fail(filename, line, tokens[1]!.column, `duplicate setup skill selector ${JSON.stringify(name)}`, "Keep each selector once.");
          setup.mode = mode;
          setup.selectors.push({ kind: first.value, name, ...(tokens[2] ? { reason: tokens[2].value } : {}), comments: pending });
          pending = [];
          continue;
        }
        const opens = tokens.at(-1)?.value === "(";
        if (opens) {
          if (tokens.length !== 2) fail(filename, line, first.column, "a setup path block needs exactly one harness", "Use `<harness> (` and close it with `)`.");
          const harness = addHarness(first, pending);
          pending = [];
          block = { kind: "setup-harness", value: harness, setup, line, setupLine: block.line };
          continue;
        }
        if (tokens.some((token) => token.value === "(" || token.value === ")")) fail(filename, line, first.column, "misplaced setup block punctuation", "Put `(` after one harness or `)` on its own line.");
        for (const [index, token] of tokens.entries()) addHarness(token, index === 0 ? pending : []);
        pending = [];
        continue;
      }
      if (tokens.some((token) => token.value === "(" || token.value === ")")) fail(filename, line, first.column, "nested blocks or misplaced parentheses are not allowed", "Close the current block with `)` before starting another directive.");
      if (block.kind === "require") {
        if ((first.value !== "only" && first.value !== "exclude") || tokens.length !== 2) fail(filename, line, first.column, "require blocks contain only `only <skill-name>` or `exclude <skill-name>`", "Use one selector directive per line.");
        const mode = first.value as "only" | "exclude";
        const require = block.value;
        if (require.mode && require.mode !== mode) fail(filename, line, first.column, "a require cannot mix only and exclude selectors", "Use only one selector mode in this require block.");
        if (require.selectors.includes(tokens[1]!.value)) fail(filename, line, tokens[1]!.column, `duplicate ${mode} selector ${JSON.stringify(tokens[1]!.value)}`, "Keep each selector once.");
        require.mode = mode;
        require.selectors.push(tokens[1]!.value);
        continue;
      }
      const harness = block.value;
      if (first.value === "token") {
        if (tokens.length !== 3) fail(filename, line, first.column, "token requires a name and a JSON string value", "Use `token <name> <JSON-string>`.");
        const [_, name, value] = tokens;
        if (!name || !value) throw new Error("token parser lost a required token");
        if (Object.hasOwn(harness.tokens, name.value)) fail(filename, line, name.column, `duplicate token ${JSON.stringify(name.value)}`, "Keep each token name once per harness.");
        harness.tokens[name.value] = value.value;
        harness.tokenComments[name.value] = pending;
        pending = [];
        continue;
      }
      if (first.value === "omit-skill" || first.value === "omit-command") {
        if (tokens.length !== 3) fail(filename, line, first.column, `${first.value} requires a selector and a JSON-string reason`, "Use " + first.value + " <selector> <JSON-string-reason>.");
        const [_, selector, reason] = tokens;
        if (!selector || !reason) throw new Error("omission parser lost a required token");
        if (harness.omissions.some((item) => item.kind === first.value && item.selector === selector.value)) fail(filename, line, selector.column, `duplicate ${first.value} ${JSON.stringify(selector.value)}`, "Keep each omitted selector once per harness.");
        harness.omissions.push({ kind: first.value, selector: selector.value, reason: reason.value, comments: pending });
        pending = [];
        continue;
      }
      fail(filename, line, first.column, `unknown harness block child ${JSON.stringify(first.value)}`, "Use token, omit-skill, or omit-command inside a harness block.");
    }

    if (first.value === ")") fail(filename, line, first.column, "stray block close", "Remove the `)` or add its matching require or harness block.");
    if (tokens.some((token, index) => token.value === "(" && index !== tokens.length - 1)) fail(filename, line, first.column, "`(` must be the final token of a block opener", "Put `(` after the require or harness header with no trailing tokens.");
    if (tokens.some((token) => token.value === "(" || token.value === ")")) {
      if (tokens[tokens.length - 1]!.value !== "(") fail(filename, line, first.column, "trailing tokens after `(` or `)`", "Put block punctuation at the end of its header or on its own line.");
    }

    if (first.value === "skillful") fail(filename, line, first.column, "skillful 1 may appear only as the first semantic directive", "Keep one header at the top of the file.");
    if (first.value === "skills" || first.value === "commands" || first.value === "rules") {
      if (tokens.length !== 2) fail(filename, line, first.column, `${first.value} takes exactly one path`, "Use " + first.value + " <path>.");
      if (seenRoots.has(first.value)) fail(filename, line, first.column, `${first.value} may appear at most once`, "Keep one declaration; its default can be omitted.");
      seenRoots.add(first.value);
      roots[first.value] = tokens[1]!.value;
      rootComments[first.value] = pending;
      pending = [];
      continue;
    }
    if (first.value === "require") {
      const opens = tokens.at(-1)?.value === "(";
      const header = opens ? tokens.slice(0, -1) : tokens;
      if (header.length !== 2 && !(header.length === 4 && header[2]!.value === "as")) fail(filename, line, first.column, "require expects `<ref> [as <alias>]`", "Use `require <ref> [as <alias>]` and optionally end the line with `(`.");
      const ref = header[1]?.value;
      if (!ref) throw new Error("require parser lost ref");
      const alias = header.length === 4 ? header[3]!.value : undefined;
      if (alias && !aliasPattern.test(alias)) fail(filename, line, header[3]!.column, `invalid require alias ${JSON.stringify(alias)}`, "Use lowercase letters or digits, then lowercase letters, digits, dots, underscores, or hyphens.");
      const name = alias ?? canonicalName(ref);
      if (seenRequireNames.has(name)) fail(filename, line, alias ? header[3]!.column : header[1]!.column, `duplicate require alias ${JSON.stringify(name)}`, "Choose a unique `as` alias or remove the duplicate require.");
      seenRequireNames.add(name);
      const require: Require = { ref, alias, name, mode: undefined, selectors: [], comments: pending };
      mod.requires.push(require);
      pending = [];
      if (opens) block = { kind: "require", value: require, line };
      continue;
    }
    if (first.value === "setup") {
      if (tokens.at(-1)?.value !== "(" || tokens.length !== 3) fail(filename, line, first.column, "setup requires one name and a block", "Use `setup <name> (` and close it with `)`.");
      const name = tokens[1]!.value;
      if (!aliasPattern.test(name)) fail(filename, line, tokens[1]!.column, `invalid setup name ${JSON.stringify(name)}`, "Use lowercase letters or digits, then lowercase letters, digits, dots, underscores, or hyphens.");
      if (mod.setups[name]) fail(filename, line, tokens[1]!.column, `duplicate setup ${JSON.stringify(name)}`, "Keep one block per setup name.");
      const setup: Setup = { name, root: "home", rootComments: [], mode: undefined, selectors: [], harnesses: [], comments: pending };
      mod.setups[name] = setup;
      pending = [];
      block = { kind: "setup", value: setup, line };
      continue;
    }
    if (first.value === "harness") {
      if (tokens.at(-1)?.value !== "(") fail(filename, line, first.column, "harness requires a non-nested block", "End `harness <id>` with `(` and close it with `)`.");
      if (tokens.length !== 3) fail(filename, line, first.column, "harness expects exactly one identifier", `Use \`harness <${HARNESS_IDS.join("|")}> (\`.`);
      const id = tokens[1]!.value;
      if (id === "opencode-v2") fail(filename, line, tokens[1]!.column, "retired harness \"opencode-v2\"", "Rename this block to `harness opencode`. Use `install --path` for destination changes.");
      if (!(HARNESS_IDS as readonly string[]).includes(id)) fail(filename, line, tokens[1]!.column, `unknown harness ${JSON.stringify(id)}`, `Use one of: ${HARNESS_IDS.join(", ")}.`);
      if (mod.harnesses[id]) fail(filename, line, tokens[1]!.column, `duplicate harness ${JSON.stringify(id)}`, "Keep one block per harness.");
      const harness: Harness = { id: id as HarnessId, tokens: {}, tokenComments: {}, omissions: [], comments: pending };
      mod.harnesses[id] = harness;
      pending = [];
      block = { kind: "harness", value: harness, line };
      continue;
    }
    fail(filename, line, first.column, `unknown directive ${JSON.stringify(first.value)}`, "Use skillful, skills, commands, rules, require, harness, or setup.");
  }
  if (!sawHeader) fail(filename, 1, 1, "the first semantic directive must be exactly `skillful 1`", "Add `skillful 1` to the manifest.");
  if (block) fail(filename, block.line, 1, `unclosed ${block.kind} block`, "Add `)` on its own semantic line.");
  return mod;
}

export function formatMod(mod: SkillMod): string {
  const lines: string[] = [];
  emitComments(lines, mod.headerComments);
  lines.push("skillful 1");
  const roots = ["skills", "commands", "rules"] as const;
  let wroteRoot = false;
  for (const root of roots) {
    if (!wroteRoot) lines.push("");
    wroteRoot = true;
    emitComments(lines, mod.rootComments[root]);
    lines.push(`${root} ${quote(mod.roots[root])}`);
  }
  for (const requirement of [...mod.requires].sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref))) {
    lines.push("");
    emitComments(lines, requirement.comments);
    const header = `require ${quote(requirement.ref)}${requirement.alias ? ` as ${requirement.alias}` : ""}`;
    if (!requirement.mode) lines.push(header);
    else {
      lines.push(`${header} (`);
      for (const selector of [...requirement.selectors].sort()) lines.push(`  ${requirement.mode} ${quote(selector)}`);
      lines.push(")");
    }
  }
  for (const harness of Object.values(mod.harnesses).sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push("");
    emitComments(lines, harness.comments);
    lines.push(`harness ${harness.id} (`);
    for (const name of Object.keys(harness.tokens).sort()) {
      emitComments(lines, harness.tokenComments[name] ?? []);
      lines.push(`  token ${quote(name)} ${JSON.stringify(harness.tokens[name])}`);
    }
    for (const omission of [...harness.omissions].sort((a, b) => a.kind.localeCompare(b.kind) || a.selector.localeCompare(b.selector))) {
      emitComments(lines, omission.comments);
      lines.push(`  ${omission.kind} ${quote(omission.selector)} ${JSON.stringify(omission.reason)}`);
    }
    lines.push(")");
  }
  for (const setup of Object.values(mod.setups).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push("");
    emitComments(lines, setup.comments);
    lines.push(`setup ${setup.name} (`);
    if (setup.root === "project") {
      for (const comment of setup.rootComments) lines.push(`  ${comment}`);
      lines.push("  root project");
    }
    for (const selector of [...setup.selectors].sort((a, b) => a.name.localeCompare(b.name))) {
      for (const comment of selector.comments) lines.push(`  ${comment}`);
      lines.push(selector.kind === "only-skill"
        ? `  only-skill ${quote(selector.name)}`
        : `  omit-skill ${quote(selector.name)} ${JSON.stringify(selector.reason)}`);
    }
    let simple: HarnessId[] = [];
    const flushSimple = () => {
      if (simple.length) lines.push(`  ${simple.join(" ")}`);
      simple = [];
    };
    for (const harness of setup.harnesses) {
      if (!Object.keys(harness.paths).length) {
        if (harness.comments.length) {
          flushSimple();
          for (const comment of harness.comments) lines.push(`  ${comment}`);
        }
        simple.push(harness.id);
        continue;
      }
      flushSimple();
      for (const comment of harness.comments) lines.push(`  ${comment}`);
      lines.push("");
      lines.push(`  ${harness.id} (`);
      for (const category of ["skills", "commands", "rules"] as const) if (harness.paths[category]) {
        for (const comment of harness.pathComments[category] ?? []) lines.push(`    ${comment}`);
        lines.push(`    ${category} ${quote(harness.paths[category]!)}`);
      }
      lines.push("  )");
    }
    flushSimple();
    lines.push(")");
  }
  return `${lines.join("\n")}\n`;
}

export function formatText(text: string, filename = "skill.mod") { return formatMod(parseMod(text, filename)); }
