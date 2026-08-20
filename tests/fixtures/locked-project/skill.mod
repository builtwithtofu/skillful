skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

require github:angular/skills@main as angular (
  only angular-developer
)

harness pi (
)
