# setup

A setup names the skill selection, harness outputs, root kind, and path exceptions
for one machine. Skillful never chooses a setup from the hostname.

```text
setup personal (
  omit-skill company-database "Work only."
  pi claude
)

setup work-mac (
  pi

  claude (
    skills .claude2/skills
    commands .claude2/commands
  )
)
```

Omit `root` to install under home. Use `root project` for project-local output;
`--root DIR` overrides either when applying. Bare harness names use their
conventional paths. A harness block contains only path exceptions.

Use repeated `only-skill <name>` or repeated `omit-skill <name> <reason>`, never
both. Selection names are exact. Omitting a skill also removes its support files
and generated or co-located command from every output in the setup.

```bash
skillful list setups
skillful setup show work-mac
skillful render work-mac
skillful install work-mac --dry-run
skillful install work-mac
skillful install old-work --remove --dry-run
skillful install old-work --remove
```

`render` is a managed build tree. Only `install` writes live destinations. Use
`install --harness` for a one-off harness instead of a declared machine setup.
Use `install <name> --remove` to retire an instance from its ownership receipt.
After deleting its declaration, pass the exact original `--root`. Removal rejects
`--force` and deletes only unchanged owned files.

`skillful skills show mod` · `skillful skills show render`
