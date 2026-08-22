export type Effect = "allow" | "deny";
export interface PolicyRule {
  id: string;
  effect: Effect;
  action: string;
  resourcePattern: string;
  modes?: string[];
  requiresAal2?: boolean;
}

export interface PolicyInput {
  action: string;
  resource: string;
  mode: string;
  assuranceLevel: "aal1" | "aal2";
  permissions: ReadonlySet<string>;
}

export interface PolicyDecision { allowed: boolean; reason: string; matchedRuleId?: string }

function matches(pattern: string, resource: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return resource.startsWith(pattern.slice(0, -1));
  return pattern === resource;
}

export function decidePolicy(input: PolicyInput, rules: PolicyRule[]): PolicyDecision {
  if (!input.permissions.has(input.action)) return { allowed: false, reason: "missing_permission" };
  const matching = rules.filter((rule) => rule.action === input.action && matches(rule.resourcePattern, input.resource) && (!rule.modes || rule.modes.includes(input.mode)));
  const denied = matching.find((rule) => rule.effect === "deny");
  if (denied) return { allowed: false, reason: "explicit_deny", matchedRuleId: denied.id };
  const allowed = matching.find((rule) => rule.effect === "allow");
  if (!allowed) return { allowed: false, reason: "no_allow_rule" };
  if (allowed.requiresAal2 && input.assuranceLevel !== "aal2") return { allowed: false, reason: "aal2_required", matchedRuleId: allowed.id };
  return { allowed: true, reason: "allowed", matchedRuleId: allowed.id };
}
