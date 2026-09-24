import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { alertForTransition, type PushState } from "./SelfHostedPush.ts";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const base = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
  projectTitle: "Project",
  threadTitle: "Fix login",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "2026-09-24T11:59:30.000Z",
  deepLink: "/threads/environment-a/thread-a",
  runId: TurnId.make("run-a"),
} satisfies PushState;

describe("self-hosted push alert transitions", () => {
  it("alerts on an approval and a fresh completion after work", () => {
    const approval = { ...base, phase: "waiting_for_approval", headline: "Approval" } as const;
    const completed = { ...base, phase: "completed", headline: "Done" } as const;
    expect(alertForTransition(base, approval, NOW)).toEqual({
      title: "Approval: Project",
      body: "Fix login",
      deepLink: "/threads/environment-a/thread-a",
    });
    expect(alertForTransition(base, completed, NOW)).toEqual({
      title: "Done: Project",
      body: "Fix login",
      deepLink: "/threads/environment-a/thread-a",
    });
  });

  it("does not alert on replay, attention switching, stale completion, or repeated phase", () => {
    const approval = { ...base, phase: "waiting_for_approval" } as const;
    const input = { ...base, phase: "waiting_for_input" } as const;
    const completed = { ...base, phase: "completed" } as const;
    expect(alertForTransition(undefined, completed, NOW)).toBeNull();
    expect(alertForTransition(approval, input, NOW)).toBeNull();
    expect(alertForTransition(completed, completed, NOW)).toBeNull();
    expect(
      alertForTransition(base, { ...completed, updatedAt: "2026-09-24T11:55:00.000Z" }, NOW),
    ).toBeNull();
  });

  it("alerts when a new run completes before its running state drains", () => {
    const completedA = { ...base, phase: "completed", headline: "Done" } as const;
    const completedB = { ...completedA, runId: TurnId.make("run-b") } as const;
    expect(alertForTransition(completedA, completedB, NOW)).toEqual({
      title: "Done: Project",
      body: "Fix login",
      deepLink: "/threads/environment-a/thread-a",
    });
    expect(
      alertForTransition(completedB, { ...completedB, threadTitle: "Renamed" }, NOW),
    ).toBeNull();
    expect(alertForTransition({ ...completedA, runId: null }, completedB, NOW)).not.toBeNull();
  });
});
