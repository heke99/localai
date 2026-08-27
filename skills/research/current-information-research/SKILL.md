---
name: current-information-research
description: Use whenever an answer may depend on information that can change over time, including rules, visas, prices, news, software, public facts or other current web data.
metadata:
  version: "1.0.0"
  category: research
  risk: medium
---
# Current Information Research

## When to Use
Use whenever a materially correct answer may depend on current or live information rather than static model knowledge, regardless of topic. Examples include government rules, tax, immigration, prices, product availability, software/API documentation, organizations, schedules, travel, news and realtime facts.

## When NOT to Use
Do not invoke web research for stable facts or purely creative work unless the user requests sources/current verification. Deterministic live tools such as current time may satisfy the request without general web search.

## Inputs
User question, locale/jurisdiction when known, current date/time, freshness requirement, research budget and available search/fetch/browser tools.

## Workflow
1. Decide whether the request needs `live`, `current` or `stable` information.
2. Decompose the question into claims whose answers may have changed.
3. Prefer authoritative primary sources for official facts and rules; use secondary/community sources when the question is about reporting, experience or opinion.
4. Search in the language(s) most likely to expose the primary source, not only the user's response language.
5. Open and read the relevant source rather than relying only on search-result snippets.
6. Record retrieval date and distinguish publication date, event date and effective date when those differ.
7. Resolve conflicts by authority, recency and specificity; search further when material claims remain unsupported.
8. Stop when each material current claim has sufficient evidence; do not spend the full research budget without need.
9. Provide the answer in the user's language with source attribution and clearly mark anything that could not be verified.

## Verification Gate
Every material time-sensitive claim is grounded in current evidence of appropriate authority. Official rules must not be represented as current solely from model memory or an outdated secondary source.

## Failure / Rollback
If current evidence cannot be retrieved or sources conflict materially, say what could not be verified and avoid presenting stale knowledge as current fact. Fall back to stable background information only when clearly labelled.
