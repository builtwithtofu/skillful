# mod

`skill.mod` is the project declaration. `fmt` parses and rewrites it. Every mutating
command uses the same formatter.

Not `deps` (that resolves and fetches what this file declares).

The first directive is `skillful 1` or `skillful 2`. `fmt` keeps that version.

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
`fmt` preserves `<skill>.description = "…"` lines; they don't yet affect rendering.

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
