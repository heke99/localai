# Upstream skill influences

LocalAI skills in this repository are original implementations informed by public skill ecosystems. We do not blindly vendor or auto-execute third-party skill text.

## Reviewed foundations

- `agentskills/agentskills` — open Agent Skills format/specification. Apache-2.0 code / CC-BY documentation as declared upstream.
- `obra/superpowers` — MIT; strong patterns for brainstorming, detailed plans, TDD, systematic debugging, review and verification.
- `supabase/agent-skills` — official Supabase agent skills; patterns for Postgres performance, RLS, schema and platform work.
- `vercel-labs/agent-skills` — MIT; official Vercel patterns for React/Next.js performance and deployment/optimization workflows.
- `trailofbits/skills` — CC-BY-SA-4.0; security-audit patterns including context building, differential review, static analysis, insecure defaults and agentic CI risks.

## Rule

Upstream material is an input to design, not automatically trusted runtime instruction. Before importing any external skill:

1. pin repository + commit;
2. inspect license;
3. review `SKILL.md`, scripts and references;
4. scan for prompt/tool injection and unexpected network/file behavior;
5. run behavior evals in an isolated harness;
6. explicitly approve it in `skills/upstream.lock.yaml`.
