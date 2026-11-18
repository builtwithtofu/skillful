# inspect

Read-only evidence: list what the project delivers, explain one skill, validate,
or diff. Never writes, never resolves, never fetches.

Not `render` (that writes a build tree).

```bash
skillful list skills
skillful inspect <skill>
skillful inspect <skill> --rendered
skillful check --strict
skillful diff <skill>
```

`inspect` without `--rendered` is the authored view. `--rendered` is per harness.

If `check` reports drift for an `=` override, review the upstream change before
accepting it. `skillful update` alone keeps the existing baseline. Temporarily
remove the affected override from `skill.mod` and run `skillful update` with no
arguments to drop its baseline. Restore the override and run `skillful update`
again to record a new baseline, then verify with `skillful check --strict`.
`diff --against REV` materializes only a revision already in the local Git object
database.

`skillful inspect -h`
