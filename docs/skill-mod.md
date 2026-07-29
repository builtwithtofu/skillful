# skill.mod

`skill.mod` is the canonical project declaration. `skillful fmt` parses and rewrites it; every
mutating command uses the same formatter.

```text
skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

require github:owner/repo@main as dependency (
  only one-skill
)

harness pi (
  token audience "Pi users"
  omit-skill unavailable "Requires another tool."
)
```

The first semantic directive is exactly `skillful 1`. Roots stay inside the project. Requires use
`github:`, `git:`, or project-local `path:` references and may contain either `only` or `exclude`
selectors. Harness blocks contain tokens and skill/command omissions. Blocks do not nest.

Blank lines and `//` comments are allowed. Quoted values use JSON escaping. Unknown directives,
duplicates, mixed selector modes, malformed blocks, escaping paths, and unknown harnesses are hard
errors with line/column recovery guidance.
