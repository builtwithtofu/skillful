# Rendering

`cli/contract.ts` assembles one resolved plan per harness. Rendering, installation, and
introspection consume that plan rather than reimplementing selection.

## Markup

| Markup | Meaning |
| --- | --- |
| `{{token}}` | A value supplied by the project's configuration for this harness. |
| `{{#pi opencode}} … {{/}}` | Include the enclosed lines only for named harnesses. |
| `{{^claude}} … {{/}}` | Include the enclosed lines everywhere except named harnesses. |
| `$@` | The harness-specific argument token. |

Fences are line-oriented, cannot nest, and must close on their own line.
Unknown harness names, unresolved tokens, and unclosed fences fail evaluation.

Only `SKILL.md` and command bodies are rendered. Other files below a skill,
such as `references/` or `scripts/`, are copied verbatim.

## Project configuration

Harness capabilities live in `harnesses/*.json`; project choices belong in `skill.mod`:

```text
harness claude (
  token audience "Claude Code users"
  omit-skill requires-pi "This resource requires Pi."
)
```

Projects cannot override engine-owned install paths or frontmatter capabilities.

The renderer records source paths, delivery paths, transformations, omissions,
and hashes in schema-version 1 contract JSON.
