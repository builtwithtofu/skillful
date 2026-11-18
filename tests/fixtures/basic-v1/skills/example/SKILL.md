---
name: example
description: A minimal skillful fixture skill.
---

# Example

This resource is rendered for {{audience}}.

{{#claude}}
Claude keeps this line.
{{/}}
{{^claude}}
Other harnesses keep this line.
{{/}}

{{#codex}}
Codex keeps this line.
{{/}}

{{#cursor}}
Cursor keeps this line.
{{/}}

{{#grok}}
Grok keeps this line.
{{/}}

Arguments: $@
