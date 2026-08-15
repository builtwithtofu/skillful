# deps

Pull other skill trees with Git. `add` declares, resolves, locks, and fetches one
tree. `update name` creates or moves that declaration's pin without requiring
unrelated pins; bare `update` reconciles every remote declaration atomically.
`fetch` retrieves selected or all exact pins and never rewrites `skill.lock`.

Not `inspect` (that reads what you already have). Not `mod` (that declares the require).

```bash
skillful add agent-browser
skillful add github:owner/repo
skillful fetch agent-browser
skillful update agent-browser
```

New GitHub refs default to `@HEAD`, the repository's default branch. Without `--name`, the repository or
subdirectory name is used. Omit `--only` / `--exclude` to include the whole tree.
Explicit details are accepted when they match an existing declaration.

`path:` dependencies are live source and stay out of `skill.lock`. Paths resolve
from `skill.mod`; a nested project may use a sibling within the same Git source
workspace, such as `path:../shared/skills`.
Inspection, check, render, and install never resolve or fetch. A missing cache
points to `skillful fetch`.

`skillful deps` is not a command. Flags: `skillful add -h`, `skillful update -h`.
