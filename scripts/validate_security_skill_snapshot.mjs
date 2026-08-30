#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: validate_security_skill_snapshot.mjs <snapshot-root>");

const expectedRepo = "https://github.com/mukul975/Anthropic-Cybersecurity-Skills";
const expectedCommit = "1b3f6b2286981381a5cc0566551ef3bb6bc38383";
const metadata = JSON.parse(await readFile(resolve(root, "source.json"), "utf8"));
if (metadata.repository !== "mukul975/Anthropic-Cybersecurity-Skills") throw new Error("snapshot_repository_mismatch");
if (metadata.commit !== expectedCommit) throw new Error("snapshot_commit_mismatch");
if (metadata.execution_class !== "knowledge_only") throw new Error("snapshot_execution_class_mismatch");

const index = JSON.parse(await readFile(resolve(root, "index.json"), "utf8"));
if (index.repository !== expectedRepo) throw new Error("snapshot_index_repository_mismatch");
if (!Array.isArray(index.skills) || !Number.isInteger(index.total_skills) || index.total_skills !== index.skills.length) {
  throw new Error("snapshot_skill_count_mismatch");
}
if (index.skills.length < 1) throw new Error("snapshot_empty");

const names = new Set();
for (const raw of index.skills) {
  const name = String(raw?.name ?? "").trim();
  const path = String(raw?.path ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`snapshot_invalid_name:${name}`);
  if (names.has(name)) throw new Error(`snapshot_duplicate_name:${name}`);
  names.add(name);
  if (path !== `skills/${name}`) throw new Error(`snapshot_path_mismatch:${name}`);
  const skillPath = resolve(root, path, "SKILL.md");
  const rel = relative(root, skillPath);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("\\")) throw new Error(`snapshot_path_escape:${name}`);
  const stat = await lstat(skillPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`snapshot_skill_not_regular_file:${name}`);
  if (stat.size <= 0 || stat.size > 1_000_000) throw new Error(`snapshot_skill_size_invalid:${name}`);
}

console.log(JSON.stringify({ ok: true, commit: expectedCommit, skills: index.skills.length, version: index.version }));
