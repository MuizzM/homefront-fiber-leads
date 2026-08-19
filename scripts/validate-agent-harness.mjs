import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const required = ["AGENTS.md", ".agent/PLANS.md", ".codex/config.toml"];
const failures = [];

for (const path of required) {
  if (!existsSync(path)) failures.push(`missing ${path}`);
}

const agentDir = ".codex/agents";
const agentFiles = existsSync(agentDir)
  ? readdirSync(agentDir).filter(name => name.endsWith(".toml"))
  : [];
if (agentFiles.length < 3) failures.push("expected at least three project custom agents");
for (const name of agentFiles) {
  const source = readFileSync(join(agentDir, name), "utf8");
  for (const key of ["name", "description", "developer_instructions"]) {
    if (!new RegExp(`^${key}\\s*=`, "m").test(source)) failures.push(`${name} is missing ${key}`);
  }
}

const skillsDir = ".agents/skills";
const skills = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
  : [];
if (skills.length === 0) failures.push("no repository skills found");

const seenNames = new Set();
for (const entry of skills) {
  const manifest = join(skillsDir, entry.name, "SKILL.md");
  if (!existsSync(manifest)) {
    failures.push(`${entry.name} is missing SKILL.md`);
    continue;
  }
  const source = readFileSync(manifest, "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) {
    failures.push(`${entry.name}/SKILL.md has invalid frontmatter`);
    continue;
  }
  const keys = [...frontmatter[1].matchAll(/^([a-z_]+):/gm)].map(match => match[1]);
  if (keys.join(",") !== "name,description") failures.push(`${entry.name}/SKILL.md must contain only name and description frontmatter`);
  const skillName = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!skillName || !/^[a-z0-9-]{1,64}$/.test(skillName)) failures.push(`${entry.name} has an invalid skill name`);
  if (skillName && seenNames.has(skillName)) failures.push(`duplicate skill name ${skillName}`);
  if (skillName) seenNames.add(skillName);
  if (!description || description.length < 40) failures.push(`${entry.name} needs a specific trigger description`);
  if (/\bTODO\b/.test(source)) failures.push(`${entry.name}/SKILL.md contains TODO`);
}

if (failures.length) {
  console.error("Agent harness validation failed:\n- " + failures.join("\n- "));
  process.exit(1);
}

console.log(`Agent harness valid: ${agentFiles.length} custom agents, ${skills.length} skills.`);
