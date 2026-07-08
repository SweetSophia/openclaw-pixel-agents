import { describe, expect, it } from "vitest";
import type { AgentState } from "../shared/types";
import { applyAgentSnapshot } from "./agentSnapshots";

function agent(id: string, activity: AgentState["activity"] = "idle"): AgentState {
  return {
    id,
    name: id,
    activity,
    model: "test/model",
    sessionKey: `${id}-session`,
    active: activity !== "sleeping",
    lastActivity: 123,
    pixelEnabled: true,
    tags: [],
  };
}

describe("applyAgentSnapshot", () => {
  it("replaces the current snapshot when the source succeeds", () => {
    const current = new Map([["old", agent("old")]]);
    const next = new Map([["new", agent("new", "typing")]]);

    const result = applyAgentSnapshot(current, next);

    expect(result.applied).toBe(true);
    expect(current.has("old")).toBe(false);
    expect(current.get("new")?.activity).toBe("typing");
    expect(result.snapshot).toEqual([{ ...agent("new", "typing") }]);
  });

  it("returns deep-cloned snapshots", () => {
    const current = new Map<string, AgentState>();
    const next = new Map([["old", { ...agent("old"), tags: ["coding" as const] }]]);
    const result = applyAgentSnapshot(current, next);

    result.snapshot[0].tags.push("logic");

    expect(current.get("old")?.tags).toEqual(["coding"]);
  });

  it("applies an empty snapshot when the source succeeds", () => {
    const current = new Map([["old", agent("old", "typing")]]);
    const next = new Map<string, AgentState>();

    const result = applyAgentSnapshot(current, next);

    expect(result.applied).toBe(true);
    expect(current.size).toBe(0);
    expect(result.snapshot).toEqual([]);
  });

  it("keeps the previous non-empty snapshot when the source errors", () => {
    const current = new Map([["old", agent("old", "typing")]]);
    const next = new Map([["new", agent("new", "sleeping")]]);

    const result = applyAgentSnapshot(current, next, { sourceError: true });

    expect(result.applied).toBe(false);
    expect(current.has("new")).toBe(false);
    expect(current.get("old")?.activity).toBe("typing");
    expect(result.snapshot).toEqual([{ ...agent("old", "typing") }]);
  });

  it("allows an empty first snapshot when there is no previous data to preserve", () => {
    const current = new Map<string, AgentState>();

    const result = applyAgentSnapshot(current, undefined, { sourceError: true });

    expect(result.applied).toBe(true);
    expect(result.snapshot).toEqual([]);
  });
});
