# author

Write one `SKILL.md`. The frontmatter `name` and `description` are the load gate.
The body says how and when to use the skill — not a restatement of the files beside it.

Not `mod` (that declares the project). Not `render` (that emits harness files).

A skill folder is `skills/<name>/SKILL.md`, optional `COMMAND.md`, optional
`references/` and scripts. `$@` is the argument placeholder; the renderer translates
it per harness. `user-invocable: false` suppresses a generated command router.

Harness-only lines use fences. Tokens come from `skill.mod`. `skillful schema`
lists harness facts and markup.

```bash
skillful fmt --check
skillful check --strict
skillful inspect <skill> --rendered
```

`skillful author` is not a command.
