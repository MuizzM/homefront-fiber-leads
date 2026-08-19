#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPECTED_AGENTS = {
    "code-mapper.toml": "code_mapper",
    "security-reviewer.toml": "security_reviewer",
    "test-reviewer.toml": "test_reviewer",
    "product-guard.toml": "product_guard",
}
EXPECTED_SKILLS = {
    "homefront-verify-change",
    "homefront-review-pr",
    "homefront-scanner-safety",
    "homefront-database-change",
    "impeccable",
    "ui-skills-root",
}
SKILL_FRONTMATTER_FIELDS = {
    "impeccable": ["name", "description", "version"],
}
failures: list[str] = []


def read_required(path: str) -> str:
    target = ROOT / path
    if not target.is_file():
        failures.append(f"missing {path}")
        return ""
    source = target.read_text(encoding="utf-8")
    if not source.strip():
        failures.append(f"{path} is empty")
    return source


agents_md = read_required("AGENTS.md")
plans_md = read_required(".agent/PLANS.md")
config_source = read_required(".codex/config.toml")

try:
    config = tomllib.loads(config_source)
    agent_config = config.get("agents", {})
    if agent_config.get("enabled") is not True:
        failures.append(".codex/config.toml must enable agents")
    if agent_config.get("max_concurrent_threads_per_session") != 4:
        failures.append(".codex/config.toml must cap subagents at four")
except tomllib.TOMLDecodeError as error:
    failures.append(f".codex/config.toml is invalid TOML: {error}")

loaded_agent_names: set[str] = set()
agent_dir = ROOT / ".codex/agents"
actual_agent_files = {path.name for path in agent_dir.glob("*.toml")} if agent_dir.is_dir() else set()
if actual_agent_files != set(EXPECTED_AGENTS):
    failures.append(
        "custom agent files differ from the required set: "
        + ", ".join(sorted(set(EXPECTED_AGENTS) ^ actual_agent_files))
    )

for filename, expected_name in EXPECTED_AGENTS.items():
    source = read_required(f".codex/agents/{filename}")
    if not source:
        continue
    try:
        parsed = tomllib.loads(source)
    except tomllib.TOMLDecodeError as error:
        failures.append(f"{filename} is invalid TOML: {error}")
        continue
    for key in ("name", "description", "developer_instructions"):
        if not isinstance(parsed.get(key), str) or not parsed[key].strip():
            failures.append(f"{filename} is missing non-empty {key}")
    if parsed.get("name") != expected_name:
        failures.append(f"{filename} must define name {expected_name}")
    if parsed.get("name") in loaded_agent_names:
        failures.append(f"duplicate custom agent name {parsed.get('name')}")
    loaded_agent_names.add(parsed.get("name", ""))
    if parsed.get("sandbox_mode") != "read-only":
        failures.append(f"{filename} must remain read-only")
    if expected_name not in agents_md:
        failures.append(f"AGENTS.md does not reference {expected_name}")

skills_dir = ROOT / ".agents/skills"
actual_skills = {path.name for path in skills_dir.iterdir() if path.is_dir()} if skills_dir.is_dir() else set()
if actual_skills != EXPECTED_SKILLS:
    failures.append(
        "repository skills differ from the required set: "
        + ", ".join(sorted(EXPECTED_SKILLS ^ actual_skills))
    )

for skill_name in EXPECTED_SKILLS:
    source = read_required(f".agents/skills/{skill_name}/SKILL.md")
    match = re.match(r"^---\n([\s\S]*?)\n---\n", source)
    if not match:
        failures.append(f"{skill_name}/SKILL.md has invalid frontmatter")
        continue
    fields = re.findall(r"^([a-z_]+):\s*(.*)$", match.group(1), re.MULTILINE)
    expected_fields = SKILL_FRONTMATTER_FIELDS.get(skill_name, ["name", "description"])
    if [key for key, _ in fields] != expected_fields:
        failures.append(
            f"{skill_name}/SKILL.md frontmatter must contain "
            + ", ".join(expected_fields)
            + " in that order"
        )
        continue
    values = dict(fields)
    if values["name"] != skill_name:
        failures.append(f"{skill_name}/SKILL.md name must match its directory")
    if len(values["description"].strip()) < 40:
        failures.append(f"{skill_name}/SKILL.md needs a specific trigger description")
    if "version" in expected_fields and not re.fullmatch(r"\d+\.\d+\.\d+", values.get("version", "")):
        failures.append(f"{skill_name}/SKILL.md version must be semantic x.y.z")
    if "TODO" in source:
        failures.append(f"{skill_name}/SKILL.md contains TODO")
    if f"${skill_name}" not in agents_md:
        failures.append(f"AGENTS.md does not reference ${skill_name}")

    interface = read_required(f".agents/skills/{skill_name}/agents/openai.yaml")
    required_yaml = {
        "interface:",
        "  display_name:",
        "  short_description:",
        "  default_prompt:",
        "policy:",
        "  allow_implicit_invocation: true",
    }
    for prefix in required_yaml:
        if not any(line.startswith(prefix) for line in interface.splitlines()):
            failures.append(f"{skill_name}/agents/openai.yaml is missing {prefix.strip()}")
    prompt_line = next((line for line in interface.splitlines() if line.startswith("  default_prompt:")), "")
    if f"${skill_name}" not in prompt_line:
        failures.append(f"{skill_name}/agents/openai.yaml default_prompt must mention ${skill_name}")

if "Required sections" not in plans_md or "Progress" not in plans_md or "Recovery" not in plans_md:
    failures.append(".agent/PLANS.md is missing required living-plan guidance")

if failures:
    print("Agent harness validation failed:\n- " + "\n- ".join(failures), file=sys.stderr)
    raise SystemExit(1)

print(f"Agent harness valid: {len(EXPECTED_AGENTS)} custom agents, {len(EXPECTED_SKILLS)} skills.")
