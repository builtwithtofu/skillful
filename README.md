# skillful

Author agent skills once, render them per harness.

Skillful is a standalone executable authored in TypeScript and compiled by Bun, with a thin Nix
integration. A project owns `skill.mod`, optional `skill.lock`, and its skills, commands, and rules.
The same TypeScript plan drives inspection, rendering, installation, and sandboxed Nix builds.

## Try it

```sh
bun install --frozen-lockfile
bun run build
./dist/skillful init --dir /tmp/my-skills
cd /tmp/my-skills
/path/to/skillful/dist/skillful list skills
/path/to/skillful/dist/skillful render --dry-run
/path/to/skillful/dist/skillful install --harness pi --dry-run
```

The resulting native executable embeds the harness facts and initial project scaffold. It does not
need Bun, Node, or npm at runtime. Git-backed dependency operations and historical revision diffs
require Git; remote dependency extraction requires `tar`.

The fixed harness identifiers are `claude`, `pi`, `opencode`, and `opencode-v2`.

## User commands

```text
skillful init [--dir DIR]
skillful fmt [--check] [--project DIR]
skillful add <ref> [--name NAME] [--only SKILL]... [--exclude SKILL]...
skillful fetch
skillful update [name ...]
skillful list skills|harnesses
skillful inspect <skill> [--rendered]
skillful check [<skill>...] [--strict]
skillful diff <skill> [--against REV]
skillful manifest
skillful schema
skillful render [--harness H] [--out DIR] [--dry-run] [--force]
skillful install --harness H [--root DIR] [--dry-run] [--force]
```

`render` writes a managed build tree. Only `install` writes harness destinations; it records
ownership, refuses unmanaged or edited collisions, removes only unchanged stale files, and keeps
installations into different roots independent.

Only `add` and `update` resolve revisions. `add` also fetches; `fetch` retrieves exact existing
pins. Inspection, checks, rendering, installation, and historical diff never resolve or contact the
network. `diff --against` materializes only a revision already present in the local Git object
database.

## Nix

```nix
project = inputs.skillful.lib.mkProject {
  inherit pkgs;
  src = ./agent;
  dependencyOverrides.agent-jj = pkgs.agent-jj.passthru.skillRoot;
  extraRoots.skills = [ { origin = "workstation"; src = ./host-skills; } ];
};

pi = project.forHarness "pi";
# pi = { installPaths; skills; commands; rules; }
```

Nix reads only fixed harness JSON and `skill.lock` during evaluation. It fetches exact pins with
`fetchTree`, supplies them as local overrides, and runs `skillful render` without network access.
No import-from-derivation is required.

## Development

```sh
bun test cli
nix flake check path:.
```

See [CLI](docs/cli.md), [skill.mod](docs/skill-mod.md), [dependencies](docs/dependencies.md),
[rendering](docs/rendering.md), [commands](docs/commands.md), and [harnesses](docs/harnesses.md).
