# Dependencies

Skillful supports flat, leaf-content dependencies:

- `github:owner/repo[/subdir]@version`
- `git:<url>@version[#subdir]`
- `path:relative/directory`

`add` declares a dependency, resolves a remote ref, writes `skill.lock`, and fetches the verified
tree as one transaction. `update` is the other resolver. `fetch` only retrieves exact existing pins;
it never changes `skill.lock`.

Each lock line is `name ref rev narHash`, sorted by name. `narHash` is the SRI SHA-256 of the whole
repository NAR at `rev`; a subdirectory changes selection, not the hash root. Cache entries use a
filesystem-safe base64url encoding under `${XDG_CACHE_HOME:-~/.cache}/skillful/` and are rehashed on
every read.

Rendering, installation, checks, and inspection never resolve or fetch. A missing cache points to
`skillful fetch`; a stale declaration points to `skillful update <name>`. Merge markers, malformed
fields, duplicates, unsorted entries, wrong hashes, and manifest/lock mismatches fail without
rewriting either file.

Nix reads `skill.lock`, verifies the same pins with `builtins.fetchTree`, and passes store paths to
the network-free Bun renderer. Explicit `dependencyOverrides` take precedence for locally packaged
content.
