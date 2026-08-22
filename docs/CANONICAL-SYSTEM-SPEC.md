# DIV3RSA AI SYSTEM — CANONICAL MASTER PROMPT V2

## 0. UPPDRAG

Du arbetar med att bygga **DIV3RSA AI System**.

Primär produktdomän:

`system.div3rsa.com`

Detta ska vara en privat AI-agentplattform för avancerat tekniskt arbete, software engineering, research och auktoriserade cybersecurity/Lab-workflows.

Systemet ska inte vara en tunn wrapper runt en språkmodell.

Systemet ska byggas som:

**DIV3RSA Intelligence**

\=

- Foundation Model
- Agent Runtime
- Orchestrator
- Skills
- Memory
- Knowledge
- Research
- Tools
- Integrations
- Sandboxes
- Verification
- Learning
- Datasets
- Training
- Evaluations
- Model Registry
- GPU Scheduler
- Audit
- Observability

Foundation-modellen är en utbytbar compute-komponent.

---

# 1. LÅST FOUNDATION MODEL V1

Canonical V1 foundation model:

**OBLITERATUS/Qwen3.8-27B-OBLITERATED V2**

Den används initialt för:

- generell chat
- reasoning
- komplex problemlösning
- systemarkitektur
- planering
- coding
- debugging
- repository understanding
- tool use
- agentic coding
- research synthesis
- dokumentförståelse
- Code
- Lab
- security analysis
- verifiering
- långvariga agentuppgifter

Exakt upstream revision ska pinnas.

Production får aldrig automatiskt använda `latest`.

Lagra minst:

- repository
- exact revision
- weights SHA-256
- tokenizer hash
- chat-template hash
- runtime version
- quantization
- CUDA version
- container digest

---

# 2. DIV3RSA FÅR INTE BLI BEROENDE AV QWEN

Ingen applikationsservice får innehålla permanent logik av typen:

`if model == qwen`

Istället används capabilities:

- `general`
- `reasoning`
- `coding`
- `security`
- `research`
- `long_context`
- `tool_use`
- `verification`

Canonical regel:

> No application service may depend directly on a specific foundation model.

Alla modellcalls går genom:

**Model Gateway + Model Adapter**

---

# 3. MODEL ALIASES

Använd logical aliases:

- `general-prod`
- `code-prod`
- `lab-prod`
- `reasoner-prod`
- `research-prod`
- `verifier-prod`

I V1 kan samtliga peka på Qwen3.8-27B-OBLITERATED V2.

Senare kan:

`code-prod`

peka på en annan modell än:

`reasoner-prod`

utan ändring i frontend, projects, memory, tools eller databasen.

---

# 4. MODEL ADAPTER CONTRACT

Skapa exempelvis:

`ModelAdapter`

med:

- `generate()`
- `stream()`
- `toolCall()`
- `estimateTokens()`
- `getCapabilities()`
- `healthCheck()`

Implementationer kan vara:

- `QwenAdapter`
- `VllmAdapter`
- `LlamaCppAdapter`
- `SglangAdapter`
- `ExternalProviderAdapter`

Resten av systemet kommunicerar endast genom kontraktet.

---

# 5. ÖVERGRIPANDE ARKITEKTUR

```text
USER
 │
 ▼
system.div3rsa.com
 │
 ▼
NEXT.JS UI
 │
 ▼
APPLICATION API
 │
 ▼
AUTH / RBAC / TENANT
 │
 ▼
AI CONTROL PLANE
 │
 ├── ORCHESTRATOR
 ├── CONTEXT ENGINE
 ├── SKILL ENGINE
 └── POLICY ENGINE
 │
 ▼
AGENT ROUTER
 │
 ├── CHAT
 ├── CODE
 ├── LAB
 └── RESEARCH
 │
 ▼
MODEL GATEWAY
 │
 ▼
MODEL REGISTRY
 │
 ▼
QWEN3.8-27B-OBLITERATED V2
 │
 ▼
GPU SCHEDULER
 │
 ├── GPU 1
 ├── GPU 2
 └── GPU N
 │
 ├───────────────┐
 ▼               ▼
TOOL GATEWAY   MEMORY / KNOWLEDGE
 │
 ▼
CREDENTIAL BROKER
 │
 ▼
SANDBOX
 │
 ▼
VERIFIER
 │
 ▼
RESULT
 │
 ▼
LEARNING PIPELINE
 │
 ├── Knowledge
 ├── Skills
 ├── Experiences
 └── Dataset candidates
       │
       ▼
    TRAINING
       │
       ▼
      EVAL
       │
       ▼
     CANARY
       │
       ▼
   PRODUCTION

```

---

# 6. PRODUKTSEPARATION

Behåll:

`div3rsa.com`

som separat företagssida.

Bygg:

`system.div3rsa.com`

som separat produkt.

Separera:

- GitHub repository
- Vercel project
- Supabase
- environment variables
- secrets
- CI/CD
- deployments
- monitoring

Ett fel i AI-systemet får inte påverka vanliga `div3rsa.com`.

---

# 7. PUBLIC PRODUCT

`system.div3rsa.com/`

ska ha Hero och produktpresentation.

Inte direkt login.

Exempel:

**DIV3RSA**

Private AI for advanced technical work.

`[ Request Access ] [ Sign In ]`

Presentera:

- Chat
- Code
- Lab
- Agents
- Research
- Private Infrastructure
- Projects
- Model Independence

---

# 8. INGEN ÖPPEN SIGNUP

Använd:

**Request Access**

Flow:

```text
Visitor
↓
Application
↓
Email validation
↓
Superadmin review
├── Approve
├── Reject
└── Waitlist
↓
Invitation
↓
Account
↓
MFA
↓
Onboarding

```

Superadmin kan även skapa användare manuellt.

---

# 9. USER DASHBOARD SKA VARA ENKEL

Vanlig user ska inte exponeras för:

- GPU topology
- training runs
- adapters
- eval internals
- model artifacts
- autoscaling
- infrastructure settings

Navigation:

```text
DIV3RSA

+ New

Chat
Code
Lab
Projects
Runs

────────────

Integrations
Settings

```

---

# 10. CHAT MODE

För:

- frågor
- reasoning
- research
- dokument
- analys
- strategi
- struktur
- planering
- problemlösning

Chat ska kunna använda web research och dokument utan att starta full coding sandbox om den inte behövs.

---

# 11. CODE MODE

För:

- repositories
- coding
- debugging
- implementation
- refactoring
- architecture
- Git
- GitHub
- Supabase
- Vercel
- terminal
- tests
- build
- lint
- typecheck

---

# 12. LAB MODE

För:

- cybersecurity
- secure code review
- vulnerability validation
- security research
- auktoriserad pentesting
- isolerade Lab-miljöer
- security tooling
- evidence
- remediation validation

Lab är en agent/tool-profile.

Inte en separat AI-produkt.

---

# 13. FRAMTIDA MODES

Arkitekturen ska stödja exempelvis:

- Data
- DevOps
- Architecture
- Image
- Video
- Audio

utan fundamental omskrivning.

---

# 14. SKILLS ÄR EN FIRST-CLASS CORE COMPONENT

Skills ska vara en **central del av DIV3RSA Brain**.

Systemet får inte förlita sig på att Qwen själv kommer ihåg den optimala arbetsmetoden för varje typ av uppgift.

Skills ska ge agenten:

- strukturerade arbetsflöden
- beprövade metodiker
- tools
- verifieringskrav
- failure handling
- återanvändbara procedures
- domain knowledge
- quality gates

Canonical architecture:

```text
Task
↓
Intent Router
↓
Skill Discovery
↓
Skill Selection
↓
Skill Context Loading
↓
Agent Execution
↓
Skill Verification
↓
Result

```

---

# 15. ANVÄND ÖPPET AGENT SKILLS-FORMAT

Bygg DIV3RSA Skills så nära det öppna Agent Skills-formatet som praktiskt möjligt.

Varje skill får en katalog:

```text
skills/
  skill-name/
    SKILL.md
    scripts/
    references/
    assets/
    tests/
    evals/

```

`SKILL.md` innehåller minst:

```yaml
name:
description:
version:

```

DIV3RSA ska dessutom lägga till egen metadata.

---

# 16. PROGRESSIVE DISCLOSURE FÖR SKILLS

Ladda inte alla skills fullständigt i varje prompt.

Gör:

### Discovery

Modellen ser exempelvis:

- skill name
- description
- domain
- trigger

### Activation

När skillen behövs laddas:

`SKILL.md`

### Execution

Endast om nödvändigt laddas:

- references
- scripts
- templates
- assets

Det ger hundratals möjliga skills utan enorm contextkostnad.

---

# 17. OPEN-SOURCE SKILL SOURCES

Vi ska aktivt kunna importera och vidareutveckla högkvalitativa open-source skills.

Primära inspirations-/importkällor bör från början omfatta exempelvis:

### obra/superpowers

Relevant metodik:

- brainstorming
- writing plans
- executing plans
- test-driven development
- systematic debugging
- verification before completion
- requesting code review
- receiving code review
- subagent-driven development
- dispatching parallel agents
- using Git worktrees
- finishing development branches
- writing/testing skills

### Agent Skills open format

Använd dess struktur för portabla skills.

### Playwright / Playwright MCP

Använd som verktygsgrund för:

- browser control
- E2E
- cross-browser testing
- forms
- authenticated flows
- network validation
- screenshots
- traces
- visual/browser verification

Open-source ska dock aldrig importeras blint.

---

# 18. OPEN-SOURCE SKILL INGESTION PIPELINE

Varje extern skill:

```text
DISCOVER
↓
FETCH
↓
LICENSE CHECK
↓
PIN SOURCE REVISION
↓
HASH
↓
STATIC REVIEW
↓
PROMPT-INJECTION REVIEW
↓
SCRIPT REVIEW
↓
TOOL REQUIREMENT REVIEW
↓
SANDBOX TEST
↓
SKILL EVAL
↓
SUPERADMIN APPROVAL
↓
PUBLISH

```

Aldrig:

```text
git pull latest
↓
automatic production

```

---

# 19. SKILL SUPPLY-CHAIN

Lagra per imported skill:

- source repository
- source URL
- upstream author
- license
- upstream revision
- imported revision
- content SHA-256
- scripts SHA-256
- imported\_at
- imported\_by
- reviewed\_by
- local modifications
- current version
- eval score
- production status

---

# 20. SKILL REGISTRY

Databas:

`skills`

`skill_versions`

`skill_sources`

`skill_evaluations`

`skill_dependencies`

`skill_assignments`

`skill_rollbacks`

Exempel på fält:

```text
id
slug
name
description

domain
capabilities

source_type
source_repository
source_revision
source_license

version

instructions_path

required_tools
required_permissions

compatible_agents
compatible_modes

risk_class

eval_score

status

created_by
approved_by

created_at
updated_at

```

---

# 21. SKILL STATUS

Använd state machine:

```text
DISCOVERED
IMPORTED
QUARANTINED
REVIEWING
TESTING
CANDIDATE
APPROVED
PRODUCTION
DEPRECATED
REVOKED

```

---

# 22. MANDATORY CORE SKILLS

Systemet ska från början innehålla avancerade skills inom minst följande områden.

### Planning

- task-understanding
- requirements-analysis
- architecture-planning
- implementation-planning
- dependency-analysis
- risk-analysis

### Agent execution

- autonomous-loop
- continuous-agent-loop
- execute-until-verified
- checkpoint-and-resume
- retry-with-diagnosis
- budget-aware-loop

### Coding

- repository-understanding
- codebase-navigation
- implementation
- refactoring
- API-development
- frontend-development
- backend-development
- database-development

### Testing

- test-driven-development
- unit-testing
- integration-testing
- E2E-testing
- regression-testing
- browser-testing
- API-testing
- migration-testing

### Debugging

- systematic-debugging
- root-cause-analysis
- root-cause-tracing
- log-analysis
- reproduction-first
- fix-and-retest

### Verification

- verification-before-completion
- evidence-based-completion
- diff-review
- code-review
- test-verification
- build-verification

### Git

- branch-first-development
- Git worktrees
- commit-quality
- pull-request
- conflict-resolution

### Research

- deep-research
- source-verification
- documentation-research
- cross-source-validation

### Infrastructure

- Supabase
- PostgreSQL
- Next.js
- React
- Vercel
- GitHub
- Docker
- CI/CD
- observability

### Security

- secure-code-review
- dependency-analysis
- threat-modeling
- auth-review
- authorization-review
- RLS-review
- attack-surface-analysis
- controlled-Lab-workflow
- remediation-verification

---

# 23. AUTONOMOUS LOOP SKILL

Bygg en canonical:

`continuous-agent-loop`

Skillen ska göra:

```text
GOAL
↓
UNDERSTAND
↓
RETRIEVE
↓
PLAN
↓
ACTION
↓
OBSERVATION
↓
VERIFY
↓
SUCCESS?
├── YES → COMPLETE
└── NO
     ↓
   DIAGNOSE
     ↓
   ADJUST PLAN
     ↓
   ACTION

```

Agenten får fortsätta tills:

- verifierat resultat
- användaren stoppar
- max iterations
- resource budget uppnås
- operationen inte längre kan genomföras säkert

Agenten får inte ge upp bara för att första försöket misslyckas.

---

# 24. SMART FAILURE LOOP

Misslyckande ska inte automatiskt leda till exakt samma försök igen.

Gör:

```text
FAILURE
↓
CLASSIFY FAILURE

├── Code
├── Dependency
├── Environment
├── Test
├── Permission
├── Network
├── Data
├── Model
└── Unknown

↓
ROOT CAUSE HYPOTHESIS
↓
VALIDATE
↓
CHANGE STRATEGY
↓
RETRY

```

Inför retry budgets och loop detection så agenten inte fastnar.

---

# 25. LOOP DETECTION

Agent Runtime ska upptäcka:

- samma tool call upprepas
- samma error upprepas
- samma patch återkommer
- progress score står still
- tokenförbrukning ökar utan nytt resultat

Vid detection:

```text
loop detected
↓
stop current strategy
↓
summarize observations
↓
request critic/reviewer
↓
generate alternative strategy
↓
continue

```

---

# 26. E2E SKILL — OBLIGATORISK

Bygg en canonical:

`webapp-e2e-verification`

Den ska använda Playwright-baserad browser automation.

Canonical flow:

```text
DETECT APP
↓
START APP / VERIFY LIVE ENVIRONMENT
↓
HEALTH CHECK
↓
OPEN BROWSER
↓
AUTHENTICATE
↓
EXECUTE USER JOURNEY
↓
ASSERT UI
↓
ASSERT NETWORK
↓
ASSERT BACKEND RESULT
↓
ASSERT DATABASE STATE WHERE AUTHORIZED
↓
CHECK CONSOLE
↓
CHECK RUNTIME ERRORS
↓
CAPTURE TRACE / SCREENSHOT
↓
PASS / FAIL

```

---

# 27. E2E FÅR INTE BARA TESTA ATT SIDAN LADDAR

E2E måste verifiera verkliga flows.

Exempel:

```text
User opens signup
↓
fills form
↓
submits
↓
API receives data
↓
DB state changes
↓
UI displays success
↓
email/event generated if applicable

```

Verifiera hela kedjan.

---

# 28. FULL-STORY VERIFICATION SKILL

Skapa:

`full-story-verification`

För en ändring:

```text
Browser
↓
Frontend
↓
API
↓
Auth
↓
Database
↓
Queue
↓
Worker
↓
External integration
↓
Response
↓
Browser

```

Agenten ska verifiera den verkliga storyn, inte bara unit tests.

---

# 29. BROWSER SKILLS

Minst:

- webapp-testing
- authenticated-flow-testing
- form-testing
- multi-step-flow-testing
- cross-browser-testing
- responsive-testing
- accessibility-smoke
- console-error-check
- network-request-validation
- browser-performance-smoke
- screenshot-evidence
- regression-browser-flow

---

# 30. BROWSER MATRIX

När relevant:

- Chromium
- Firefox
- WebKit

Critical flows bör kunna köras mot flera browsers.

---

# 31. SYSTEMATIC DEBUGGING SKILL

Agenten ska inte börja ändra slumpmässig kod.

Canonical:

```text
REPRODUCE
↓
COLLECT EVIDENCE
↓
TRACE FAILURE
↓
IDENTIFY ROOT CAUSE
↓
CREATE MINIMAL FIX
↓
RUN TARGETED TEST
↓
RUN REGRESSION TESTS
↓
VERIFY

```

---

# 32. VERIFICATION BEFORE COMPLETION

Agenten får inte avsluta med:

> Detta borde fungera.

För coding krävs relevanta bevis.

Exempel:

- lint
- typecheck
- tests
- build
- E2E
- migrations
- static analysis
- diff review

Slutsvar ska skilja mellan:

- verified
- partially verified
- not verified

---

# 33. TDD SKILL

När uppgiften passar:

```text
RED
↓
failing test

GREEN
↓
minimal implementation

REFACTOR
↓
improve implementation

VERIFY
↓
test suite

```

TDD ska vara en skill och metodik.

Inte universell tvångsregel för varje enskild operation.

---

# 34. SUBAGENT-DRIVEN DEVELOPMENT

För större uppgifter:

```text
Planner
↓
task decomposition
↓
independent tasks
↓
parallel agents
↓
results
↓
integration
↓
reviewer
↓
verification

```

Subagents ska dela artifacts och strukturerade resultat.

Inte privata fria tankeströmmar.

---

# 35. PARALLELLA AGENTS

Agent Runtime ska kunna identifiera oberoende arbete.

Exempel:

```text
Agent A → frontend analysis

Agent B → backend analysis

Agent C → database analysis

Agent D → tests

↓
Integrator
↓
Reviewer

```

Kör inte parallellt när tasks modifierar samma kritiska state utan coordination.

---

# 36. GIT WORKTREE SKILL

För parallellt repo-arbete ska systemet stödja Git worktrees.

Exempel:

```text
main repo
├── worktree-agent-a
├── worktree-agent-b
└── worktree-agent-c

```

Det minskar kollisioner mellan subagents.

---

# 37. BRANCH-FIRST SKILL

Default:

```text
main
↓
agent/<task>-<run-id>
↓
changes
↓
tests
↓
review
↓
commit
↓
PR

```

Inte direkt main.

Direct-main är separat capability.

---

# 38. CODE REVIEW SKILL

Efter implementation:

```text
REQUIREMENTS REVIEW
↓
ARCHITECTURE REVIEW
↓
DIFF REVIEW
↓
SECURITY REVIEW
↓
REGRESSION REVIEW
↓
TEST COVERAGE
↓
PASS / CHANGES REQUIRED

```

Critical issues blockerar completion.

---

# 39. DATABASE SKILLS

Bygg skills för:

- schema analysis
- migration design
- safe migrations
- migration replay
- database type generation
- indexes
- query planning
- N+1 detection
- transaction safety
- idempotency
- RLS
- backup/restore

---

# 40. SUPABASE SKILLS

Minst:

- Supabase architecture
- RLS design
- RLS verification
- migrations
- Edge Functions
- Auth
- Storage
- Realtime
- Postgres performance
- generated types synchronization
- clean migration replay
- production-vs-development discipline

---

# 41. NEXT.JS / REACT SKILLS

Minst:

- Next.js App Router
- Server Components
- Client Components
- Server Actions
- caching
- routing
- API patterns
- rendering
- bundle optimization
- React performance
- accessibility
- hydration debugging

---

# 42. CI/CD SKILLS

Minst:

- GitHub Actions analysis
- CI failure diagnosis
- build reproduction
- deployment verification
- preview environments
- production deployment
- rollback
- environment variables
- migration CI
- E2E CI

---

# 43. PERFORMANCE SKILLS

Bygg:

- performance-baseline
- frontend-performance
- API-performance
- Postgres-performance
- bundle-analysis
- caching-analysis
- load-testing
- concurrency-testing
- GPU-performance
- latency-analysis

---

# 44. LOAD-TEST SKILL

Flow:

```text
BASELINE
↓
SMOKE
↓
NORMAL LOAD
↓
PEAK
↓
SPIKE
↓
SOAK
↓
FAILURE ANALYSIS
↓
OPTIMIZE
↓
RETEST

```

Spara resultaten versionerat.

---

# 45. SECURITY SKILLS

Skills ska kunna hjälpa agenten med auktoriserat arbete inom exempelvis:

- secure code review
- threat modeling
- auth analysis
- authorization analysis
- RLS analysis
- dependency scanning
- secrets detection
- vulnerability validation
- network analysis i godkända Lab-miljöer
- remediation
- regression verification

All aktiv execution går fortsatt via Tool Gateway och scope-policy.

---

# 46. SKILLS GER INTE PERMISSIONS

Detta är kritiskt:

```text
Skill instructions
≠
Authorization

```

En skill kan säga:

`run database migration`

men actual tool execution går fortfarande:

```text
Agent
↓
Tool Gateway
↓
User/Workspace
↓
Permission
↓
Resource
↓
Policy
↓
Credential Broker
↓
Execution

```

Skills får aldrig kunna eskalera permissions.

---

# 47. SKILL DEPENDENCIES

En skill ska kunna deklarera:

```text
depends_on:
  - systematic-debugging
  - verification-before-completion

```

eller:

```text
tools:
  - browser
  - shell
  - github

```

Skill Engine resolverar dependency graph innan körning.

---

# 48. SKILL ROUTER

När en task kommer:

```text
Task
↓
Task classifier
↓
Skill candidate search
↓
Capability filter
↓
Permission filter
↓
Relevance ranking
↓
Load best skills

```

Skills ska kunna rankas med:

- semantic relevance
- historical success
- eval score
- agent compatibility
- task domain
- tool availability
- recency/version

---

# 49. SKILL LEARNING

Agenten kan föreslå:

- ny skill
- skill improvement
- nytt failure pattern
- ny verification gate

Men agenten får inte själv publicera global skill.

Flow:

```text
Agent suggestion
↓
Skill candidate
↓
Tests
↓
Eval
↓
Superadmin
↓
Approve
↓
Production

```

---

# 50. SKILL EVALS

Varje critical skill måste ha egna evals.

Exempel för E2E:

- hittar rätt UI-element
- följer hela flödet
- upptäcker frontendfel
- upptäcker API-fel
- upptäcker felaktig DB-state
- dokumenterar failure korrekt

Exempel för debugging:

- reproducerar
- hittar root cause
- undviker symptomfix
- regressionssäkrar

---

# 51. SKILL A/B TESTING

Nya skillversioner kan testas:

```text
skill v4
vs
skill v5

```

Mät:

- completion rate
- iterations
- tokens
- tool calls
- time
- regressions
- verifier success
- cost/task

---

# 52. SKILL ROLLBACK

Om ny skill orsakar sämre resultat:

```text
v5
↓
rollback
↓
v4

```

utan att ändra foundation model.

---

# 53. SUPERADMIN SKILLS DASHBOARD

Route:

`/admin/skills`

Visa:

- installed skills
- source
- license
- version
- upstream revision
- status
- used by agents
- usage
- success rate
- eval score
- last updated
- updates available

Superadmin kan:

- import
- create
- fork
- edit
- test
- evaluate
- approve
- publish
- disable
- rollback
- deprecate

---

# 54. SKILL UPDATE SYSTEM

Open-source updates:

```text
upstream update detected
↓
create candidate
↓
show diff
↓
security scan
↓
skill evals
↓
regression
↓
superadmin approval
↓
production

```

Ingen automatisk overwrite av lokalt modifierade skills.

---

# 55. SUPERADMIN GLOBAL LEARNING

Endast Superadmin får permanent förändra DIV3RSA\:s globala intelligence.

En normal user får inte:

- skriva global knowledge
- publicera global skill
- skapa global training data
- starta training
- promovera modell
- ändra global policies

---

# 56. SUPERADMIN — "LÄR DIG DETTA"

Superadmin ska kunna säga exempelvis:

> Läs denna dokumentation och lär dig den.

Systemet ska tolka detta som:

```text
SUPERADMIN
↓
KNOWLEDGE INGESTION
↓
READ
↓
PARSE
↓
SECRET SCAN
↓
PROVENANCE
↓
CONFLICT DETECTION
↓
DEDUPLICATE
↓
CHUNK
↓
EMBED
↓
STORE
↓
AVAILABLE TO AGENTS

```

Det innebär **inte omedelbar weight training**.

---

# 57. KNOWLEDGE INPUTS

Superadmin kan lägga in:

- text
- Markdown
- PDF
- dokument
- URL
- webbsida
- Git repository
- API documentation
- source code
- research
- datasets
- egna instruktioner

---

# 58. KNOWLEDGE SCOPE

Superadmin väljer:

- Global
- General
- Code
- Lab
- Research
- Architecture
- specific agent

---

# 59. KNOWLEDGE TYPE

Minst:

- Fact
- Reference
- Procedure
- Best Practice
- Instruction
- Example
- Policy
- Skill Candidate
- Training Candidate

---

# 60. KNOWLEDGE PROVENANCE

Varje knowledge item ska veta:

- source
- source type
- source URL
- source hash
- creator
- approver
- version
- trust
- confidence
- verification status
- created\_at
- updated\_at

Det ska gå att se exakt varifrån en information kommer.

---

# 61. MEMORY LAYERS

Separera:

- Session Memory
- User Memory
- Project Memory
- Repository Memory
- Workspace Memory
- Organization Knowledge
- Global Knowledge
- Skills
- Training Data

Dessa är inte samma sak.

---

# 62. NORMAL USER FÅR INTE POISONA GLOBAL INTELLIGENCE

Canonical:

```text
user conversation
≠
global knowledge

user agent run
≠
training dataset

```

Vanliga users kan inte göra sin egen input till global DIV3RSA-fakta.

---

# 63. LEARNING LEVEL 1

**Memory / Knowledge**

Direkt.

Ingen weight update.

---

# 64. LEARNING LEVEL 2

**Skills**

Verifierade workflows och reusable procedures.

---

# 65. LEARNING LEVEL 3

**Model adaptation**

Periodiskt:

- LoRA
- QLoRA
- SFT
- preference tuning

på godkända datasets.

---

# 66. LEARNING LEVEL 4

Framtida:

- DPO
- reward optimization
- reinforcement learning
- verifiable reward training
- distillation

endast när evalsystemet är tillräckligt moget.

---

# 67. RAW PRODUCTION DATA FÅR INTE DIREKT BLI TRAINING

Pipeline:

```text
raw
↓
secret scrub
↓
PII handling
↓
tenant policy
↓
deduplicate
↓
quality scoring
↓
verification
↓
training candidate
↓
superadmin approval
↓
dataset

```

---

# 68. DATASETS

Bygg:

- `dataset_candidates`
- `datasets`
- `dataset_versions`
- `dataset_examples`

Dataset måste vara immutable/versionerade efter lock.

Exempel:

- `code-v1`
- `agent-v1`
- `reasoning-v1`
- `lab-v1`
- `research-v1`

---

# 69. TRAJECTORIES

Spara strukturerat:

```text
TASK
↓
PLAN
↓
ACTION
↓
OBSERVATION
↓
ACTION
↓
TEST
↓
RESULT
↓
VERIFICATION
↓
REWARD

```

Inte långa privata fria chain-of-thought-loggar.

---

# 70. TRAINING REGISTRY

`training_runs`

ska lagra:

- base model
- exact checkpoint
- dataset
- dataset version
- training method
- recipe version
- hyperparameters
- GPU
- provider
- metrics
- resulting artifact
- hash
- adapter
- eval result
- creator

---

# 71. LORA FÅR INTE BLI ENDA MEMORY

Qwen-LoRA är modelspecifik.

Canonical intelligence ska ligga i:

- datasets
- skills
- knowledge
- experiences
- trajectories
- evals
- reward data
- research
- training recipes

Då kan samma intelligence appliceras på nästa foundation model.

---

# 72. MODEL MIGRATION

När en bättre foundation model finns:

```text
REGISTER
↓
PIN
↓
ISOLATED DEPLOYMENT
↓
LOAD DIV3RSA KNOWLEDGE
↓
LOAD DIV3RSA SKILLS
↓
TRAIN COMPATIBLE ADAPTER
↓
EVAL
↓
COMPARE
↓
INTERNAL TEST
↓
CANARY
↓
PROMOTE

```

---

# 73. VAD SOM ÖVERLEVER MODELLBYTE

Allt följande:

- users
- workspaces
- projects
- conversations
- repositories
- memory
- knowledge
- skills
- tools
- policies
- prompts
- datasets
- trajectories
- evals
- reward data
- research
- audit
- usage

Endast foundation artifact och modelspecifik adapter behöver bytas.

---

# 74. EVAL SUITES

Minst:

- DIV3RSA-GENERAL
- DIV3RSA-REASON
- DIV3RSA-CODE
- DIV3RSA-AGENT
- DIV3RSA-RESEARCH
- DIV3RSA-LAB
- DIV3RSA-LONG-CONTEXT
- DIV3RSA-TOOLS
- DIV3RSA-REGRESSION
- DIV3RSA-SKILLS
- DIV3RSA-E2E

---

# 75. GOLDEN HOLDOUT

Separera:

```text
TRAIN
VALIDATION
TEST
GOLDEN HOLDOUT

```

Golden holdout används aldrig för training.

---

# 76. AGENT REGISTRY

Agents är separata från modeller.

Minst:

- Planner
- General Agent
- Code Agent
- Lab Agent
- Research Agent
- Architecture Agent
- Reviewer
- Verifier
- Memory Agent
- Knowledge Distiller

---

# 77. AGENT DEFINITION

Exempel:

```text
id
name
description

model_alias

system_instructions

required_skills
optional_skills

allowed_tools

memory_policy
context_policy

max_iterations
budget_policy

review_policy
verification_policy

version
enabled

```

---

# 78. ORCHESTRATOR

Orchestrator avgör:

- user intent
- domain
- complexity
- skills
- agents
- tools
- context budget
- verifier
- GPU budget
- parallelization

Exempel:

> Optimera hela repot.

kan bli:

```text
Planner
↓
Repository Agent
↓
Frontend Agent
↓
Backend Agent
↓
Database Agent
↓
Performance Agent
↓
Test Agent
↓
Reviewer
↓
Verifier

```

---

# 79. CHECKPOINTING

Långa tasks:

`agent_runs`

`agent_steps`

`agent_checkpoints`

Checkpoint lagrar:

- plan
- completed steps
- pending steps
- git SHA
- working diff
- current artifacts
- tool state
- context summary
- model
- agent
- skill versions

---

# 80. GITHUB

Bygg GitHub App.

Inte PATs i prompten.

User väljer:

- repositories
- read
- write
- branch
- commit
- PR
- merge
- workflow permissions

Default:

**branch + tests + PR**

---

# 81. SUPABASE

User väljer:

- organization
- project
- environment
- capabilities

Production-write ska vara separat permission från development access.

Agenten får aldrig service role key i context.

---

# 82. VERCEL

User väljer:

- team
- project
- environment
- logs
- preview deployment
- production deployment
- environment management

Credential visas aldrig för modellen.

---

# 83. CREDENTIAL BROKER

Agent ser opaque ID:

`github_connection_123`

inte:

`ghs_xxxxx`

Flow:

```text
Agent
↓
Tool Gateway
↓
Authorization
↓
Credential Broker
↓
temporary scoped credential
↓
provider
↓
sanitized result

```

---

# 84. TOOL GATEWAY

Alla verktyg går genom Tool Gateway.

Tool Gateway kontrollerar:

```text
user
↓
workspace
↓
role
↓
permission
↓
mode
↓
tool
↓
arguments
↓
resource
↓
scope
↓
policy
↓
EXECUTE / DENY

```

---

# 85. SUPERADMIN

Superadmin har full administrativ produktkapacitet.

Superadmin kan:

- skapa users
- ändra organizations
- skapa agents
- skapa modes
- skapa policies
- skapa tools
- importera skills
- skapa skills
- lägga till knowledge
- hantera memory
- skapa datasets
- starta training
- registrera modeller
- byta aliases
- starta evals
- canary
- promote
- rollback
- byta GPU-provider
- ändra autoscaling
- se audit
- se kostnader

---

# 86. SUPERADMIN FULL MODEL CAPABILITY ≠ ROOT CREDENTIALS

Superadmin kan använda modellen utan vanliga user-content-policybegränsningar.

Men modellen får fortfarande aldrig själv:

- skapa sin egen authorization
- ändra sin roll
- skapa credentials
- läsa credential vault
- ändra auth claims
- nå host shell
- nå Docker socket
- stänga av audit
- nå control plane som root

Detta är platform security.

---

# 87. SUPERADMIN AUTH

Kräv:

- Passkey/WebAuthn
- MFA
- recent privileged session

Step-up authentication för:

- production model promotion
- destructive production DB actions
- credential administration
- superadmin changes
- disable provider
- critical policy changes

---

# 88. SANDBOX

Genererad kod körs inte på GPU-host.

Architecture:

```text
Agent
↓
Tool Gateway
↓
Sandbox Manager
↓
Ephemeral Sandbox

```

Sandbox:

- rootless
- CPU limit
- RAM limit
- disk limit
- process limit
- timeout
- network policy
- no host filesystem
- no Docker socket
- no infrastructure credentials
- destroy after run

---

# 89. SEPARATA SANDBOXPROFILER

Minst:

- CodeSandbox
- LabSandbox
- BrowserSandbox

Security/Lab får inte automatiskt dela samma network policy som vanlig Code.

---

# 90. PROMPT INJECTION

All extern data:

- repository
- README
- issue
- web page
- document
- tool output
- API response

betraktas som:

**UNTRUSTED DATA**

Extern text får inte:

- höja permission
- skapa credential
- ändra policy
- aktivera tool
- stänga av audit

---

# 91. RESEARCH

Research Agent:

```text
QUESTION
↓
SEARCH
↓
OPEN SOURCES
↓
READ
↓
SEARCH DEEPER
↓
COMPARE
↓
CONFLICT CHECK
↓
SYNTHESIZE
↓
ANSWER
↓
SOURCES

```

Aktuella fakta ska inte hämtas enbart från model weights.

---

# 92. REPOSITORY INDEXING

Vid repository connect:

```text
clone
↓
detect languages
↓
parse
↓
symbols
↓
relationships
↓
dependency graph
↓
chunk
↓
embed
↓
index

```

Reindex endast förändrade filer/symboler via git SHA och hashes.

---

# 93. CONTEXT ENGINE

Skicka aldrig hela repositoryt som default.

Bygg:

```text
user request
+
recent context
+
project memory
+
repo retrieval
+
symbols
+
knowledge
+
skills
+
research
+
tool state
↓
rerank
↓
dedupe
↓
compress
↓
context package

```

---

# 94. SUPABASE CONTROL PLANE

Supabase används för:

- Auth
- Postgres
- pgvector
- Storage
- Queues
- Realtime där relevant

Supabase är inte inference-server.

---

# 95. DATABASE SCHEMAS

Separera exempelvis:

- `public`
- `internal`
- `training`
- `audit`

Alla exponerade user tables:

**RLS ON**

---

# 96. CORE TABLES

Minst:

```text
profiles

organizations
organization_members

roles
permissions
role_permissions

workspaces
workspace_members

projects
project_repositories

conversations
messages

agent_definitions
agent_versions
agent_runs
agent_steps
agent_checkpoints

skills
skill_versions
skill_sources
skill_evaluations
skill_assignments

tool_definitions
tool_executions

integration_connections
integration_resources
integration_capabilities

sandboxes

knowledge_sources
knowledge_items
knowledge_chunks
knowledge_embeddings
knowledge_ingestion_runs

memories

experiences
learning_events

dataset_candidates
datasets
dataset_versions
dataset_examples

training_runs

models
model_versions
model_artifacts
model_deployments
model_aliases

adapter_versions

eval_suites
eval_cases
eval_runs
eval_results

gpu_providers
gpu_workers
gpu_metrics

autoscaling_policies
autoscaling_events

usage_events
usage_daily
usage_monthly

audit_events

```

---

# 97. GPU

Första GPU-profile:

`large_96gb`

Första konkreta target:

**RTX PRO 6000 96 GB**

Koden får dock inte anta just denna GPU.

---

# 98. GPU PROVIDER ABSTRACTION

Skapa:

`GpuProvider`

med:

- `listCapacity()`
- `getPricing()`
- `provisionWorker()`
- `getWorker()`
- `listWorkers()`
- `startWorker()`
- `drainWorker()`
- `stopWorker()`
- `terminateWorker()`
- `getStatus()`
- `getMetrics()`

---

# 99. PROVIDERS

Initialt stöd:

- Hyperstack
- RunPod

Framtida:

- Vast
- Lambda
- Nebius
- Local/Dedicated

Ingen annan kod får känna till providerspecifik provisioning.

---

# 100. GPU WORKERS ÄR STATELESS

Worker får innehålla:

- model weights
- tokenizer
- runtime
- model cache
- KV cache
- temporary inference state

Inte:

- canonical user data
- memory
- projects
- audit
- datasets
- billing
- permanent agent state

---

# 101. AUTOSCALING

GPU-skalning styrs av belastning.

Inte user count.

Mät:

- active generations
- queue depth
- queue p95
- TTFT
- tokens/sec
- GPU utilization
- VRAM
- KV cache
- context
- errors

---

# 102. INITIAL CAPACITY

Default:

```text
minimum warm:
1 worker

```

Burst:

```text
1
↓
2
↓
3
↓
4

```

endast efter faktisk load.

---

# 103. REQUEST CLASSES

- `INTERACTIVE_HIGH`
- `AGENT_NORMAL`
- `BACKGROUND_LOW`
- `TRAINING`

Interactive går först.

---

# 104. TRAINING SKA HA SEPARAT COMPUTE

Production inference och training bör inte konkurrera.

```text
Training requested
↓
Training Scheduler
↓
Temporary training GPU
↓
Train
↓
Save artifact
↓
Eval
↓
Terminate GPU

```

---

# 105. USAGE

Även generös/unlimited produkt mäts.

Mät:

- input tokens
- output tokens
- cached tokens
- context
- GPU seconds
- sandbox seconds
- queue time
- model
- agent
- skill versions
- web/tool usage
- cost/run
- cost/user

Unlimited usage betyder inte unlimited simultaneous compute.

---

# 106. OBSERVABILITY

Varje operation:

- request\_id
- trace\_id
- run\_id

Spårning:

```text
Browser
↓
API
↓
Orchestrator
↓
Skills
↓
Model
↓
Tool
↓
Sandbox
↓
Verifier
↓
Result

```

---

# 107. AUDIT

Logga minst:

- authentication
- permission changes
- integration changes
- tool calls
- network actions
- skill imports
- skill publications
- global knowledge ingestion
- memory promotion
- dataset approval
- training
- model deployment
- canary
- rollback
- GPU/provider changes
- superadmin actions

Secrets får aldrig loggas raw.

---

# 108. MONOREPO

Canonical struktur:

```text
/
├── apps/
│   ├── web/
│   └── api/
│
├── services/
│   ├── agent-control/
│   ├── orchestrator/
│   ├── skill-engine/
│   ├── model-gateway/
│   ├── tool-gateway/
│   ├── credential-broker/
│   ├── sandbox-manager/
│   ├── memory-service/
│   ├── knowledge-service/
│   ├── repo-indexer/
│   ├── evaluator/
│   ├── training-control/
│   ├── gpu-controller/
│   ├── scheduler/
│   └── audit-service/
│
├── workers/
│   ├── agent-worker/
│   ├── sandbox-worker/
│   ├── browser-worker/
│   ├── embedding-worker/
│   ├── evaluation-worker/
│   └── training-worker/
│
├── packages/
│   ├── auth/
│   ├── db/
│   ├── schemas/
│   ├── agents/
│   ├── skills/
│   ├── model-sdk/
│   ├── tools/
│   ├── policies/
│   ├── providers/
│   ├── observability/
│   └── ui/
│
├── skills/
│   ├── core/
│   ├── coding/
│   ├── testing/
│   ├── debugging/
│   ├── browser/
│   ├── database/
│   ├── infrastructure/
│   ├── research/
│   ├── security/
│   ├── imported/
│   └── experimental/
│
├── supabase/
│   ├── migrations/
│   ├── functions/
│   ├── seed/
│   └── tests/
│
├── models/
│   ├── manifests/
│   ├── configs/
│   └── registry/
│
├── training/
│   ├── recipes/
│   ├── datasets/
│   └── configs/
│
├── evals/
│   ├── models/
│   ├── agents/
│   ├── skills/
│   ├── e2e/
│   ├── security/
│   └── regression/
│
└── infra/
    ├── gpu/
    ├── sandbox/
    ├── browser/
    ├── docker/
    └── monitoring/

```

---

# 109. IMPLEMENTATION ORDER

## Phase 1 — Platform

Bygg:

1. monorepo
2. Vercel
3. Supabase
4. migrations
5. Auth
6. RBAC
7. MFA
8. Request Access
9. Hero
10. user shell
11. projects

---

## Phase 2 — Skills Foundation

Bygg:

1. open Agent Skills-compatible structure
2. Skill Registry
3. Skill Router
4. Skill Loader
5. versioning
6. dependency resolver
7. skill eval framework
8. skill rollback
9. source/license/hash tracking

Importera sedan verifierade basmetodiker från relevanta open-source skillprojekt.

---

## Phase 3 — Mandatory Smart Skills

Implementera minst:

1. autonomous-loop
2. continuous-agent-loop
3. systematic-debugging
4. verification-before-completion
5. test-driven-development
6. implementation-planning
7. subagent-driven-development
8. parallel-agents
9. Git worktrees
10. branch-first
11. code-review
12. full-story-verification
13. webapp-e2e-verification
14. Playwright browser-testing
15. regression-testing
16. load-testing
17. repo-understanding
18. research
19. Supabase
20. PostgreSQL
21. Next.js
22. React
23. Vercel
24. GitHub
25. security-review

---

## Phase 4 — Model

1. Model Registry
2. Qwen exact revision registration
3. Model Adapter
4. Model Gateway
5. inference runtime
6. streaming
7. model health

---

## Phase 5 — Agent Runtime

1. Orchestrator
2. Task Router
3. Agent Registry
4. skill selection
5. Context Engine
6. agent state machine
7. loops
8. failure classification
9. checkpoints
10. Reviewer
11. Verifier

---

## Phase 6 — GPU

1. GPU Provider interface
2. RTX PRO 6000 worker
3. provider implementation
4. worker image
5. metrics
6. scheduler
7. queue
8. autoscaler
9. drain
10. failover

---

## Phase 7 — Tools

1. Tool Registry
2. Tool Gateway
3. Credential Broker
4. GitHub App
5. Supabase
6. Vercel
7. browser
8. filesystem
9. shell
10. testing tools

---

## Phase 8 — Sandbox

1. Sandbox Manager
2. CodeSandbox
3. LabSandbox
4. BrowserSandbox
5. resource restrictions
6. network policies
7. secret scanning
8. output sanitization

---

## Phase 9 — E2E

1. Playwright integration
2. browser worker
3. authentication state
4. E2E skill
5. trace capture
6. screenshots
7. console validation
8. API validation
9. optional DB validation
10. cross-browser tests

---

## Phase 10 — Repository Intelligence

1. repo index
2. AST/symbol extraction
3. dependency graph
4. embeddings
5. hybrid search
6. incremental reindex
7. repository memory

---

## Phase 11 — Superadmin Knowledge

1. Knowledge Inbox
2. PDF/doc ingestion
3. URL ingestion
4. repository ingestion
5. provenance
6. hash
7. secret scan
8. conflict detection
9. chunking
10. embeddings
11. global knowledge
12. versioning

Definition of Done:

Superadmin kan säga:

> Läs detta och lär dig det.

och en ny agent-session kan använda informationen direkt.

---

## Phase 12 — Learning

1. learning events
2. experiences
3. training candidates
4. approval workflow
5. dataset builder
6. dataset versioning

---

## Phase 13 — Training

1. training recipes
2. LoRA/QLoRA
3. training GPU abstraction
4. training runs
5. adapters
6. resulting artifacts
7. hashes

---

## Phase 14 — Evals

1. model evals
2. agent evals
3. skill evals
4. E2E evals
5. regression
6. latency
7. cost
8. GPU benchmarks

---

## Phase 15 — Promotion

```text
Candidate
↓
Evals
↓
Regression
↓
Internal testing
↓
Canary
↓
5%
↓
20%
↓
50%
↓
100%

```

Rollback alltid tillgängligt.

---

# 110. NON-NEGOTIABLE INVARIANTS

1. Frontend kommunicerar aldrig direkt med fysisk GPU.
2. Ingen service får vara permanent beroende av Qwen.
3. Ingen service får vara permanent beroende av RTX PRO 6000.
4. Ingen service får vara permanent beroende av en specifik GPU-provider.
5. Foundation-modellen får aldrig bestämma sin egen authorization.
6. Skills får aldrig ge sig själva permissions.
7. Alla tools går genom Tool Gateway.
8. Alla secrets går genom Credential Broker.
9. Secrets hamnar aldrig i vanlig modellcontext.
10. Agents får inte host shell.
11. Genererad kod exekveras i sandbox.
12. GPU worker innehåller ingen canonical persistent user state.
13. Normal user får aldrig skriva Global Knowledge.
14. Normal user får aldrig publicera global skill.
15. Normal user får aldrig skapa global training data.
16. Endast Superadmin kan promovera global intelligence.
17. Raw conversations blir aldrig automatiskt training.
18. Learning måste vara versionerad.
19. Training deployas aldrig automatiskt.
20. Modell/artifact måste ha checksum.
21. Skills från open source måste pinnas, granskas och evalueras.
22. Open-source skilluppdateringar går aldrig direkt till production.
23. Varje critical skill måste kunna rollbackas.
24. External content är alltid untrusted.
25. Tenant isolation verkställs utanför modellen.
26. Audit får inte ändras av agenten.
27. Långvariga agents måste kunna checkpointa.
28. Agenten får inte fastna i obegränsade loops.
29. Completion kräver verifiering, inte bara modellens påstående.
30. Critical web flows ska kunna verifieras E2E.

---

# 111. DEFINITION OF DONE — SMART SKILLS

Skills-systemet är inte klart förrän:

- skills kan upptäckas dynamiskt
- endast relevanta skills laddas
- open-source skills kan importeras
- source och license sparas
- exact revision pinnas
- skill scripts granskas
- skill evals körs
- Superadmin godkänner publication
- skills kan versioneras
- skills kan A/B-testas
- skills kan rollbackas
- skills överlever foundation-model byte
- skills kan användas av flera agents
- agents kan kombinera flera skills

---

# 112. DEFINITION OF DONE — AUTONOMOUS LOOP

Agenten ska kunna:

```text
task
↓
plan
↓
execute
↓
fail
↓
diagnose
↓
change strategy
↓
retry
↓
test
↓
verify
↓
complete

```

utan att användaren behöver instruera den efter varje enskilt steg.

Den får samtidigt inte loopa obegränsat.

---

# 113. DEFINITION OF DONE — E2E

En Code Agent ska efter en webbförändring kunna:

```text
build
↓
start app
↓
open browser
↓
perform realistic user flow
↓
verify frontend
↓
verify network/API
↓
verify resulting state
↓
check errors
↓
capture evidence
↓
declare verified

```

---

# 114. DEFINITION OF DONE — SUPERADMIN LEARNING

```text
Superadmin provides source
↓
system reads
↓
source provenance stored
↓
knowledge extracted
↓
hash stored
↓
embeddings generated
↓
knowledge published
↓
new unrelated run starts
↓
relevant knowledge retrieved
↓
agent successfully uses it

```

---

# 115. DEFINITION OF DONE — TRAINING

```text
Verified intelligence
↓
Training candidates
↓
Superadmin approval
↓
Dataset version
↓
Training
↓
Adapter
↓
Eval
↓
Candidate
↓
Canary
↓
Production

```

---

# 116. DEFINITION OF DONE — MODEL INDEPENDENCE

Systemet ska kunna byta:

```text
Qwen3.8-27B-OBLITERATED V2
↓
Future Foundation Model

```

och behålla:

- users
- projects
- repositories
- memory
- knowledge
- skills
- tools
- integrations
- trajectories
- datasets
- evals
- policies
- audit
- history

---

# 117. DEFINITION OF DONE — GPU INDEPENDENCE

Systemet ska kunna byta:

```text
RTX PRO 6000
↓
Future GPU

```

eller:

```text
Provider A
↓
Provider B

```

utan ändring i user-facing produktarkitektur.

---

# 118. SLUTLIG DESIGNPRINCIP

Bygg aldrig:

```text
User
↓
Qwen
↓
Answer

```

Bygg:

```text
                           DIV3RSA
                              │
             ┌────────────────┴────────────────┐
             │                                 │
           USERS                          SUPERADMIN
             │                                 │
             │                           KNOWLEDGE
             │                           SKILLS
             │                           TRAINING
             │                           MODELS
             │                                 │
             └────────────────┬────────────────┘
                              ▼
                        ORCHESTRATOR
                              │
                        SKILL ENGINE
                              │
                 ┌────────────┼─────────────┐
                 ▼            ▼             ▼
               CHAT          CODE           LAB
                 │            │             │
                 └────────────┼─────────────┘
                              ▼
                         CONTEXT ENGINE
                              │
        ┌─────────────────────┼────────────────────┐
        ▼                     ▼                    ▼
      MEMORY               KNOWLEDGE             SKILLS
        │                     │                    │
        └─────────────────────┼────────────────────┘
                              ▼
                         MODEL GATEWAY
                              │
                              ▼
                QWEN3.8-27B-OBLITERATED V2
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
                   TOOLS            RESEARCH
                     │
                     ▼
                  SANDBOX
                     │
                     ▼
                   VERIFY
                     │
                     ▼
                   RESULT
                     │
                     ▼
             VERIFIED EXPERIENCE
                     │
                     ▼
            SUPERADMIN CONTROL
                     │
             ┌───────┴────────┐
             ▼                ▼
          KNOWLEDGE          SKILLS
                              │
                              ▼
                           DATASETS
                              │
                              ▼
                           TRAINING
                              │
                              ▼
                             EVAL
                              │
                              ▼
                            CANARY
                              │
                              ▼
                         PRODUCTION

```

Den långsiktiga tillgången ska inte vara:

**"Vi har en Qwen-modell."**

Den ska vara:

**"Vi har byggt DIV3RSA Intelligence."**

Det inkluderar:

- DIV3RSA Knowledge
- DIV3RSA Skills
- DIV3RSA agent workflows
- DIV3RSA verified experiences
- DIV3RSA datasets
- DIV3RSA eval suites
- DIV3RSA research corpus
- DIV3RSA tool integrations
- DIV3RSA training recipes
- DIV3RSA infrastructure

När en bättre foundation model kommer ska vi därför kunna applicera flera års DIV3RSA-intelligens på den nya modellen istället för att börja om.

**Foundation-modellen är motorn.**
**DIV3RSA är systemet.**
