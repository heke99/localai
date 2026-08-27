---
name: current-information-research
description: Use whenever an answer may depend on information that can change over time, including rules, visas, prices, news, software, public facts or other current web data.
metadata:
  version: "1.1.0"
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
4. Treat the result set from one search as a pool of candidate sources. When it already contains enough strong evidence, open several relevant results instead of launching redundant searches.
5. For standard current-information research, aim for up to 2 relevant sources when available. For deep research or high/critical-risk claims, aim for up to 3. Do not substitute weak sources merely to reach a count, and do not fail solely because one definitive primary source is the only reliable source available.
6. Prefer independent domains where that improves corroboration, but allow multiple distinct pages/documents from the same authoritative organization when they provide separate useful evidence.
7. For tax, visas, laws, benefits, regulation and government procedures, anchor the answer in the responsible authority. Secondary sources may help explain but must not override current primary guidance.
8. For latest/current release, version, build or firmware questions, search broadly enough to find the canonical current/latest/download/index source; historical version-specific pages must not win merely because they rank first in search.
9. Search in the language(s) most likely to expose the primary source, not only the user's response language.
10. Open and read the relevant sources rather than relying only on search-result snippets.
11. Record retrieval date and distinguish publication date, event date and effective date when those differ.
12. Resolve conflicts by authority, recency and specificity; search further when material claims remain unsupported or contradictory.
13. Stop when each material current claim has sufficient evidence; do not spend the full research budget without need.
14. Provide the answer in the user's language with source attribution and clearly mark anything that could not be verified.

## Verification Gate
Every material time-sensitive claim is grounded in current evidence of appropriate authority. When several strong sources are available from the same search, use them rather than arbitrarily selecting only the first. Official rules must not be represented as current solely from model memory or an outdated secondary source.

## Failure / Rollback
If current evidence cannot be retrieved or sources conflict materially, say what could not be verified and avoid presenting stale knowledge as current fact. If only one authoritative source can be verified, use it and disclose the evidence limitation when material. Fall back to stable background information only when clearly labelled.
