# skillful

Author agent skills once, render them per harness.

You write skills, commands, and rules in one project. Skillful renders that
corpus for each harness: `claude`, `codex`, `cursor`, `grok`, `opencode`, `pi`.
Other people's trees come in through Git (`github:`, `git:`, `path:`).

Plain files are enough for a single harness. Use skillful when one tree must
serve several harnesses, or when you compose another tree with your own.

The CLI is the product. A project is `skill.mod`, optional `skill.lock`, and
the files under `skills/`, `commands/`, and `rules/`. One `SKILL.md` is
rewritten per harness: tokens from `skill.mod`, harness fences, argument
syntax, and the frontmatter that harness accepts. Only `install` writes live
destinations.

Nix is the other way to run the same project. It consumes the lock and the
renderer so the tree is Nix-compatible from the first pin.

## Install

Build a standalone binary with Bun. The result does not need Bun, Node, or npm
at runtime. Git-backed dependencies and historical diffs need Git. Remote
extraction needs `tar`.

```sh
bun install --frozen-lockfile
bun run build
./dist/skillful --help
```

From a Nix flake, the same binary is `inputs.skillful.packages.${system}.skillful`.
The Nix package follows `package.json` and `bun.lock`. Skill commands stay in
`skillful --help` and `skillful skills tree`.

## Use the CLI

```sh
skillful init --dir ./agent
cd ./agent
skillful add github:owner/repo
skillful list skills
skillful list setups
skillful setup show work-mac
skillful render work-mac --dry-run
skillful install work-mac --dry-run
skillful install old-work --remove --dry-run
```

`skillful --help` orients. `skillful <command> --help` is the flag reference.
Named setups keep machine-specific selection and harness paths in `skill.mod`;
`install --harness` remains the one-off form. For a job map, run `skillful skills
tree`, then `skillful skills show <topic>`.

Only `add` and `update` resolve revisions. `fetch` retrieves exact pins.
Inspection, check, render, and install never resolve.

## Use Nix

Nix reads `skill.lock`, fetches those exact pins with `fetchTree`, and runs
`skillful render` with no network. No import-from-derivation. Command meaning
stays in `skillful --help` and `skillful skills tree`.

```nix
project = inputs.skillful.lib.mkProject {
  inherit pkgs;
  src = ./.;
  projectDir = "agent";
  dependencyOverrides.shared = pkgs.shared-skills;
  extraRoots.skills = [ { origin = "workstation"; src = ./host-skills; } ];
};

packages.${system} = {
  default = project.rendered;
  skillful = project.cli;
};

checks.${system} = project.checks;

pi = project.forHarness "pi";
# pi = { installPaths; skills; commands; rules; }

personal = project.forSetup "personal";
workMac = project.forSetup "work-mac";
# setup = { name; root; harnesses; rendered; outputs; files; }
```

A Home Manager configuration can consume a home-root setup without restating its
paths:

```nix
home.file = pkgs.lib.mapAttrs (_: file: {
  inherit (file) source recursive;
}) personal.files;
```

```sh
nix build
nix flake check
nix run .#skillful -- update
nix run .#skillful -- update angular
```

`nix build` is the complete render. Each harness view is a path inside it.
`project.forSetup` evaluates the named declaration directly from `skill.mod`, then
builds only that setup through the same renderer. Its destination-keyed `files`
map is ordinary Nix data; evaluation never runs the CLI or reads a derivation.
`nix run .#skillful -- update` writes `skill.lock` through the Skillful CLI.
`nix flake update` does not move skill pins.

`projectDir` selects the directory containing `skill.mod` within `src`. This lets
`path:../shared/skills` dependencies use sibling trees from the same source
workspace. `dependencyOverrides` substitute a declared, locked remote while
rendering; they never replace its fallback lock. `extraRoots` add named host
content without editing `skill.mod`.

`project.cli` uses the working project discovered from the current directory for
`fmt`, `add`, `fetch`, and `update`; pass `--project DIR` when working elsewhere.
Understand and deliver commands use the pinned Nix project with its overrides and
extra roots. This keeps lock maintenance writable without changing built renders.

## Development

```sh
bun test cli
bun run typecheck
nix flake check path:.
```

See `skillful --help` and `skillful skills tree`.
