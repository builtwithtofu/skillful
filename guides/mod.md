# mod

`skill.mod` is the project declaration. `fmt` parses and rewrites it. Every mutating
command uses the same formatter.

Not `deps` (that resolves and fetches what this file declares).

The first directive is `skillful 1` or `skillful 2`. `fmt` keeps that version.

Use `skillful migrate` (or `skillful migrate --project ./agent`) to rewrite a
skillful 1 manifest in place. Migration keeps the revisions of selected sources,
merges duplicate pins at the same revision, and removes unused pins. Run
`skillful fetch` first if a pin is missing from the cache. Migration stops rather
than guessing at settings with no direct translation, such as custom tokens or
setups with different agent lists. If it cannot find an omitted skill, declare
its source or remove the omission if the skill is retired.
Setup install path overrides become `harness` paths inside the corresponding
`machine`, except that `.agents/skills` overrides for agents that read the shared
folder use shared placement instead. Run `skillful render <machine>` afterward
to verify the delivered files.

```text
skillful 2

local ./skills ./commands
rules ./rules/global_agents.md

use github:angular/skills@main { angular-developer angular-new-app }

agents claude pi codex

only angular-developer on pi "Uses Pi tools."

skip angular-new-app on codex "Only scaffold in Claude Code and Pi."

machine work-mac
machine personal skip angular-developer angular-new-app
```

`local` takes the skill root, then the command root. Without `local` or `rules`,
Skillful uses `./skills`, `./commands`, and `./rules/global_agents.md` if present
and skips any that are missing. Explicit paths must exist. `use` names the exact
skills from a `github:`, `git:`, or `path:` source. Each declared agent gets every
selected skill unless it is skipped for that agent or machine, or restricted by
`only <skills> on <agents> "reason"`. An `only` line limits delivery to the named
agents without adding them to the machine. Multiple `only` lines for the same
skill combine their agent lists; `skip` still excludes a skill.
Unknown directives, agents, or skill names are errors with a line number; skill
names are checked when resolving sources (`check` or `render`), not during `fmt`.

Use `harness` to change install paths, or define an agent and list it in `agents`:

```text
agents claude pi local-agent
harness pi { rules .pi/agent/GENERAL.md }
harness local-agent {
  skills .local-agent/skills
  commands .local-agent/commands
  rules .local-agent/RULES.md
  reads-shared
}
machine laptop
machine work-mac {
  harness pi { rules .pi/agent/WORK.md }
  skip angular-new-app
}
```

Paths are relative to the install root (your home by default). A machine's
fields win over top-level fields; unset fields keep their defaults. A new agent
needs a `skills` path. Set `commands` to install separate command files;
otherwise an agent without a command destination gets commands as skills.
`reads-shared` opts an agent into `.agents/skills`. Claude Code defaults to
`~/.claude/CLAUDE.md`; Cursor has no default rules path.
Replace a skill's front-matter field with `<skill>.<field> = "…"`, or add text
with `<skill>.<field>.append = "…"`. Use an unquoted project-relative file path
instead of a quoted string to read the value from a file. For one agent, put
`on <agent>` before `=`:

```text
angular-developer.description = "Angular guidance"
angular-developer.description.append on pi = " Use the process tool for builds."
```

Use `.body =` to replace the instructions or `.body.append =` to add text
verbatim (include a leading newline if needed). Use `.body.replace` to swap an
exact passage. Both operands can be quoted strings or project-relative paths.
Rendering stops if the passage does not appear exactly once.

```text
angular-developer.body = ./overlays/angular-developer-full.md
angular-developer.body.append on pi = "\nRun `ng build` through the process tool.\n"
ketchup.body.replace "Draw a Mermaid diagram of the flow." with "Describe the flow as a numbered list."
```

Every-agent overrides run first, then agent-specific ones, each in file order.
The agent's existing front-matter rules still apply. Overrides require a skill
selected by the project. Run `skillful update` to record the upstream fields and
bodies replaced by `=` in `skill.lock`; `skillful check` warns if those drift.
Appends and exact-passage replacements do not get drift warnings.

Skillful 1 keeps `skills`, `commands`, and `rules` roots, `require` with `only` or
`exclude`, and `harness` and `setup` blocks. Source paths stay inside their allowed
roots in both versions.

`init` writes a skillful 2 project with local examples and an `example` machine.
Render it or preview an install before making any edits:

```bash
skillful init --dir ./agent
cd ./agent
skillful render
skillful install example --dry-run
skillful fmt --check
skillful fmt
skillful check
```

`skillful mod` is not a command. For pins, run `skillful skills show deps`.
