import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import { runtimeAliasForMode } from "../../../../lib/runtime/contracts";
import { ensureModelRuntime } from "../../../../lib/runtime/production";
import {
  buildDirectModelMessages,
  directInferenceApiKey,
  directRuntimeModelName,
  stripThinking
} from "../../../../lib/runtime/direct-model-protocol";

export const runtime = "nodejs";
export const maxDuration = 300;

const modes = new Set(["chat", "code", "lab", "research"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcClient = {
  rpc: <T>(name: string, args: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
};

type PreparedDirectRun = {
  directRunId?: string;
  conversationId?: string;
  modelAlias?: string;
  mode?: string;
};

type StoredMessage = { role: string; content: unknown; created_at: string };
type CompletionBody = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
};

function schemaPending(message: string) {
  return /prepare_direct_model_run|complete_direct_model_run|Could not find the function|PGRST202/i.test(message);
}

function safeFailureCode(value: unknown) {
  const text = value instanceof Error ? value.message : String(value ?? "direct_model_failed");
  return text.replace(/[^a-zA-Z0-9_.:-]+/g, "_").slice(0, 120) || "direct_model_failed";
}

async function failDirectRun(admin: RpcClient, directRunId: string | null, code: string) {
  if (!directRunId) return;
  try {
    await admin.rpc<boolean>("fail_direct_model_run", {
      target_direct_run_id: directRunId,
      target_failure_code: code
    });
  } catch {
    // The original failure remains the canonical error. A failed audit update
    // must not mask the inference/runtime error returned to the caller.
  }
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const body = await request.json().catch(() => null) as {
    workspaceId?: string;
    conversationId?: string | null;
    mode?: string;
    prompt?: string;
  } | null;

  const workspaceId = body?.workspaceId?.trim() ?? "";
  const conversationId = body?.conversationId?.trim() || null;
  const mode = body?.mode?.trim() ?? "";
  const prompt = body?.prompt?.trim() ?? "";
  if (!uuidPattern.test(workspaceId) || (conversationId && !uuidPattern.test(conversationId)) || !modes.has(mode) || prompt.length < 1 || prompt.length > 100_000) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const requestId = crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id")?.trim() || crypto.randomUUID();
  const rpc = supabase as unknown as RpcClient;
  const admin = createSupabaseAdminClient() as unknown as RpcClient;
  let directRunId: string | null = null;

  try {
    const prepared = await rpc.rpc<PreparedDirectRun>("prepare_direct_model_run", {
      target_workspace_id: workspaceId,
      target_conversation_id: conversationId,
      target_mode: mode,
      target_prompt: prompt,
      target_request_id: requestId,
      target_trace_id: traceId
    });

    if (prepared.error) {
      if (schemaPending(prepared.error.message)) {
        return NextResponse.json({ error: "direct_model_schema_pending", requestId }, { status: 503 });
      }
      const subscription = /subscription_access_required/.test(prepared.error.message);
      const denied = /permission_denied|workspace_access_denied|conversation_access_denied/.test(prepared.error.message);
      const conflict = /conversation_has_active_run|conversation_mode_mismatch/.test(prepared.error.message);
      return NextResponse.json(
        { error: subscription ? "subscription_required" : denied ? "access_denied" : conflict ? "conversation_busy" : "direct_model_prepare_failed", requestId },
        { status: subscription ? 402 : denied ? 403 : conflict ? 409 : 500 }
      );
    }

    const preparedRun = prepared.data;
    if (!preparedRun?.directRunId || !preparedRun.conversationId || !preparedRun.modelAlias) {
      return NextResponse.json({ error: "direct_model_prepare_failed", requestId }, { status: 500 });
    }
    directRunId = preparedRun.directRunId;

    const { data: storedMessages, error: messagesError } = await supabase
      .from("messages")
      .select("role,content,created_at")
      .eq("conversation_id", preparedRun.conversationId)
      .order("created_at", { ascending: false })
      .limit(80);

    if (messagesError) throw new Error("direct_model_history_load_failed");
    const history = (storedMessages ?? []) as StoredMessage[];
    history.reverse();
    const messages = buildDirectModelMessages(history);

    const alias = runtimeAliasForMode(mode as "chat" | "code" | "lab" | "research");
    if (alias !== preparedRun.modelAlias) throw new Error("direct_model_alias_mismatch");
    const ensured = await ensureModelRuntime(alias);
    const endpoint = ensured.instance.endpoint.replace(/\/$/, "");
    const apiKey = directInferenceApiKey();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const upstream = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: directRuntimeModelName(),
        messages,
        temperature: 0.2,
        max_tokens: 4096,
        stream: false,
        reasoning_effort: "none",
        cache_prompt: true,
        chat_template_kwargs: { enable_thinking: false }
      })
    });

    const completion = await upstream.json().catch(() => ({})) as CompletionBody;
    if (!upstream.ok) {
      const detail = typeof completion.error === "string" ? completion.error : completion.error?.message;
      throw new Error(detail ? `direct_model_upstream_${upstream.status}:${detail}` : `direct_model_upstream_${upstream.status}`);
    }

    const rawText = completion.choices?.[0]?.message?.content ?? "";
    const outputText = stripThinking(rawText);
    if (!outputText) throw new Error("direct_model_empty_output");
    const inputTokens = Math.max(0, Math.trunc(Number(completion.usage?.prompt_tokens ?? 0)));
    const outputTokens = Math.max(0, Math.trunc(Number(completion.usage?.completion_tokens ?? 0)));

    const completed = await admin.rpc<Record<string, unknown>>("complete_direct_model_run", {
      target_direct_run_id: directRunId,
      target_output_text: outputText,
      target_input_tokens: inputTokens,
      target_output_tokens: outputTokens
    });
    if (completed.error) throw new Error(schemaPending(completed.error.message) ? "direct_model_schema_pending" : "direct_model_persist_failed");

    return NextResponse.json({
      conversationId: preparedRun.conversationId,
      directRunId,
      modelAlias: preparedRun.modelAlias,
      message: outputText,
      usage: { inputTokens, outputTokens },
      requestId,
      traceId
    });
  } catch (error) {
    const failureCode = safeFailureCode(error);
    await failDirectRun(admin, directRunId, failureCode);
    const warming = /warming|provision|unhealthy|fetch failed|ECONNREFUSED|UND_ERR_CONNECT/i.test(error instanceof Error ? error.message : String(error));
    const pending = /direct_model_schema_pending/.test(error instanceof Error ? error.message : String(error));
    console.error("[direct-model] failed", { requestId, directRunId, failureCode });
    return NextResponse.json(
      { error: pending ? "direct_model_schema_pending" : warming ? "runtime_warming" : "direct_model_failed", requestId, directRunId },
      { status: pending || warming ? 503 : 502 }
    );
  }
}
