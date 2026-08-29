Regression scenarios covered by `composite-tool-runtime.test.ts`:

1. A provider that never resolves tool discovery must release control with `tool_runtime_timeout:list:*`.
2. A provider that never resolves tool execution must release control with `tool_runtime_timeout:execute:*`.
3. Healthy provider execution remains unchanged.
