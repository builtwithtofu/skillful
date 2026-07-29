# CLI

Run `skillful --help` and `skillful <command> --help` for the Commander-generated reference.

The workflow is intentionally split:

1. `init` creates a project; `fmt` canonicalizes its declaration.
2. `add`/`update` resolve and fetch; a clean checkout uses `fetch` for exact pins.
3. `list`, `inspect`, `check`, `diff`, `manifest`, and `schema` evaluate the project without network.
4. `render` creates or updates a managed build tree.
5. `install --harness H` is the only command that writes live harness destinations.

Every source command discovers the nearest ancestor containing `skill.mod`; `--project DIR`
selects one explicitly. `--override name=path` satisfies a declared dependency without changing the
manifest or lock.

Text errors contain `Error:` and `Recovery:`. `--format json` keeps stdout as one schema-versioned
JSON document, including errors. Exit codes are 0 for success, 1 for project/runtime/check failure,
and 2 for usage.

Render and install dry-runs use their real planners. Managed files are hashed. Unmanaged collisions,
edited owned files, stale edited files, project/root identity mismatches, and symlink escapes fail
before destination changes; `--force` is explicit and never permits escaping the destination root.
