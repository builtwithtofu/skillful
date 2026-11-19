# author

Write one `SKILL.md`. The frontmatter `name` and `description` are the load gate.
The body says how and when to use the skill — not a restatement of the files beside it.

Not `mod` (that declares the project). Not `render` (that emits harness files).

A skill folder is `skills/<name>/SKILL.md`, optional `references/` and scripts. The
model loads a skill when its description matches, and the person can invoke it too.

A command is a saved prompt the person runs by name: `commands/<name>.md`, separate
from any skill. Pi, OpenCode, and Grok receive it as a prompt or command file. Claude,
Codex, and Cursor have no saved prompts, so it becomes a skill only the person can
invoke. A command needs no `SKILL.md`; a skill folder cannot hold a `COMMAND.md`, and a
command cannot share a skill's name. Codex and Cursor require Agent Skill names for
skills and commands: at most 64 lowercase letters, numbers, and single hyphens.

On Antigravity, a command becomes an ordinary skill, so the model may load it
when its description matches, not only when the person runs it. In Antigravity's CLI
(`agy`), each skill is also a slash command.

`$@` is the argument placeholder; the renderer translates it per harness. Markup in
code spans and fenced code blocks is shown as written. A render error names the file
and line and tells you how to fix it. For an overridden body, the error names the
skill file and lists the override lines in `skill.mod`.

In skillful 2 skill, command, and rules bodies, put each fence on its own line:

```markdown
<!-- only codex pi -->
These lines go to Codex or Pi.
<!-- end -->
<!-- skip codex pi -->
These lines go to every other agent.
<!-- end -->
```

Fences cannot nest. Selectors are whitespace-separated built-in harness names or
custom names listed in `agents`; any one match is enough. `model:...` and other
`kind:value` selectors are not supported yet. Multiline comments and other HTML
comments are left alone.

Skillful 2 bodies do not support tokens or legacy brace fences. Skillful 1 keeps
its original markup. Dependencies use the consuming project's body syntax, so
select a pin whose bodies already use comment fences.
`skillful schema` lists harness facts and the project's markup.

Skillful 2 also rejects legacy brace markup in frontmatter. For agent-specific
skill frontmatter, set `<skill>.<field> on <agent> = "value"` in `skill.mod`.

```bash
skillful fmt --check
skillful check --strict
skillful inspect <skill> --rendered
```

`skillful author` is not a command.
