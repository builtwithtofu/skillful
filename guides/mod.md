# mod

`skill.mod` is the project declaration. `fmt` parses and rewrites it. Every mutating
command uses the same formatter.

Not `deps` (that resolves and fetches what this file declares).

The first semantic directive is exactly `skillful 1`. Roots stay inside the project.
`require` uses `github:`, `git:`, or `path:` and may take `only` or `exclude`, not
both. Harness blocks select default render outputs and hold their tokens and
omissions. Setup blocks list bare harness outputs plus only the machine-specific
selection, root, and path exceptions.

Unknown directives, mixed selectors, duplicate setup outputs, and escaping paths
are hard errors.

```bash
skillful init --dir DIR
skillful fmt --check
skillful fmt
```

`skillful mod` is not a command. Edit `skill.mod`, then `fmt`.
