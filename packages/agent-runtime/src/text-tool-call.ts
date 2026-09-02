import type { ModelToolDefinition } from "@div3rsa/model-sdk";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksLikeRegisteredToolInvocation(
  content: string,
  tools: readonly ModelToolDefinition[]
): boolean {
  if (!content || tools.length === 0) return false;

  return tools.some((tool) => {
    const toolName = tool.name.trim();
    if (!toolName) return false;

    const invocationPattern = new RegExp(
      `(?:^|[^A-Za-z0-9_])${escapeRegExp(toolName)}\\s*\\(`,
      "m"
    );
    return invocationPattern.test(content);
  });
}
