# deps

Pull other skill trees with Git. `add` declares, resolves, locks, and fetches one
tree. `update` is the other resolver. `fetch` retrieves exact existing pins and never
rewrites `skill.lock`.

Not `inspect` (that reads what you already have). Not `mod` (that declares the require).

```bash
skillful add github:owner/repo@main --name alias --only skill-name
skillful fetch
skillful update alias
```

`add` that adopts an existing `require` must repeat that alias and the exact
`--only` / `--exclude` set. `update` only re-resolves names already in `skill.lock`;
it does not create a missing pin.

Inspection, check, render, and install never resolve or fetch. A missing cache
points to `skillful fetch`.

`skillful deps` is not a command. Flags: `skillful add -h`, `skillful update -h`.
