export const ROOT_AFTER_HELP = `
Skillful authors skills, commands, and rules once and renders them per harness
(claude, pi, opencode, opencode-v2). Git is the package manager for other
people's skill trees: github:, git:, and path: references.

Use skillful when one tree must serve several harnesses, or when you compose
another tree with your own. Plain files are enough for a single harness.

Only install writes live harness destinations. add and update resolve revisions;
fetch retrieves exact pins. check, inspect, render, and install never resolve.

Getting oriented
  skillful skills tree
  skillful skills show core
  skillful <command> --help

Common commands
  skillful init --dir DIR
  skillful add github:owner/repo@main --name alias --only skill
  skillful list skills
  skillful inspect <skill>
  skillful render --dry-run
  skillful install --harness pi --dry-run

Output defaults to text. Prefer --format json on source commands for automation.
Per-command details: skillful <command> --help. Longer guides: skillful skills show <topic>.
`;

export const INIT_AFTER_HELP = `
Idempotent: re-running in an existing scaffold reports that and changes nothing.

Examples:
  skillful init --dir ./agent

Afterward:
  skillful fmt --check
  skillful skills show author
`;

export const FMT_AFTER_HELP = `
Use --check in CI or before a review. Omit it to rewrite skill.mod in place.

Examples:
  skillful fmt --check
  skillful fmt --project DIR

Afterward:
  skillful check --strict
`;

export const ADD_AFTER_HELP = `
Use add to bring a new tree in, or to lock a require that already exists in
skill.mod. Adopting an existing require must repeat that alias and the exact
--only / --exclude set. Use update to move an existing pin. Use fetch to
re-fetch existing pins exactly.

Examples:
  skillful add github:owner/repo@main --name alias --only skill-name
  skillful add path:../shared --name shared

Afterward:
  skillful check --strict
  skillful render --dry-run
`;

export const FETCH_AFTER_HELP = `
Never changes skill.lock. Use update to move a pin. Use add to create one.

Examples:
  skillful fetch
`;

export const UPDATE_AFTER_HELP = `
Only re-resolves names already in skill.lock. It does not create a missing pin
and does not edit skill.mod. Use add to adopt a declared-but-unlocked require.

Examples:
  skillful update
  skillful update alias
`;

export const RENDER_AFTER_HELP = `
Writes a managed build tree only. Live harness destinations are install.

Examples:
  skillful render --dry-run
  skillful render --harness pi --out ./rendered

Afterward:
  skillful install --harness pi --dry-run
`;

export const INSTALL_AFTER_HELP = `
The only command that writes live harness destinations. Records ownership,
refuses unmanaged or edited collisions, and removes only unchanged stale files.

Examples:
  skillful install --harness pi --dry-run
  skillful install --harness pi --root DIR
`;

export const INSPECT_AFTER_HELP = `
Without --rendered this is the authored view. --rendered is per harness.

Examples:
  skillful inspect <skill>
  skillful inspect <skill> --rendered
`;

export const CHECK_AFTER_HELP = `
Read-only. --strict promotes warnings to failure.

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
