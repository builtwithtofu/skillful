# Commands

A project can provide commands in three ways:

1. `skills/<name>/COMMAND.md` co-locates a command with the skill it drives.
2. `commands/<name>.md` provides a standalone command.
3. A user-invocable skill without either receives a generated router where the
  harness emits separate command files.

Use `$@` for arguments in authored command text. The renderer translates it to
the harness argument syntax.

Harnesses with command injection combine a co-located command with its skill
and do not emit a second command file. Other harnesses emit a command file and
append a routing sentence. Set `user-invocable: false` in a skill's frontmatter
to suppress the generated router.
