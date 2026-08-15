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
`diff --against REV` materializes only a revision already in the local Git object
database.

`skillful inspect -h`
