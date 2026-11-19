# skillful

**Pin, compose and override agent skills across every coding agent and machine you use.**

Skillful is a skills manager for people who run several coding agents (Antigravity,
Claude Code, Codex, Cursor, Grok, OpenCode, Pi) on more than one machine. One file
says where your skills come from, which agents get them and what each machine
selects. Skillful locks other people's skills to an exact revision, applies
your changes without a fork, and writes each agent's native layout.

```text
skillful 2

local ./skills ./commands
rules ./rules/global_agents.md

use github:vercel-labs/agent-browser/skills@main { agent-browser }

agent-browser.description = "Drive a real browser from the terminal. Use for any task on a website."
agent-browser.body.append on pi = "\nRun long browser sessions through the process tool.\n"
agent-browser.body.replace "npm i -g agent-browser" with "bun add -g agent-browser"

agents claude codex pi cursor

skip agent-browser on cursor "Cursor has its own browser"

machine work-mac
machine laptop skip agent-browser
```

That is a whole project's `skill.mod`: your own skills, one upstream skill
with three changes, four agents and two machines. On `work-mac` it installs:

```console
$ skillful install work-mac --dry-run
Would install into /Users/you: 8 add, 0 change, 0 delete
add    .agents/skills/release-notes/SKILL.md
add    .claude/CLAUDE.md
add    .claude/skills/agent-browser/SKILL.md
add    .claude/skills/release-notes/SKILL.md
add    .codex/AGENTS.md
add    .codex/skills/agent-browser/SKILL.md
add    .pi/agent/AGENTS.md
add    .pi/agent/skills/agent-browser/SKILL.md
```

Your own `release-notes` skill is written once to `.agents/skills`, which
Codex, Cursor, Grok, OpenCode and Pi all read, and once for Claude Code.
`agent-browser` differs between agents, so each agent that gets it has its own
copy, and Cursor has none. On `laptop` it is left out altogether. Your rules
land in each agent's own rules file, such as `~/.claude/CLAUDE.md`.

## Why skillful

- **Pinned.** `skill.lock` records the exact revision of every upstream source
  and a hash of the whole fetched tree. Nothing moves until you run
  `skillful update`.
- **Yours without a fork.** Change an upstream skill's description or
  instructions from `skill.mod`, and hear about it when upstream changes what
  you replaced.
- **One source, every agent.** Each agent gets the folders, front matter and
  command files it expects. No agent gets the same skill twice.
- **Per machine.** Name each machine and what it skips. The same repository
  installs the right set everywhere.

A single agent on a single machine doesn't need this. Plain files are enough.

## Install

Skillful builds to one standalone binary with [Bun](https://bun.sh) 1.4.4 or
later. The binary needs Git and `tar` at runtime, and nothing else.

```sh
git clone https://github.com/builtwithtofu/skillful
cd skillful
bun install --frozen-lockfile
bun run build
./dist/skillful --help
```

Put `dist/skillful` on your `PATH`.

## Start

Try a local-only project without editing any files:

```sh
skillful init --dir ./example-agent
cd ./example-agent
skillful render
skillful install example --dry-run
```

`init` writes the simplest `skill.mod`, which installs as it is:

```text
skillful 2

local ./skills ./commands
rules ./rules/global_agents.md

agents antigravity claude codex cursor grok opencode pi

machine example
```

`skillful install example` installs that machine. Name a machine after a
computer's short hostname (`hostname -s`, in lowercase) and plain
`skillful install` picks it there. When no machine matches, it stops and
lists the ones you declared.

To build the project shown above instead, start in a separate directory.
A project is a directory holding `skill.mod`, your own skills, commands and
rules, and the `skill.lock` that skillful writes.

```sh
mkdir -p agent/skills/release-notes agent/commands agent/rules
cd agent
echo "Keep replies short." > rules/global_agents.md
```

Write one skill of your own in `skills/release-notes/SKILL.md`:

```markdown
---
name: release-notes
description: Write release notes from the commits since the last tag. Use when cutting a release.
---

# Release notes

List what changed for users, newest first. Leave out refactors and chores.
```

Save the file at the top of this page as `skill.mod`, then pin, check and
install:

```sh
skillful update                      # resolve each `use` and write skill.lock
skillful check                       # validate the project
skillful install work-mac --dry-run  # show what would be written
skillful install work-mac            # write it
```

Only `install` writes to your agents' folders. It refuses to overwrite files
it doesn't own. Commit `skill.mod` and `skill.lock`. On your next machine:

```sh
skillful fetch                       # download exactly what the lock names
skillful install laptop              # or `skillful install`, if its hostname is laptop
```

## Pin

`use <ref> { skills }` takes the named skills from a `github:`, `git:` or
`path:` source. `skillful update` writes one line per source to `skill.lock`:
the ref, the commit it resolved to, and a hash of the fetched tree.

- The hash covers every file in the tree, so a skill's scripts, references
  and assets are verified along with its `SKILL.md`. This matters most for
  skills that ship scripts your agent will run.
- Pins move only when you run `skillful update`, or
  `skillful update github:vercel-labs/agent-browser/skills@main` for one source.
- `skillful fetch` fails with a hash mismatch if the tree at a pinned revision
  is not the one you locked.
- `check`, `render` and `install` never touch the network.

Add another source with `skillful add`:

```sh
skillful add github:angular/skills@main --only angular-developer
```

## Override

Change any selected skill from `skill.mod`. The upstream repository stays
untouched and your changes are reapplied on every update.

```text
agent-browser.description = "Drive a real browser from the terminal. Use for any task on a website."
agent-browser.body.append on pi = "\nRun long browser sessions through the process tool.\n"
agent-browser.body.replace "npm i -g agent-browser" with "bun add -g agent-browser"
```

- `<skill>.<field> = value` replaces a front-matter field, and `.append` adds to it.
- `.body = value` replaces the instructions, `.body.append` adds to them, and
  `.body.replace A with B` swaps one exact passage.
- A value is a quoted string, or a path such as `./overlays/browser.md`.
- `on <agent>` limits an override to one agent.

A `.body.replace` whose passage isn't found exactly once stops the render and
names the skill and the locked revision. After upstream changes a field or
body you replaced with `=`, `skillful check` warns and names it, so you can
look at the new text before your override hides it.

## Agents and machines

```text
agents claude codex pi cursor

skip agent-browser on cursor "Cursor has its own browser"

machine work-mac
machine laptop skip agent-browser
```

- `agents` lists the agents to render for. Every skill goes to every agent.
- `skip <skills> on <agents> "reason"` keeps skills from some agents.
- `machine <name>` declares a machine, and `skip` on its line removes skills
  there only.

Everything about where things install lives in `skill.mod` too. The defaults
cover the common case, and three more lines cover the rest:

```text
only release-notes on claude codex "Releases are cut from these two"

harness pi {
  skills .pi/work/skills
}

machine studio {
  harness claude {
    skills .claude-work/skills
  }
  skip agent-browser
}
```

- `only <skills> on <agents> "reason"` gives skills to the named agents and no
  others.
- `harness <agent> { skills <path> commands <path> rules <path> }` changes
  where an agent's files go, or defines an agent skillful doesn't know.
  Anything you leave out keeps its default. Add `reads-shared` for a new
  agent that reads `.agents/skills`.
- A `machine` takes braces only when it has its own `harness`, which wins over
  the top-level one on that machine.

```sh
skillful list skills           # which agents get each skill
skillful setup show laptop     # what one machine installs, and where
skillful render laptop         # build the tree under ./rendered without installing
```

## Migrate from skillful 1

Files that start `skillful 1` keep working. To move one to skillful 2:

```sh
skillful migrate
skillful render --dry-run
```

`migrate` rewrites `skill.mod` and local body fences in place and keeps your pins. It stops without
writing if a setting can't be translated without changing what renders. The
same project in each form, below its root lines:

<table>
<tr><th>skillful 1</th><th>skillful 2</th></tr>
<tr><td>

```text
require github:vercel-labs/agent-browser/skills@main as agent-browser (
  only agent-browser
)

harness claude (
)

harness codex (
)

harness cursor (
  omit-skill agent-browser "Cursor has its own browser"
)

harness pi (
)

setup laptop (
  omit-skill agent-browser "Not used on the laptop."
  claude codex pi cursor
)

setup work-mac (
  claude codex pi cursor
)
```

</td><td>

```text
use github:vercel-labs/agent-browser/skills@main { agent-browser }

agents claude codex cursor pi

skip agent-browser on cursor "Cursor has its own browser"

// "agent-browser": "Not used on the laptop."
machine laptop skip agent-browser
machine work-mac
```

</td></tr>
</table>

## Learn more

The CLI carries its own documentation.

```sh
skillful --help              # what skillful is for, and every command
skillful skills tree         # the list of guides
skillful skills show mod     # one guide: everything skill.mod accepts
skillful <command> --help    # flags and examples for one command
```

## Use with Nix

Nix can build the same project from the same lock. It reads `skill.lock`,
fetches those exact pins with `fetchTree`, and runs `skillful render` with no
network and no import-from-derivation. The CLI is
`inputs.skillful.packages.${system}.skillful`.

```nix
project = inputs.skillful.lib.mkProject {
  inherit pkgs;
  source = self;
  projectDir = "agent";
  dependencyOverrides.shared = inputs.shared-skills;
  extraRoots.skills = [ { origin = "workstation"; source = ./host-skills; } ];
};

packages.${system}.default = project.rendered;
checks.${system} = project.checks;

pi = project.forHarness "pi";
# pi = { paths; skills; commands; rules; }

laptop = project.forSetup "laptop";
# laptop = { name; root; selection; rendered; harnesses; files; }
```

`forSetup` takes a skillful 2 `machine` name or a skillful 1 `setup` name and
builds the same layout as `skillful install`, shared skills folder included.
Home Manager can consume its `files` map directly:

```nix
home.file = pkgs.lib.mapAttrs (_: file: {
  inherit (file) source recursive;
}) laptop.files;
```

- `project.rendered` is the complete render, and `project.forHarness` is one
  agent's view. Deploy from `files`; `rendered` is a build tree, not a
  destination map.
- `source` is the flake (`self`) or another flake input, and `projectDir` is
  the directory holding `skill.mod`. `path:../shared/skills` dependencies can
  reach sibling trees in the same source. Relative working-tree paths are
  rejected.
- `dependencyOverrides` substitute a declared, locked remote while rendering
  and never replace its lock entry. `extraRoots` add host content without
  editing `skill.mod`.
- Pins still move only through `skillful update`. `nix flake update` does not
  move them.

## Development

```sh
bun install --frozen-lockfile
bun test cli
bun run typecheck
nix flake check path:.
```

## License

[MIT](LICENSE)
