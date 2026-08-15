# skillful

You are working on the skillful CLI. The job is one authored corpus of
skills, commands, and rules; Git for other people's trees; one render per
harness. Only `install` writes live destinations.

The CLI is the product. Nix consumes the same lock and renderer so a project
is Nix-compatible from the first pin. It is not the product story. Do not put
Nix in `--help` or `guides/`.

User-facing orientation lives in `--help` and `guides/`. This file orients
agents in the repo. It is not a second README.

## CLI copy

When a command, invariant, or topic changes, update `--help` and
`skillful skills tree` / `skills show` in the same change. Those surfaces
are the docs. Do not add a parallel handbook.

`--help` orients: purpose, when to use this at all, what must not happen,
grouped commands, then `skills tree` and `<command> --help`. No Nix, no
marketing, no empty-array defaults, no synonym table.

`skills tree` lists exact topic names. `skills show <topic>` loads one
guide. A miss reprints the tree. Guides say what the topic is and is not,
the exact commands, and the next topic. Topic names are CLI names; do not
invent verbs or aliases.

Per-command after-help says when to use the verb, one or two examples, and
the next command. Skip after-help that only repeats the usage line.
