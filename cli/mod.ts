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
  line?: number;
}>;
export type Omission = WithComments<{ kind: "omit-skill" | "omit-command"; selector: string; reason: string }>;
export type Harness = WithComments<{
  id: HarnessId;
  tokens: Record<string, string>;
  tokenComments: Record<string, Comments>;
  omissions: Omission[];
}>;
export type SetupSelector = WithComments<{ kind: "only-skill" | "omit-skill"; name: string; reason?: string | undefined; line?: number }>;
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
type SkillModBase = {
  headerComments: Comments;
  roots: { skills: string; commands: string; rules: string };
  rootComments: Record<"skills" | "commands" | "rules", Comments>;
  requires: Require[];
  harnesses: Record<string, Harness>;
  setups: Record<string, Setup>;
  /** Compatibility view for callers that only need comment accounting. */
  leadingComments: Comments;
};
type Skip = WithComments<{ skills: string[]; agents: HarnessId[]; reason: string; line: number }>;
export type FieldOverride = WithComments<{ skill: string; field: string; operation: "set" | "append"; value: { kind: "string" | "file"; text: string }; agent?: HarnessId; line: number }>;
type SkillMod2 = SkillModBase & {
  version: 2;
  agents: WithComments<{ ids: HarnessId[] }>;
  skips: Skip[];
  fieldOverrides: FieldOverride[];
  trailingComments: Comments;
};
export type SkillMod = (SkillModBase & { version: 1 }) | SkillMod2;

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

type Token = { value: string; column: number; quoted?: true };
const v2Punctuation = /^[{}=]$/;
type ParseBlock =
  | { kind: "require"; value: Require; line: number }
  | { kind: "harness"; value: Harness; line: number }
  | { kind: "setup"; value: Setup; line: number }
  | { kind: "setup-harness"; value: SetupHarness; setup: Setup; line: number; setupLine: number };
function fail(filename: string, line: number, column: number, message: string, recovery: string): never {
  throw new ModError(filename, line, column, message, `Recovery: ${recovery}`);
}

function tokensFor(raw: string, filename: string, line: number, compact = false): Token[] {
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
      try { tokens.push({ value: JSON.parse(literal), column, quoted: true }); }
      catch { fail(filename, line, column, "invalid JSON string", "Use a JSON-escaped double-quoted value."); }
      index = end + 1;
      continue;
    }
    let end = index + 1;
    if (!compact || !v2Punctuation.test(raw[index]!)) {
      while (end < raw.length && !/\s/.test(raw[end]!) && !(compact && (v2Punctuation.test(raw[end]!) || raw[end] === '"'))) end++;
    }
    const value = raw.slice(index, end);
    if (!compact && value !== "(" && value !== ")" && !barePattern.test(value)) fail(filename, line, column, `invalid bare token ${JSON.stringify(value)}`, "Use a quoted JSON string for whitespace, //, parentheses, or quotes.");
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
  const mod: SkillModBase & { version: 1 } = { version: 1, headerComments: [], roots, rootComments, requires: [], harnesses: {}, setups: {}, leadingComments: [] };
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
      if (first.value !== "skillful" || tokens.length !== 2 || (tokens[1]!.value !== "1" && tokens[1]!.value !== "2")) {
        if (first.value === "skillful") fail(filename, line, first.column, "unsupported skillful version", "Use `skillful 1` or `skillful 2` as the first semantic directive.");
        fail(filename, line, first.column, "the first semantic directive must be `skillful 1` or `skillful 2`", "Put the version header at the top of the file.");
      }
      sawHeader = true;
      mod.headerComments = pending;
      if (tokens[1]!.value === "2") return parseMod2(mod, lines, offset + 1, filename);
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
  if (!sawHeader) fail(filename, 1, 1, "the first semantic directive must be `skillful 1` or `skillful 2`", "Add a version header to the manifest.");
  if (block) fail(filename, block.line, 1, `unclosed ${block.kind} block`, "Add `)` on its own semantic line.");
  return mod;
}

function parseMod2(base: SkillModBase, lines: string[], start: number, filename: string): SkillMod2 {
  const mod: SkillMod2 = { ...base, version: 2, setups: Object.create(null), agents: { ids: [], comments: [] }, skips: [], fieldOverrides: [], trailingComments: [] };
  const single = new Set<string>();
  let pending: Comments = [];
  for (let offset = start; offset < lines.length; offset++) {
    const line = offset + 1;
    const raw = lines[offset]!;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//")) { pending.push(trimmed); mod.leadingComments.push(trimmed); continue; }
    const [directive, ...args] = tokensFor(raw, filename, line, true);
    const { value, column, quoted } = directive!;
    if (quoted) fail(filename, line, column, `unknown directive ${JSON.stringify(value)}`, "Write directive names without quotes.");
    const comments = pending;
    pending = [];
    const syntax = (example: string): never => fail(filename, line, column, `invalid ${value} directive`, `Use \`${example}\`.`);
    const bare = (token: Token | undefined, word: string) => token?.value === word && !token.quoted;
    const words = (tokens: Token[]) => tokens.length > 0 && tokens.every((token) => token.value && (token.quoted || !v2Punctuation.test(token.value)));
    const agents = (tokens: Token[]) => tokens.map((token) => {
      if (!(HARNESS_IDS as readonly string[]).includes(token.value)) fail(filename, line, token.column, `unknown agent ${JSON.stringify(token.value)}`, `Use one of: ${HARNESS_IDS.join(", ")}.`);
      return token.value as HarnessId;
    });
    if (["local", "rules", "agents"].includes(value)) {
      if (single.has(value)) fail(filename, line, column, `${value} may appear at most once`, "Keep one declaration.");
      single.add(value);
    }
    switch (value) {
      case "local":
        if (args.length !== 2 || !words(args)) syntax("local <skills-path> <commands-path>");
        mod.roots.skills = args[0]!.value;
        mod.roots.commands = args[1]!.value;
        mod.rootComments.skills = comments;
        break;
      case "rules":
        if (args.length !== 1 || !words(args)) syntax("rules <path>");
        mod.roots.rules = args[0]!.value;
        mod.rootComments.rules = comments;
        break;
      case "use": {
        const ref = args[0]?.value ?? "";
        const skills = args.slice(2, -1);
        if (!/^(github|git|path):.+/.test(ref) || !bare(args[1], "{") || !bare(args.at(-1), "}") || !words(skills)) syntax("use <ref> { <skills> }");
        if (mod.requires.some((entry) => entry.ref === ref)) fail(filename, line, column, `duplicate source ${ref}`, "List the skills from this source in one use directive.");
        mod.requires.push({ ref, name: ref, alias: undefined, mode: "only", selectors: skills.map((token) => token.value), comments, line });
        break;
      }
      case "agents":
        if (!args.length) syntax("agents <agents>");
        mod.agents = { ids: [...new Set(agents(args))], comments };
        break;
      case "skip": {
        const on = args.findIndex((token) => bare(token, "on"));
        const skills = args.slice(0, on);
        const targets = args.slice(on + 1, -1);
        const reason = args.at(-1);
        if (on < 1 || !words(skills) || !targets.length || !reason?.quoted) syntax('skip <skills> on <agents> "reason"');
        mod.skips.push({ skills: skills.map((token) => token.value), agents: agents(targets), reason: reason!.value, comments, line });
        break;
      }
      case "machine": {
        const name = args[0]?.value ?? "";
        const skills = args.slice(2);
        if (!aliasPattern.test(name) || (args.length > 1 && (!bare(args[1], "skip") || !words(skills)))) syntax("machine <name> [skip <skills>]");
        if (Object.hasOwn(mod.setups, name)) fail(filename, line, column, `duplicate machine ${name}`, "Keep one declaration per machine.");
        mod.setups[name] = { name, root: "home", rootComments: [], mode: skills.length ? "omit" : undefined, selectors: skills.map((token) => ({ kind: "omit-skill", name: token.value, comments: [], line })), harnesses: [], comments };
        break;
      }
      default: {
        const field = value.match(/^(.+?)\.([a-zA-Z0-9][a-zA-Z0-9_-]*)(\.append)?$/);
        if (!field || field[2] === "body") fail(filename, line, column, `unknown directive ${JSON.stringify(value)}`, "Use local, rules, use, agents, skip, machine, or a front-matter override.");
        const scoped = bare(args[0], "on");
        const rhs = args[scoped ? 3 : 1];
        if (args.length !== (scoped ? 4 : 2) || !bare(args[scoped ? 2 : 0], "=") || !rhs || (!rhs.quoted && !words([rhs]))) syntax('<skill>.<field>[.append] [on <agent>] = "value" or ./path');
        mod.fieldOverrides.push({ skill: field[1]!, field: field[2]!, operation: field[3] ? "append" : "set", value: { kind: rhs!.quoted ? "string" : "file", text: rhs!.value }, ...(scoped ? { agent: agents([args[1]!])[0]! } : {}), comments, line });
        break;
      }
    }
  }
  mod.trailingComments = pending;
  for (const id of new Set([...mod.agents.ids, ...mod.skips.flatMap((skip) => skip.agents)])) {
    const omissions = mod.skips.filter((skip) => skip.agents.includes(id)).flatMap((skip) => skip.skills.map((selector): Omission => ({ kind: "omit-skill", selector, reason: skip.reason, comments: [] })));
    mod.harnesses[id] = { id, tokens: {}, tokenComments: {}, omissions, comments: [] };
  }
  for (const setup of Object.values(mod.setups)) setup.harnesses = mod.agents.ids.map((id) => ({ id, paths: {}, pathComments: {}, comments: [] }));
  return mod;
}

function formatMod2(mod: SkillMod2): string {
  const quote = (value: string) => value && !/[\s{}="]/.test(value) && !value.startsWith("//") ? value : JSON.stringify(value);
  const lines = [...mod.headerComments, "skillful 2"];
  const section = (entries: string[][]) => { if (entries.length) lines.push("", ...entries.flat()); };
  section([
    [...mod.rootComments.skills, `local ${quote(mod.roots.skills)} ${quote(mod.roots.commands)}`],
    [...mod.rootComments.rules, `rules ${quote(mod.roots.rules)}`],
  ]);
  section(mod.requires.map(({ ref, selectors, comments }) => [...comments, `use ${quote(ref)} { ${selectors.map(quote).join(" ")} }`]));
  section(mod.fieldOverrides.map(({ skill, field, operation, agent, value, comments }) => [...comments, `${skill}.${field}${operation === "append" ? ".append" : ""}${agent ? ` on ${agent}` : ""} = ${value.kind === "string" ? JSON.stringify(value.text) : value.text}`]));
  if (mod.agents.ids.length) section([[...mod.agents.comments, `agents ${mod.agents.ids.join(" ")}`]]);
  section(mod.skips.map(({ skills, agents, reason, comments }) => [...comments, `skip ${skills.map((skill) => skill === "on" ? JSON.stringify(skill) : quote(skill)).join(" ")} on ${agents.join(" ")} ${JSON.stringify(reason)}`]));
  section(Object.values(mod.setups).map(({ name, selectors, comments }) =>
    [...comments, `machine ${name}${selectors.length ? ` skip ${selectors.map(({ name }) => quote(name)).join(" ")}` : ""}`]));
  if (mod.trailingComments.length) lines.push("", ...mod.trailingComments);
  return `${lines.join("\n")}\n`;
}
export function formatMod(mod: SkillMod): string {
  if (mod.version === 2) return formatMod2(mod);
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

export function migrateMod(mod: SkillMod, filename: string, resolveSkills: () => { name: string; origin: string; sourceKind: string }[]) {
  if (mod.version === 2) return undefined;
  const unsupported = (feature: string): never => fail(filename, 1, 1, `cannot migrate ${feature} without changing the render`, "Keep using skillful 1, or replace this setting with a skillful 2 equivalent before migrating.");
  const ids = HARNESS_IDS.filter((id) => mod.harnesses[id] !== undefined);
  for (const harness of Object.values(mod.harnesses)) if (Object.keys(harness.tokens).length) unsupported(`tokens for ${harness.id}`);
  const skills = resolveSkills();
  const known = new Set(skills.map(({ name }) => name));
  const requires = new Map<string, Require>();
  for (const requirement of mod.requires) {
    const selectors = skills.filter(({ origin, sourceKind }) => sourceKind !== "canonical" && origin === requirement.name).map(({ name }) => name);
    if (!selectors.length) continue;
    const prior = requires.get(requirement.ref);
    if (prior) { prior.selectors.push(...selectors); prior.comments.push(...requirement.comments); }
    else requires.set(requirement.ref, { ...requirement, selectors, comments: [...requirement.comments] });
  }
  const skips: Skip[] = [];
  const agentComments: Comments = [];
  for (const harness of Object.values(mod.harnesses)) {
    agentComments.push(...harness.comments);
    for (const { kind, selector, reason, comments } of harness.omissions) {
      if (kind === "omit-command") unsupported(`omit-command ${selector} for ${harness.id}`);
      if (!known.has(selector)) continue;
      const skip = skips.find((entry) => entry.skills[0] === selector && entry.reason === reason);
      if (skip) { skip.agents.push(harness.id); skip.comments.push(...comments); }
      else skips.push({ skills: [selector], agents: [harness.id], reason, comments: [...comments], line: 1 });
    }
  }
  const warnings: string[] = [];
  const setups = Object.fromEntries(Object.values(mod.setups).map((setup) => {
    if (setup.root !== "home") unsupported(`project root for setup ${setup.name}`);
    if (setup.mode === "only") unsupported(`only-skill in setup ${setup.name}`);
    if (setup.harnesses.length !== ids.length || setup.harnesses.some(({ id }) => !ids.includes(id))) unsupported(`the distinct agent list for setup ${setup.name}`);
    const comments = [...setup.comments];
    for (const { name, reason, comments: selectorComments } of setup.selectors) {
      comments.push(...selectorComments, `// ${JSON.stringify(name)}: ${JSON.stringify(reason)}`);
    }
    for (const { id, paths } of setup.harnesses) {
      for (const [kind, path] of Object.entries(paths)) {
        const setting = `${setup.name}: ${id} ${kind} ${JSON.stringify(path)}`;
        warnings.push(`skillful 2 cannot carry this install path override: ${setting}`);
        comments.push(`// Previous install path override: ${setting}`);
      }
    }
    return [setup.name, { ...setup, comments, selectors: setup.selectors.filter(({ name }) => known.has(name)) }];
  }));
  const next: SkillMod2 = { ...mod, version: 2, requires: [...requires.values()], agents: { ids, comments: agentComments }, skips, setups, fieldOverrides: [], trailingComments: [] };
  const emitted = formatMod2(next).split("\n");
  for (const comment of mod.leadingComments) {
    const index = emitted.indexOf(comment);
    if (index < 0) next.trailingComments.push(comment);
    else emitted.splice(index, 1);
  }
  const text = formatMod2(next);
  return { text, mod: parseMod(text, filename), warnings };
}

export function formatText(text: string, filename = "skill.mod") { return formatMod(parseMod(text, filename)); }
