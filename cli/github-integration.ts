import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchEntry } from "./deps.ts";
import { narHash } from "./nar.ts";

const [cache, nixTree] = process.argv.slice(2);
if (!cache || !nixTree) throw new Error("usage: github-integration CACHE NIX_TREE");
const entry = {
  name: "angular",
  ref: "github:angular/skills@main",
  rev: "db574d779823fad75472413768838c909f4bf7fa",
  narHash: "sha256-BQBdtRIqsxRJ9i+pUggiTZNUyF6gut97iEBzEtKgx2o=",
};
const cliTree = await fetchEntry(entry, cache);
if (narHash(cliTree) !== entry.narHash || narHash(nixTree) !== entry.narHash) throw new Error("CLI and fetchTree NAR hashes differ");
const selected = join("angular-developer", "SKILL.md");
if (!existsSync(join(cliTree, selected)) || !readFileSync(join(cliTree, selected)).equals(readFileSync(join(nixTree, selected)))) throw new Error("selected GitHub subdirectory content differs");
