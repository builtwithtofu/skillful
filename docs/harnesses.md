# Harnesses

The engine has four identifiers: `claude`, `pi`, `opencode`, and `opencode-v2`.

`harnesses/*.json` owns fixed facts for each harness:

- installation paths for skills, commands, and optional rules;
- argument syntax;
- supported frontmatter keys; and
- whether a co-located command is injected into a skill or emitted as a file.

Project-specific roots, dependencies, tokens, and omissions live in `skill.mod`. Named host roots
and Nix package overrides are supplied to `lib.mkProject` without changing project content.

`project.forHarness name` returns:

```nix
{
 installPaths = { skills = "…"; commands = "…"; };
 skills = /* derivation */;
 commands = /* derivation */;
 rules = /* rendered rules file */;
}
```

Use named `extraRoots` entries such as `{ origin = "team"; src = ./skills; }`.
The origin is retained in the contract so callers can identify where a resource
came from.
