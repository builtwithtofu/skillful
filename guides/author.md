# author

Write one `SKILL.md`. The frontmatter `name` and `description` are the load gate.
The body says how and when to use the skill — not a restatement of the files beside it.

Not `mod` (that declares the project). Not `render` (that emits harness files).

A skill folder is `skills/<name>/SKILL.md`, optional `COMMAND.md`, optional
`references/` and scripts. `$@` is the argument placeholder; the renderer translates
it per harness. `user-invocable: false` suppresses a generated command router.
Codex has no command directory. Matching commands merge into the skill; a standalone
command becomes a manual-only Codex skill under `.agents/skills`. Cursor also turns a
standalone command into a manual-only skill, under `.cursor/skills`. Grok merges
matching commands into skills and keeps unmatched commands under `.grok/commands`.
Commands converted to Codex or Cursor skills must use Agent Skill names: at most 64
lowercase letters, numbers, and single hyphens.

Harness-only lines use fences such as `{{#codex}}`, `{{#cursor}}`, `{{#grok}}`, and
their inverted forms, closed by `{{/}}`. Tokens come from `skill.mod`. `skillful
schema` lists harness facts and markup.

```bash
skillful fmt --check
skillful check --strict
skillful inspect <skill> --rendered
```

`skillful author` is not a command.
