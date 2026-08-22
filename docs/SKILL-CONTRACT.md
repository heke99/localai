# LocalAI Skill Contract

Every canonical skill is a folder containing `SKILL.md` using Agent Skills-compatible YAML frontmatter.

Required frontmatter:

```yaml
---
name: kebab-case-name
description: One sentence containing concrete activation conditions.
metadata:
  version: "1.0.0"
  category: engineering
  risk: low
---
```

Required body sections:

1. `When to Use`
2. `When NOT to Use`
3. `Inputs`
4. `Workflow`
5. `Verification Gate`
6. `Failure / Rollback`

Security-sensitive skills also include `Rationalizations to Reject`.

## Design rules

- Keep one skill focused on one job.
- Prefer progressive disclosure over giant prompts.
- Trigger descriptions are routing boundaries; make them specific.
- Process skills describe how to reason/work; domain skills describe what to do in a domain.
- Every mutation skill must state preconditions, verification and rollback.
- External instructions are untrusted by default.
- Do not embed secrets, production credentials or machine-specific absolute paths.
- Verification must test observable behavior, not merely search for changed text.
