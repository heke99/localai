#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(root, "skills/registry.yaml");
const outputPath = resolve(root, "skills/runtime-manifest.json");

function frontmatterField(frontmatter, name) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}

function versionField(frontmatter) {
  return frontmatter.match(/version:\s*"([^"]+)"/)?.[1] || "";
}

const registry = await readFile(registryPath, "utf8");
const entryPattern = /\{name:\s*([^,]+),\s*path:\s*([^,]+),\s*category:\s*([^}]+)\}/g;
const skills = [];

for (const match of registry.matchAll(entryPattern)) {
  const [, rawName, rawPath, rawCategory] = match;
  const name = rawName.trim();
  const path = rawPath.trim();
  const category = rawCategory.trim();
  const raw = await readFile(resolve(root, path), "utf8");
  const segments = raw.split("---");
  if (segments.length < 3) throw new Error(`invalid_skill_frontmatter:${path}`);
  const frontmatter = segments[1];
  const description = frontmatterField(frontmatter, "description");
  const version = versionField(frontmatter);
  if (!description || !version) throw new Error(`invalid_skill_metadata:${path}`);
  skills.push({
    category,
    description,
    name,
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
    version
  });
}

if (!skills.length) throw new Error("skill_registry_empty");
if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new Error("duplicate_skill_name");

const payload = { schemaVersion: 1, skills };
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.info(`Wrote ${skills.length} skills to skills/runtime-manifest.json`);
