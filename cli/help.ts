export const ROOT_AFTER_HELP = `
Skillful authors skills, commands, and rules once and renders them per harness
(claude, codex, cursor, grok, opencode, pi). Git is the package manager for other
people's skill trees: github:, git:, and path: references.

Use skillful when one tree must serve several harnesses, or when you compose
another tree with your own. Plain files are enough for a single harness.

A command is a saved prompt the person runs by name, separate from any skill:
a prompt or command file where the harness has them, otherwise a skill only the
person can invoke. See: skillful skills show author.

Only install writes live harness destinations. add and update resolve revisions;
fetch retrieves exact pins. check, inspect, render, and install never resolve.
skill.mod accepts skillful 1 and skillful 2; see: skillful skills show mod.

Getting oriented
  skillful skills tree
  skillful skills show core
  skillful <command> --help

Common commands
  skillful init --dir DIR
  skillful migrate --project DIR
  skillful add github:owner/repo
  skillful list skills
  skillful list setups
  skillful inspect <skill>
  skillful render --dry-run
  skillful install work-mac --dry-run

Output defaults to text. Prefer --format json on source commands for automation.
Per-command details: skillful <command> --help. Longer guides: skillful skills show <topic>.
`;

export const INIT_AFTER_HELP = `
Idempotent: re-running in an existing scaffold reports that and changes nothing.

Examples:
  skillful init --dir ./agent

  cd ./agent
  skillful render
  skillful install example --dry-run

Next:
  skillful skills show author
`;

export const FMT_AFTER_HELP = `
Use --check in CI or before a review. Omit it to rewrite skill.mod in place.
Both skillful 1 and skillful 2 keep their existing version.
See skillful skills show mod for skillful 2 front-matter and body overrides.

Examples:
  skillful fmt --check
  skillful fmt --project DIR

Afterward:
  skillful check --strict
`;

export const MIGRATE_AFTER_HELP = `
Use when moving an existing project to skillful 2; skillful 1 still works.
Migration stops if a setting cannot be translated without changing the render.
Migration lists skills from each source. If a pin is missing from the cache, run skillful fetch first.
Duplicate aliases at the same pin collapse to one; pins for unselected sources are removed.
If an omitted skill can't be found, declare its source or remove the omission if retired.
Setup install path overrides become harness paths inside the corresponding machine.
For agents that read .agents/skills, an override to that path uses shared placement instead.

Example:
  skillful migrate --project ./agent

Afterward, use skillful render to verify the delivered files.
`;

export const ADD_AFTER_HELP = `
Use add to bring in a new tree or lock a require already declared in skill.mod.
For an existing require, pass its name; skill.mod supplies the ref, alias, and
--only / --exclude choices. Explicit matching details are also accepted.

New GitHub refs default to @HEAD, the repository's default branch. Without --name, the repository or subdirectory
name is used. Omit selectors to include the whole tree.
For skillful 2, pass the use ref; a new use needs --only for each skill and
accepts neither --name nor --exclude. A conflicting ref for an existing source
is refused. Add records new = override baselines from the old pin if it exists.

Examples:
  skillful add agent-browser
  skillful add github:owner/repo
  skillful add github:owner/repo@tag --name alias --only skill-name
  skillful add path:../shared

Afterward:
  skillful check --strict
  skillful render --dry-run
`;

export const FETCH_AFTER_HELP = `
Never changes skill.lock. Named fetches are independent of unrelated project
readiness. Use update to create or move a pin.
For skillful 2, pass a use ref to fetch just its pin.

Examples:
  skillful fetch
  skillful fetch alias
`;

export const UPDATE_AFTER_HELP = `
Uses declarations in skill.mod and never edits them. A named update creates or
replaces that dependency's pin without requiring unrelated pins. With no names,
update resolves every remote dependency and checks skillful 2 use selections before
replacing the lock atomically.
For skillful 2, pass a use ref for one dependency. A changed ref replaces the old
pin when it is the only ref change for that source. Update records new override
baselines from the old pin when one exists.

Examples:
  skillful update
  skillful update alias
`;

export const RENDER_AFTER_HELP = `
By default, render uses the agents in skillful 2 or the declared harnesses in
skillful 1. Name a machine or setup to apply its skill selection. In skillful 2,
at least two shared-folder agents must get the same copy to use .agents/skills.
Claude Code uses .claude/skills. A --harness render can regroup other already-
rendered agents' skills and refresh their contracts without touching commands or
rules. Only install writes live harness destinations.

Examples:
  skillful render --dry-run
  skillful render work-mac
  skillful render --harness pi --out ./rendered

Afterward:
  skillful install work-mac --dry-run
`;

export const INSTALL_AFTER_HELP = `
The only command that writes live harness destinations. Records exclusive
ownership, refuses unmanaged or edited collisions, and removes only unchanged
stale files. Named setups select home or project paths from their declared root.
In skillful 2, missing default local sources are skipped unless explicitly declared.
Skillful 2 selects the machine matching your short hostname unless you name one.
Use only <skills> on <agents> "reason" in skill.mod to restrict who gets a skill.
Use a top-level harness block to set destinations or define an agent. A machine's
harness block overrides only the fields it sets. Claude Code rules go to
~/.claude/CLAUDE.md by default; Cursor has no default rules destination.
See skillful skills show mod for the manifest syntax.
Machine installs use .agents/skills only when at least two shared-folder agents
get the same copy. A lone reader, differing skills, and agents that don't read
the shared folder use separate folders. Use --root to relocate. Only skillful 1
supports one-off --harness installs and their --path overrides.
--remove retires a named setup from its receipt;
pass --root after deleting its declaration. Valid source overrides are ignored
during removal because destination ownership comes only from the receipt. Removal
rejects --force because changed owned files always block. An OpenCode install at
retired opencode-v2 paths adopts that receipt safely.

Examples:
  skillful install work-mac --dry-run
  skillful install old-work --remove --dry-run
  skillful install --harness pi --root DIR
  skillful install --harness opencode --path skills=.config/opencode-v2/skills --path commands=.config/opencode-v2/commands
`;

export const SETUP_AFTER_HELP = `
A skillful 2 machine uses the declared agents and can skip skills for that machine.
A skillful 1 setup can also select a root and override destination paths. Showing
one is read-only.

Examples:
  skillful list setups
  skillful setup show work-mac
  skillful render work-mac
  skillful install work-mac --dry-run
`;

export const INSPECT_AFTER_HELP = `
Without --rendered this is the authored view. --rendered is per harness.
Pass a built-in or top-level declared agent to --harness.

Examples:
  skillful inspect <skill>
  skillful inspect <skill> --rendered
`;

export const CHECK_AFTER_HELP = `
Read-only. --strict promotes warnings to failure.
In skillful 2, missing default local sources are skipped unless explicitly declared.
When an agent's skills path is set only on machines, check uses those machine configurations.
Warns when an upstream front-matter field or body replaced with = in skill.mod differs from
its baseline in skill.lock. Update alone keeps existing baselines. After reviewing and
accepting the upstream change, remove the override from skill.mod, run skillful update with no arguments,
then restore the override and run skillful update again. Verify with skillful check --strict.

Examples:
  skillful check
  skillful check --strict
`;

export const DIFF_AFTER_HELP = `
--against materializes only a revision already in the local Git object database.

Examples:
  skillful diff <skill>
  skillful diff <skill> --against HEAD
`;

export const SKILLS_AFTER_HELP = `
Topics are exact names from the tree. There is no synonym table.

Examples:
  skillful skills tree
  skillful skills show core
  skillful skills show author
`;
