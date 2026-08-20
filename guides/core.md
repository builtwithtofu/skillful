# core

Author skills, commands, and rules once. Skillful renders that one corpus for each
harness: `claude`, `pi`, `opencode`. Git is how you pull other people's skill
trees (`github:`, `git:`, `path:`).

Plain files are enough for a single harness. Use skillful when one tree must serve
several harnesses, or when you compose another tree with your own.

You pick the command and the targets. If a verb or topic is unknown, read
`skills tree` or `<command> -h` and retry. Do not invent commands. A verb that is
not in `-h` does not exist. Flags live on `skillful <command> -h`.

Only `add` and `update` resolve revisions. `add` also fetches. `fetch` retrieves
exact existing pins. Inspection, check, render, install, and historical diff never
resolve or contact the network. Only `install` writes live harness destinations.

```bash
skillful skills tree
skillful list skills
skillful list setups
skillful inspect <skill>
skillful render --dry-run
skillful install work-mac --dry-run
```

Unclear what a command is for → `skillful skills show <topic>` with a name from the tree.
