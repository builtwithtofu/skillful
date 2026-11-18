# mod

`skill.mod` is the project declaration. `fmt` parses and rewrites it. Every mutating
command uses the same formatter.

Not `deps` (that resolves and fetches what this file declares).

The first directive is `skillful 1` or `skillful 2`. `fmt` keeps that version.

Use `skillful migrate` (or `skillful migrate --project ./agent`) to rewrite a
skillful 1 manifest in place without changing `skill.lock`. Migration stops
rather than guessing at render settings with no direct translation, such as
custom tokens or setups with different agent lists. Migration lists the skills
selected from each local or locked source; run `skillful fetch` first if a pin
is missing from the cache.
Install path overrides are preserved as comments and reported as warnings; they
no longer apply. Run `skillful render` afterward to verify the delivered files.

```text
skillful 2

local ./skills ./commands
rules ./rules/global_agents.md

use github:angular/skills@main { angular-developer angular-new-app }

agents claude pi codex

skip angular-new-app on codex "Only scaffold in Claude Code and Pi."

machine work-mac
machine personal skip angular-developer angular-new-app
```

`local` takes the skill root, then the command root. `use` names the exact skills
from a `github:`, `git:`, or `path:` source. Each declared agent gets every
selected skill except those skipped for that agent or the chosen machine.
Unknown directives, agents, or skill names are errors with a line number; skill
names are checked when resolving sources (`check` or `render`), not during `fmt`.
Replace a skill's front-matter field with `<skill>.<field> = "…"`, or add text
with `<skill>.<field>.append = "…"`. Use an unquoted project-relative file path
instead of a quoted string to read the value from a file. For one agent, put
`on <agent>` before `=`:

```text
angular-developer.description = "Angular guidance"
angular-developer.description.append on pi = " Use the process tool for builds."
```

Every-agent overrides run first, then agent-specific ones, each in file order.
The agent's existing front-matter rules still apply. Overrides require a skill
selected by the project. Run `skillful update` to record the upstream fields
replaced by `=` in `skill.lock`; `skillful check` warns if those fields drift.
Appends do not get drift warnings.

Skillful 1 keeps `skills`, `commands`, and `rules` roots, `require` with `only` or
`exclude`, and `harness` and `setup` blocks. Source paths stay inside their allowed
roots in both versions.

```bash
skillful init --dir DIR
skillful fmt --check
skillful fmt
skillful check
```

`skillful mod` is not a command. For pins, run `skillful skills show deps`.
