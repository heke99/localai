#!/usr/bin/env python3
"""Minimal dependency-free validation for LocalAI SKILL.md registry integrity."""

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "skills" / "registry.yaml"


def frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        raise ValueError("missing YAML frontmatter")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError("unterminated YAML frontmatter")
    return text[4:end]


def field(fm: str, key: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(key)}:\s*(.+?)\s*$", fm)
    return match.group(1).strip().strip('"\'') if match else None


def main() -> int:
    raw = REGISTRY.read_text(encoding="utf-8")
    paths = re.findall(r"path:\s*([^,}\n]+)", raw)
    declared_names = re.findall(r"name:\s*([^,}\n]+)", raw)
    errors: list[str] = []

    if len(paths) != len(set(paths)):
        errors.append("registry contains duplicate paths")
    if len(declared_names) != len(set(declared_names)):
        errors.append("registry contains duplicate names")

    discovered = []
    for rel in paths:
        rel = rel.strip()
        path = ROOT / rel
        if not path.is_file():
            errors.append(f"missing registered skill: {rel}")
            continue
        try:
            fm = frontmatter(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            errors.append(f"{rel}: {exc}")
            continue
        name = field(fm, "name")
        description = field(fm, "description")
        if not name:
            errors.append(f"{rel}: missing name")
        if not description or len(description) < 20:
            errors.append(f"{rel}: missing/weak description")
        discovered.append(name)

    if len(discovered) != len(set(discovered)):
        errors.append("SKILL.md frontmatter contains duplicate names")

    if errors:
        print("Skill validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Validated {len(paths)} registered LocalAI skills.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
