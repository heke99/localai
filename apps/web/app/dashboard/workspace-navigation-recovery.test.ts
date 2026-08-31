import { describe, expect, it } from "vitest";
import { dashboardRecoveryRequest, upsertRecoveredConversation, withoutProvisionalRun } from "./workspace-navigation-recovery";

describe("dashboard navigation recovery", () => {
  it("recovers a new conversation and provisional run when the server snapshot is stale", () => {
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

  it("revalidates a run even when its conversation is already in the snapshot", () => {
    expect(dashboardRecoveryRequest(
      "?section=lab&conversation=11111111-1111-4111-8111-111111111111&run=22222222-2222-4222-8222-222222222222",
      ["11111111-1111-4111-8111-111111111111"]
    )).toEqual({
      conversationId: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      section: "lab"
    });
  });

  it("skips recovery for a known conversation when no provisional run exists", () => {
    expect(dashboardRecoveryRequest(
      "?section=lab&conversation=11111111-1111-4111-8111-111111111111",
      ["11111111-1111-4111-8111-111111111111"]
    )).toBeNull();
  });

  it("removes only the provisional run from dashboard navigation", () => {
    expect(withoutProvisionalRun("?section=lab&conversation=abc&run=stale&provider=github"))
      .toBe("?section=lab&conversation=abc&provider=github");
  });

  it("upserts the recovered conversation without creating duplicates", () => {
    const recovered = { id: "new", mode: "lab" };
    expect(upsertRecoveredConversation([{ id: "old", mode: "chat" }, { id: "new", mode: "chat" }], recovered)).toEqual([
      { id: "new", mode: "lab" },
      { id: "old", mode: "chat" }
    ]);
  });
});
