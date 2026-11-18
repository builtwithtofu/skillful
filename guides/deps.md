# deps

Pull other skill trees with Git. `add` declares, resolves, locks, and fetches one
tree. `update name` creates or moves that declaration's pin without requiring
unrelated pins; bare `update` reconciles every remote declaration atomically.
In skillful 2, bare `update` checks `use` selections before writing the lock.
`fetch` retrieves selected or all exact pins and never rewrites `skill.lock`.

Not `inspect` (that reads what you already have). Not `mod` (that declares the require).

```bash
skillful add agent-browser
skillful add github:owner/repo
skillful fetch agent-browser
skillful update agent-browser
```

New GitHub refs default to `@HEAD`, the repository's default branch. In skillful 1,
`add` infers a name from the repository or subdirectory without `--name`. Omit
`--only` / `--exclude` to include the whole tree. Explicit details must match an
existing declaration.

In skillful 2, a `use` declaration is identified by its exact ref, such as
`skillful update github:angular/skills@main`. `fetch` and `update` can reuse pins
from a skillful 1 lock with matching refs. A named update replaces the old pin
when it can match a changed ref unambiguously to the same source. To add a new
`use`, pass `--only` for each skill; `add` refuses a conflicting ref for an
existing source.
`skillful update` and `skillful add` record baselines for new `=` overrides from
the prior pin if there is one, so `skillful check` can report upstream drift.

`path:` dependencies are live source and stay out of `skill.lock`. Paths resolve
from `skill.mod`; a nested project may use a sibling within the same Git source
workspace, such as `path:../shared/skills`.
Inspection, check, render, and install never resolve or fetch. A missing cache
points to `skillful fetch`.

`skillful deps` is not a command. Flags: `skillful add -h`, `skillful update -h`.
