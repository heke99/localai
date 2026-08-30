# Upstream skill influences

LocalAI skills in this repository are original implementations informed by public skill ecosystems. We do not blindly vendor or auto-execute third-party skill text.

## Reviewed foundations

- `agentskills/agentskills` — open Agent Skills format/specification. Apache-2.0 code / CC-BY documentation as declared upstream.
- `obra/superpowers` — MIT; strong patterns for brainstorming, detailed plans, TDD, systematic debugging, review and verification.
- `supabase/agent-skills` — official Supabase agent skills; patterns for Postgres performance, RLS, schema and platform work.
- `vercel-labs/agent-skills` — MIT; official Vercel patterns for React/Next.js performance and deployment/optimization workflows.
- `trailofbits/skills` — CC-BY-SA-4.0; security-audit patterns including context building, differential review, static analysis, insecure defaults and agentic CI risks.
- `mukul975/Anthropic-Cybersecurity-Skills` — Apache-2.0; commit-pinned cybersecurity knowledge/playbook source. LocalAI treats imported material from this source as `knowledge_only`; it cannot grant itself network, mutation, destructive, shell or other execution capability.

## Rule

Upstream material is an input to design, not automatically trusted runtime instruction. Before importing any external skill:

1. pin repository + commit;
2. inspect license;
3. review `SKILL.md`, scripts and references;
4. scan for prompt/tool injection and unexpected network/file behavior;
5. run behavior evals in an isolated harness;
6. explicitly approve it in `skills/upstream.lock.yaml`.

Execution authorization is always resolved independently from skill text. A third-party skill may improve reasoning and procedure selection, but it never expands the current run's tool permissions or target scope.
