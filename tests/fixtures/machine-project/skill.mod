// Machine selection fixture.
skillful 2

use github:angular/skills@main{angular-developer}

machine travel skip "desk-only"
machine desk

agents pi claude pi
skip angular-developer on claude "Only Pi needs Angular here."
