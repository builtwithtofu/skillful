// Machine selection fixture.
skillful 2

use github:angular/skills@main{angular-developer}

machine travel skip "desk-only"
machine desk {
  harness pi { rules .pi/agent/DESK.md }
  harness local-agent { skills .local/skills commands .local/commands }
}

agents pi claude pi local-agent
harness local-agent { skills .local/skills }
harness pi { rules .pi/agent/GENERAL.md }
skip angular-developer on claude "Only Pi needs Angular here."
