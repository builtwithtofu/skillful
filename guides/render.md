# render

Render a managed build tree. By default, render uses the agents in skillful 2 or
the declared harnesses in skillful 1. Name a machine or setup to apply its skill
selection. In skillful 2, a skill goes in `.agents/skills` only when at least two
shared-folder agents (Codex, Grok, Pi, OpenCode, or Cursor) get the same copy.
Skills for a lone reader, or skills that differ or are skipped, use the receiving
agents' own folders. Claude Code always uses `.claude/skills`. Skillful 1 continues
to render skills in `<harness>/skills`.

`--harness` refreshes the named outputs. In skillful 2 it can also regroup the
skills of already-rendered shared-folder agents and refresh their skill contracts,
without touching commands or rules. Only `install` writes live harness destinations.
`--dry-run` first.

Not `inspect` (that does not write). Not a substitute for editing sources.

```bash
skillful render --dry-run
skillful render work-mac
skillful render --harness pi --out ./rendered
skillful install work-mac --dry-run
skillful install --harness opencode --path skills=.config/opencode-v2/skills --path commands=.config/opencode-v2/commands
```

`install` records exclusive ownership, refuses unmanaged or edited collisions,
and removes only unchanged stale files. Different destination roots stay
independent. `--path` installs one public harness into a nonstandard layout. An
OpenCode install at retired `opencode-v2` paths adopts that receipt and migrates
unchanged stale files. `--force` never permits an escape, takes files through
another path, receipt, or symlink alias, or deletes a changed stale file.
A one-off skillful 2 install refuses to duplicate an owned shared skill. Rerun
the machine install to switch layouts.
`install <setup> --remove` rejects `--force` and retires only unchanged files
from that setup's receipt. A named render contains only that setup's selected
skills and harness outputs.

`skillful render -h` · `skillful install -h`
