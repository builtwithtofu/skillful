export const HARNESS_IDS = ["claude", "pi", "opencode", "opencode-v2"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

type Comments = string[];
type WithComments<T> = T & { comments: Comments };
export type Require = WithComments<{
  ref: string;
  alias?: string;
  name: string;
  mode?: "only" | "exclude";
  selectors: string[];
}>;
export type Omission = WithComments<{ kind: "omit-skill" | "omit-command"; selector: string; reason: string }>;
export type Harness = WithComments<{
  id: HarnessId;
  tokens: Record<string, string>;
  tokenComments: Record<string, Comments>;
  omissions: Omission[];
}>;
export type SkillMod = {
  headerComments: Comments;
  roots: { skills: string; commands: string; rules: string };
  rootComments: Record<"skills" | "commands" | "rules", Comments>;
  requires: Require[];
  harnesses: Record<string, Harness>;
  /** Compatibility view for callers that only need comment accounting. */
  leadingComments: Comments[];
};

export class ModError extends Error {
  constructor(readonly filename: string, readonly line: number, readonly column: number, message: string, readonly recovery: string) {
    super(`${filename}:${line}:${column}: ${message}`);
  }
}

const defaults = { skills: "./skills", commands: "./commands", rules: "./rules/global_agents.md" };
const aliasPattern = /^[a-z0-9][a-z0-9._-]*$/;
const barePattern = /^(?!.*\/\/)[^\s()"]+$/;

type Token = { value: string; column: number };
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
  const mod: SkillMod = { headerComments: [], roots, rootComments, requires: [], harnesses: {}, leadingComments: [] };
  const seenRoots = new Set<string>();
  const seenRequireNames = new Set<string>();
  let pending: Comments = [];
  let sawHeader = false;
  let block: { kind: "require"; value: Require; line: number } | { kind: "harness"; value: Harness; line: number } | undefined;
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
        block = undefined;
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
    if (first.value === "harness") {
      if (tokens.at(-1)?.value !== "(") fail(filename, line, first.column, "harness requires a non-nested block", "End `harness <id>` with `(` and close it with `)`.");
      if (tokens.length !== 3) fail(filename, line, first.column, "harness expects exactly one identifier", "Use `harness <claude|pi|opencode|opencode-v2> (`.");
      const id = tokens[1]!.value;
      if (!(HARNESS_IDS as readonly string[]).includes(id)) fail(filename, line, tokens[1]!.column, `unknown harness ${JSON.stringify(id)}`, `Use one of: ${HARNESS_IDS.join(", ")}.`);
      if (mod.harnesses[id]) fail(filename, line, tokens[1]!.column, `duplicate harness ${JSON.stringify(id)}`, "Keep one block per harness.");
      const harness: Harness = { id: id as HarnessId, tokens: {}, tokenComments: {}, omissions: [], comments: pending };
      mod.harnesses[id] = harness;
      pending = [];
      block = { kind: "harness", value: harness, line };
      continue;
    }
    fail(filename, line, first.column, `unknown directive ${JSON.stringify(first.value)}`, "Use skillful, skills, commands, rules, require, or harness.");
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
  return `${lines.join("\n")}\n`;
}

export function formatText(text: string, filename = "skill.mod") { return formatMod(parseMod(text, filename)); }
