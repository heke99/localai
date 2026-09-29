import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("rejects a stale shipped manifest without silently rewriting it, then accepts deliberate regeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "localai-manifest-drift-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(new URL("../../../scripts/build_skill_manifest.mjs", import.meta.url), join(root, "scripts/build_skill_manifest.mjs"));
    await cp(new URL("../../../skills", import.meta.url), join(root, "skills"), { recursive: true });
    const script = join(root, "scripts/build_skill_manifest.mjs");
    const manifest = join(root, "skills/runtime-manifest.json");
    const before = await readFile(manifest, "utf8");
    const count = (JSON.parse(before) as { skills: unknown[] }).skills.length;
    const beforeStat = await stat(manifest);
    expect(execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" })).toContain(`Verified ${count} skills`);
    expect((await stat(manifest)).mtimeMs).toBe(beforeStat.mtimeMs);
    const body = join(root, "skills/planning/reasoning-router/SKILL.md");
    await writeFile(body, `${await readFile(body, "utf8")}\nDeliberate fixture revision.\n`);
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).toThrow();
    expect(await readFile(manifest, "utf8")).toBe(before);
    execFileSync(process.execPath, [script]);
    expect(await readFile(manifest, "utf8")).not.toBe(before);
    expect(execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" })).toContain(`Verified ${count} skills`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
