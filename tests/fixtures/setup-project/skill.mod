skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

harness claude (
  token audience "Claude Code"
)

harness opencode (
  token audience "OpenCode"
)

harness pi (
  token audience "Pi"
)

setup overlap (
  pi

  claude (
    skills .pi/agent/skills
  )
)

setup personal (
  // Keep machine selection explicit.
  omit-skill hidden "Personal machines stay focused."
  pi claude
)

setup work-mac (
  root project
  pi

  claude (
    skills .claude2/skills
    commands .claude2/commands
  )
)

setup nested-overlap (
  pi (
    skills shared
  )

  claude (
    skills shared/nested
  )
)

setup root-wide (
  pi (
    skills .
  )
)

setup uppercase (
  only-skill Upper
  pi
)
