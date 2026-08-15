# render

Render a managed build tree. Only `install` writes live harness destinations.
`--dry-run` first.

Not `inspect` (that does not write). Not a substitute for editing sources.

```bash
skillful render --dry-run
skillful render --harness pi --out ./rendered
skillful install --harness pi --dry-run
```

`install` records ownership, refuses unmanaged or edited collisions, and removes
only unchanged stale files. Different destination roots stay independent. `--force`
is explicit and never permits escaping the destination root.

`skillful render -h` · `skillful install -h`
