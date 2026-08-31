#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const rootArg = process.argv[2];
if (!rootArg) throw new Error("usage: build_security_skill_integrity.mjs <snapshot-root>");
const root = resolve(rootArg);
const source = JSON.parse(await readFile(resolve(root, "source.json"), "utf8"));
const index = JSON.parse(await readFile(resolve(root, "index.json"), "utf8"));
if (!Array.isArray(index.skills)) throw new Error("security_skill_integrity_index_skills_required");
if (typeof source.repository !== "string" || typeof source.commit !== "string") throw new Error("security_skill_integrity_source_required");

const files = [];
for (const raw of index.skills) {
  const name = String(raw?.name ?? "").trim();
  const path = String(raw?.path ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name) || path !== `skills/${name}`) throw new Error(`security_skill_integrity_invalid_entry:${name}`);
  const relativePath = `${path}/SKILL.md`;
  const absolutePath = resolve(root, relativePath);
  const rel = relative(root, absolutePath);
  if (!rel || rel.startsWith("..") || rel.startsWith("/") || rel.includes("\\")) throw new Error(`security_skill_integrity_path_escape:${name}`);
  const stat = await lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`security_skill_integrity_not_regular_file:${name}`);
  const body = await readFile(absolutePath);
  files.push({ path: relativePath, sha256: createHash("sha256").update(body).digest("hex") });
}

files.sort((a, b) => a.path.localeCompare(b.path));
const snapshotSha256 = createHash("sha256")
  .update(files.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n"))
  .digest("hex");
const integrity = {
  schemaVersion: 1,
  algorithm: "sha256",
  repository: source.repository,
  commit: source.commit,
  files,
  snapshotSha256
};
await writeFile(resolve(root, "integrity.json"), `${JSON.stringify(integrity, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
console.log(JSON.stringify({ ok: true, files: files.length, snapshotSha256 }));
