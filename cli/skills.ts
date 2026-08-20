import author from "../guides/author.md" with { type: "text" };
import core from "../guides/core.md" with { type: "text" };
import deps from "../guides/deps.md" with { type: "text" };
import inspect from "../guides/inspect.md" with { type: "text" };
import mod from "../guides/mod.md" with { type: "text" };
import render from "../guides/render.md" with { type: "text" };
import setup from "../guides/setup.md" with { type: "text" };

export class SkillGuideError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}

type Topic = {
  id: string;
  group: string;
  summary: string;
  markdown: string;
};

const TOPICS: readonly Topic[] = [
  { id: "core", group: "", summary: "Author once, render per harness. What skillful owns, the exact-name contract, and shared rules.", markdown: core },
  { id: "author", group: "Author", summary: "Write one SKILL.md with name+description frontmatter; body says how and when to use it.", markdown: author },
  { id: "mod", group: "Project", summary: "skill.mod is the canonical project declaration; fmt parses and rewrites it.", markdown: mod },
  { id: "deps", group: "Project", summary: "Pull other skill trees via Git: add resolves and fetches; fetch and update use exact pins.", markdown: deps },
  { id: "inspect", group: "Verify", summary: "Show one skill as authored or rendered per harness; check validates. Read-only.", markdown: inspect },
  { id: "render", group: "Ship", summary: "Render a managed build tree; only install writes harness destinations. --dry-run first.", markdown: render },
  { id: "setup", group: "Ship", summary: "Name machine-specific skill selection, harness outputs, roots, and path exceptions.", markdown: setup },
];

export function resolveSkillTopic(value: string) {
  const query = value.trim().toLowerCase();
  const exact = TOPICS.find((topic) => topic.id === query);
  if (exact) return exact;
  throw new SkillGuideError(`unknown guide topic ${JSON.stringify(value)}. Topics are exact names from the tree below.`, `Run \`skillful skills tree\` and retry with a listed name.\n\n${skillTree().trimEnd()}`);
}

export function skillTree() {
  type Node = { label: string; summary?: string | undefined; children: Array<{ name: string; summary: string }> };
  const top: Node[] = [];
  for (const topic of TOPICS) {
    if (!topic.group) {
      top.push({ label: topic.id, summary: topic.summary, children: [] });
      continue;
    }
    const last = top.at(-1);
    const group = last && last.label === topic.group ? last : { label: topic.group, children: [] };
    if (group !== last) top.push(group);
    group.children.push({ name: topic.id, summary: topic.summary });
  }

  const rows: Array<{ label: string; summary?: string | undefined }> = [{ label: "skillful guides" }];
  for (const [index, node] of top.entries()) {
    const lastTop = index === top.length - 1;
    const branch = lastTop ? "└── " : "├── ";
    rows.push({ label: `${branch}${node.label}`, summary: node.summary });
    const cont = lastTop ? "    " : "│   ";
    for (const [childIndex, child] of node.children.entries()) {
      const leaf = childIndex === node.children.length - 1 ? "└── " : "├── ";
      rows.push({ label: `${cont}${leaf}${child.name}`, summary: child.summary });
    }
  }

  const width = Math.max(0, ...rows.filter((row) => row.summary).map((row) => row.label.length));
  const lines = rows.map((row) => {
    if (!row.summary) return row.label;
    return `${row.label}${" ".repeat(width - row.label.length)}  ${row.summary}`;
  });
  return `${lines.join("\n")}\n\nLoad one guide with \`skillful skills show <topic>\`.\n`;
}

export function renderSkillTopic(topic: Topic) {
  const breadcrumb = topic.group ? `skillful guides › ${topic.group} › ${topic.id}` : `skillful guides › ${topic.id}`;
  const siblings = TOPICS.filter((candidate) => candidate.id !== topic.id && candidate.group === topic.group);
  const core = TOPICS.filter((candidate) => candidate.id === "core");
  const moves = topic.group ? [...siblings, ...core] : TOPICS.filter((candidate) => candidate.id !== topic.id);
  const width = Math.max(0, ...moves.map((candidate) => candidate.id.length));
  const next = moves.map((candidate) => `  ${candidate.id.padEnd(width)}  ${candidate.summary}`).join("\n");
  return `${breadcrumb}\n${topic.summary}\n\n${topic.markdown.trimEnd()}\n\nnext (\`skillful skills show <topic>\`):\n${next}\n`;
}
