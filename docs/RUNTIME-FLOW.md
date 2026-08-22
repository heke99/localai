# Skill Runtime Flow

```text
request
  -> actor/tenant resolution
  -> capability + policy resolution
  -> task classifier
  -> skill discovery
  -> dependency expansion
  -> context budget planner
  -> sandbox/tool grant
  -> execution/checkpoints
  -> verification
  -> audit/artifact persistence
  -> optional approved knowledge candidate
  -> eval telemetry
```

## Dependency ordering

1. authorization/policy
2. process skill
3. domain skill
4. execution/tool skill
5. verification
6. persistence/evals

## Failure behavior

A failed tool call is evidence, not permission to guess. The runtime should preserve the last valid checkpoint, record the failure class, and retry only when the active skill allows it.

## Model independence

Skills receive normalized runtime capabilities instead of model-specific APIs. Model adapters expose common primitives such as reasoning, tool selection, structured output and context limits. Skills must not depend on a specific Qwen checkpoint.
