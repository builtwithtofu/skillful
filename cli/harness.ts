import claude from "../harnesses/claude.json";
import opencode from "../harnesses/opencode.json";
import opencodeV2 from "../harnesses/opencode-v2.json";
import pi from "../harnesses/pi.json";
import { HARNESS_IDS, type HarnessId } from "./mod.ts";

export type HarnessFacts = {
  name: HarnessId;
  installPaths: { skills: string; commands: string; rules?: string };
  argSyntax: string;
  skillFrontmatter: string[];
  commandFrontmatter: string[];
  commandMerge: "inject" | "file";
};
export class HarnessError extends Error { constructor(message: string, readonly recovery = "Choose one of: claude, pi, opencode, opencode-v2.") { super(message); } }

const EMBEDDED_FACTS: ReadonlyArray<readonly [string, unknown]> = [
  ["claude.json", claude],
  ["opencode.json", opencode],
  ["opencode-v2.json", opencodeV2],
  ["pi.json", pi],
];
function validate(candidate: unknown, path: string): HarnessFacts {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new HarnessError(`invalid harness facts ${path}: expected an object`, "Repair the bundled harness JSON before using skillful.");
  const value = candidate as Record<string, unknown>;
  const name = value.name;
  if (typeof name !== "string" || !(HARNESS_IDS as readonly string[]).includes(name)) throw new HarnessError(`invalid harness facts ${path}: unknown name`, "Use one public harness identifier.");
  const installPaths = value.installPaths;
  if (!installPaths || typeof installPaths !== "object" || Array.isArray(installPaths)) throw new HarnessError(`invalid harness facts ${path}: installPaths must be an object`, "Repair the bundled harness JSON before using skillful.");
  const paths = installPaths as Record<string, unknown>;
  if (typeof paths.skills !== "string" || typeof paths.commands !== "string" || (paths.rules !== undefined && typeof paths.rules !== "string")) throw new HarnessError(`invalid harness facts ${path}: installPaths needs string skills and commands`, "Repair the bundled harness JSON before using skillful.");
  if (typeof value.argSyntax !== "string" || (value.commandMerge !== "inject" && value.commandMerge !== "file")) throw new HarnessError(`invalid harness facts ${path}: argSyntax or commandMerge is invalid`, "Repair the bundled harness JSON before using skillful.");
  for (const key of ["skillFrontmatter", "commandFrontmatter"]) if (!Array.isArray(value[key]) || !value[key]!.every((entry) => typeof entry === "string")) throw new HarnessError(`invalid harness facts ${path}: ${key} must be a string array`, "Repair the bundled harness JSON before using skillful.");
  return value as HarnessFacts;
}

export function loadHarnesses(): Record<HarnessId, HarnessFacts> {
  const result: Partial<Record<HarnessId, HarnessFacts>> = {};
  for (const [file, candidate] of EMBEDDED_FACTS) {
    const fact = validate(candidate, file);
    if (file !== `${fact.name}.json`) throw new HarnessError(`invalid harness facts ${file}: filename must match ${fact.name}.json`, "Rename the fact file or correct its name field.");
    if (result[fact.name]) throw new HarnessError(`duplicate harness facts for ${fact.name}`, "Keep one JSON fact file per public harness.");
    result[fact.name] = fact;
  }
  for (const name of HARNESS_IDS) if (!result[name]) throw new HarnessError(`missing harness facts for ${name}`, "Restore the bundled harness facts.");
  return result as Record<HarnessId, HarnessFacts>;
}

export function normalizeHarness(input: string): { name: HarnessId; warning?: string } {
  if (input === "opencodev2") throw new HarnessError("retired harness opencodev2; use opencode-v2");
  if (!(HARNESS_IDS as readonly string[]).includes(input)) throw new HarnessError(`unknown harness: ${input}`);
  return { name: input as HarnessId };
}
