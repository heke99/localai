import { describe, expect, it } from "vitest";
import { dashboardRecoveryRequest, upsertRecoveredConversation } from "./workspace-navigation-recovery";

describe("dashboard navigation recovery", () => {
  it("preserves a new conversation and run from the URL when the server snapshot is stale", () => {
    const request = dashboardRecoveryRequest(
      "?section=lab&conversation=11111111-1111-4111-8111-111111111111&run=22222222-2222-4222-8222-222222222222",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]
    );

    expect(request).toEqual({
      conversationId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      section: "lab"
    });
  });

  it("does not perform an authoritative recovery when the snapshot already contains the conversation", () => {
    expect(dashboardRecoveryRequest(
      "?section=lab&conversation=11111111-1111-4111-8111-111111111111&run=22222222-2222-4222-8222-222222222222",
      ["11111111-1111-4111-8111-111111111111"]
    )).toBeNull();
  });

  it("upserts the recovered conversation without creating duplicates", () => {
    const recovered = { id: "new", mode: "lab" };
    expect(upsertRecoveredConversation([{ id: "old", mode: "chat" }, { id: "new", mode: "chat" }], recovered)).toEqual([
      { id: "new", mode: "lab" },
      { id: "old", mode: "chat" }
    ]);
  });
});
