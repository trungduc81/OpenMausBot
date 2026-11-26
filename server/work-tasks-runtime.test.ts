import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkTaskStore } from "./work-tasks.ts";
import {
  MAX_AUTO_REWORK_LOOPS,
  dispatchWorkTaskRun,
  maybeTriggerAutoRework,
  type WorkTaskDispatcher,
} from "./work-tasks-runtime.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

const tempDirs: string[] = [];

function createTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "looma-wt-rt-"));
  tempDirs.push(dir);
  return new WorkTaskStore({ file: join(dir, "work-tasks.json") });
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("work-tasks runtime: Run Task, Auto-QA, Budget & Timeline", () => {
  const room = {
    id: "room-1",
    name: "Engineering",
    memberIds: ["dev-1", "qa-1"],
    defaultResponder: { kind: "member", botId: "dev-1" },
  } as unknown as GroupRecord;

  const bots: Record<string, BotRecord> = {
    "dev-1": { id: "dev-1", name: "Coder", title: "Software Engineer" } as unknown as BotRecord,
    "qa-1": { id: "qa-1", name: "Quinn", title: "QA Reviewer" } as unknown as BotRecord,
  };

  it("tracks task usage, enforces budget cap, and records timeline events", async () => {
    const store = createTempStore();
    const { task } = store.create(
      {
        roomId: "room-1",
        title: "Build auth endpoint",
        assigneeBotId: "dev-1",
        assigneeName: "Coder",
        budgetUsd: 0.10,
      },
      { actorType: "user", actorName: "Owner" },
    );

    const first = store.recordUsage(task.id, {
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.04,
      model: "claude-sonnet",
      botId: "dev-1",
      botName: "Coder",
    });
    expect(first?.exceededNow).toBe(false);
    expect(first?.task.usage?.costUsd).toBe(0.04);

    const second = store.recordUsage(task.id, {
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.08,
      model: "claude-sonnet",
      botId: "dev-1",
      botName: "Coder",
    });
    expect(second?.exceededNow).toBe(true);
    expect(second?.task.needsUserAction).toBe(true);

    const timeline = store.listRoomTimeline("room-1");
    expect(timeline[0]?.type).toBe("budget-exceeded");
    expect(timeline[0]?.taskKey).toBe(task.key);
    expect(timeline[0]?.costUsd).toBeCloseTo(0.12, 4);

    const dispatcher: WorkTaskDispatcher = {
      dispatchToBot: async () => ({ ok: true, threadId: "t-1" }),
    };
    await expect(
      dispatchWorkTaskRun({
        workTasks: store,
        group: (id) => (id === "room-1" ? room : undefined),
        botLookup: (id) => bots[id],
        dispatcher,
        taskId: task.id,
        actor: { actorType: "user", actorName: "Owner" },
      }),
    ).rejects.toThrow(/budget cap/i);
  });

  it("dispatches task from board, settles into Auto-QA review, and caps Auto-Rework loops", async () => {
    const store = createTempStore();
    const { task } = store.create(
      {
        roomId: "room-1",
        title: "Implement billing webhook",
        assigneeBotId: "dev-1",
        assigneeName: "Coder",
        acceptanceCriteria: ["Verify HMAC signature", "Pass unit tests"],
      },
      { actorType: "user", actorName: "Owner" },
    );

    const dispatches: Array<{ botId: string; prompt: string; onSettled?: (o: { ok: boolean; text: string }) => void }> = [];
    const dispatcher: WorkTaskDispatcher = {
      dispatchToBot: async (params) => {
        dispatches.push({ botId: params.botId, prompt: params.prompt, onSettled: params.onSettled });
        return { ok: true, threadId: `thread-${params.botId}-${dispatches.length}`, botId: params.botId };
      },
    };

    const runRes = await dispatchWorkTaskRun({
      workTasks: store,
      group: (id) => (id === "room-1" ? room : undefined),
      botLookup: (id) => bots[id],
      dispatcher,
      taskId: task.id,
      actor: { actorType: "user", actorName: "Owner" },
    });

    expect(runRes.ok).toBe(true);
    expect(store.get(task.id)?.status).toBe("in-progress");
    expect(dispatches[0]?.botId).toBe("dev-1");
    expect(dispatches[0]?.prompt).toContain("Verify HMAC signature");

    // Worker completes -> automatically transitions to in-review and dispatches Auto-QA to qa-1
    dispatches[0]?.onSettled?.({ ok: true, text: "Implemented and tested HMAC verification." });
    await new Promise((r) => setTimeout(r, 15));

    expect(store.get(task.id)?.status).toBe("in-review");
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]?.botId).toBe("qa-1");
    expect(dispatches[1]?.prompt).toContain("Auto-QA Review");

    // Simulate MAX_AUTO_REWORK_LOOPS rework cycles and verify loop cap halts automatic rework
    for (let i = 1; i <= MAX_AUTO_REWORK_LOOPS; i++) {
      store.transition(task.id, "rework", { actorType: "agent", actorId: "qa-1", actorName: "Quinn", isQa: true });
      const rw = await maybeTriggerAutoRework({
        workTasks: store,
        group: (id) => (id === "room-1" ? room : undefined),
        botLookup: (id) => bots[id],
        dispatcher,
        taskId: task.id,
        reason: `Fix issue #${i}`,
      });
      expect(rw.dispatched).toBe(true);
      expect(rw.reworkCount).toBe(i);
      store.transition(task.id, "in-review", { actorType: "agent", actorId: "dev-1", actorName: "Coder" });
    }

    // One more rework should be blocked by MAX_AUTO_REWORK_LOOPS
    store.transition(task.id, "rework", { actorType: "agent", actorId: "qa-1", actorName: "Quinn", isQa: true });
    const capped = await maybeTriggerAutoRework({
      workTasks: store,
      group: (id) => (id === "room-1" ? room : undefined),
      botLookup: (id) => bots[id],
      dispatcher,
      taskId: task.id,
      reason: "Still failing",
    });
    expect(capped.dispatched).toBe(false);
    expect(capped.reason).toBe("max_rework_reached");
    expect(store.get(task.id)?.needsUserAction).toBe(true);
  });
});
