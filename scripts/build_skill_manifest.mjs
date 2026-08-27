#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(root, "skills/registry.yaml");
const routingMetadataPath = resolve(root, "skills/routing-metadata.json");
const outputPath = resolve(root, "skills/runtime-manifest.json");

function frontmatterField(frontmatter, name) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
}

function versionField(frontmatter) {
  return frontmatter.match(/version:\s*"([^"]+)"/)?.[1] || "";
}

const registry = await readFile(registryPath, "utf8");
const routingMetadata = JSON.parse(await readFile(routingMetadataPath, "utf8"));
const routingDefaults = routingMetadata.defaults ?? {};
const skillRouting = routingMetadata.skills ?? {};
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
  const routing = { ...routingDefaults, ...(skillRouting[name] ?? {}) };
  if (routingDefaults.cost || skillRouting[name]?.cost) routing.cost = { ...(routingDefaults.cost ?? {}), ...(skillRouting[name]?.cost ?? {}) };
  skills.push({
    category,
    description,
    name,
    path,
    sha256: createHash("sha256").update(raw).digest("hex"),
    version,
    ...routing
  });
}

if (!skills.length) throw new Error("skill_registry_empty");
if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new Error("duplicate_skill_name");
const unknownRoutingSkills = Object.keys(skillRouting).filter((name) => !skills.some((skill) => skill.name === name));
if (unknownRoutingSkills.length) throw new Error(`unknown_skill_routing_metadata:${unknownRoutingSkills.join(",")}`);

const payload = { schemaVersion: 1, skills };
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.info(`Wrote ${skills.length} skills to skills/runtime-manifest.json`);
