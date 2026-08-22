#!/usr/bin/env python3
"""Build the immutable runtime metadata index without loading skill bodies."""

from hashlib import sha256
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "skills" / "registry.yaml"
OUTPUT = ROOT / "skills" / "runtime-manifest.json"


def field(frontmatter: str, name: str) -> str:
    match = re.search(rf"(?m)^{re.escape(name)}:\s*(.+?)\s*$", frontmatter)
    return match.group(1).strip().strip('"\'') if match else ""


entries = []
for match in re.finditer(r"\{name:\s*([^,]+),\s*path:\s*([^,]+),\s*category:\s*([^}]+)\}", REGISTRY.read_text(encoding="utf-8")):
    name, relative_path, category = (part.strip() for part in match.groups())
    raw = (ROOT / relative_path).read_text(encoding="utf-8")
    frontmatter = raw.split("---", 2)[1]
    entries.append({
        "name": name,
        "path": relative_path,
        "category": category,
        "description": field(frontmatter, "description"),
        "version": re.search(r'version:\s*"([^"]+)"', frontmatter).group(1),
        "sha256": sha256(raw.encode()).hexdigest(),
    })

payload = {"schemaVersion": 1, "skills": entries}
OUTPUT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(f"Wrote {len(entries)} skills to {OUTPUT.relative_to(ROOT)}")
