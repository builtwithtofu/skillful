# render

Render a managed build tree. Without a setup or `--harness`, it contains only the
harnesses declared in `skill.mod`; no declarations is an error. A named setup
reconciles its exact set. `--harness` updates only the named outputs and preserves
other managed renders. Only `install` writes live harness destinations. `--dry-run`
first.

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
`install <setup> --remove` rejects `--force` and retires only unchanged files
from that setup's receipt. A named render contains only that setup's selected
skills and harness outputs.

`skillful render -h` · `skillful install -h`
