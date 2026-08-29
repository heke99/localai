# Tool runtime timeout invariant

All dynamically composed worker tool runtimes are bounded at the composition layer so a provider that never resolves cannot leave an agent run indefinitely in `waiting_for_tool`.

- Tool discovery timeout: 15 seconds by default.
- Tool execution timeout: 90 seconds by default.
- Timeout errors include `timeout` in the error code so the worker classifies them as retryable.
- Core `web_search` and `web_fetch` keep their stricter internal 10–12 second network timeouts; the composite timeout is a final safety net for every provider runtime.

The composition-layer timeout deliberately does not assume that the underlying provider request can be cancelled. It guarantees that the worker regains control and can fail/retry/release the run instead of blocking the user's queue indefinitely.
