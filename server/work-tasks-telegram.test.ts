import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkTaskStore } from "./work-tasks.ts";
import { TelegramBridgeService } from "./work-tasks-telegram.ts";
import type { WorkTaskDispatcher } from "./work-tasks-runtime.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

const tempDirs: string[] = [];

function createTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "looma-tg-"));
  tempDirs.push(dir);
  return new WorkTaskStore({ file: join(dir, "work-tasks.json") });
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("TelegramBridgeService (Levels 1, 2 & 3)", () => {
  const room = {
    id: "room-1",
    name: "Core Team",
    dm: false,
    memberIds: ["dev-1", "qa-1"],
    defaultResponder: { kind: "member", botId: "dev-1" },
  } as unknown as GroupRecord;

  const bots: Record<string, BotRecord> = {
    "dev-1": { id: "dev-1", name: "Coder", title: "Software Engineer" } as unknown as BotRecord,
    "qa-1": { id: "qa-1", name: "Quinn", title: "QA Reviewer" } as unknown as BotRecord,
  };

  it("handles Level 1 queries, /myid, Allowed Chat ID guard, Level 2 push alerts, and Level 3 /run /qa /comment", async () => {
    const store = createTempStore();
    store.saveTelegramConfig({
      enabled: true,
      botToken: "123456:TEST_TOKEN",
      allowedChatIds: ["999001"],
      notifyOnBlocked: true,
      notifyOnBudgetExceeded: true,
      notifyOnDone: true,
      notifyOnRework: true,
      allowRemoteActions: true,
    });

    const sent: Array<{ chat_id: string; text: string }> = [];
    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/getMe")) {
        return new Response(JSON.stringify({ ok: true, result: { username: "LoomaTestBot" } }), { status: 200 });
      }
      if (url.endsWith("/sendMessage")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; text: string };
        sent.push(body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as typeof fetch;

    const dispatched: Array<{ botId: string; prompt: string }> = [];
    const dispatcher: WorkTaskDispatcher = {
      dispatchToBot: async (params) => {
        dispatched.push({ botId: params.botId, prompt: params.prompt });
        return { ok: true, threadId: `th-${params.botId}-${dispatched.length}`, botId: params.botId };
      },
    };

    const tg = new TelegramBridgeService({
      store,
      dispatcher,
      group: (id) => (id === "room-1" ? room : undefined),
      groups: () => [room],
      botLookup: (id) => bots[id],
      fetchImpl: mockFetch,
    });

    // Test getMe connection check
    const conn = await tg.testConnection();
    expect(conn.ok).toBe(true);
    expect(conn.botUsername).toBe("LoomaTestBot");

    const { task } = store.create(
      {
        roomId: "room-1",
        title: "Build Telegram polling",
        assigneeBotId: "dev-1",
        assigneeName: "Coder",
        budgetUsd: 0.05,
      },
      { actorType: "user", actorName: "Owner" },
    );

    // Unauthorized chat is blocked on /status, but allowed on /myid
    const denied = await tg.handleUpdate({
      update_id: 1,
      message: { text: "/status", chat: { id: "888888" }, from: { first_name: "Stranger" } },
    });
    expect(denied.text).toContain("chưa được cấp quyền");

    const myid = await tg.handleUpdate({
      update_id: 2,
      message: { text: "/myid", chat: { id: "888888" } },
    });
    expect(myid.text).toContain("888888");

    // Level 1: Authorized /status@LoomaTestBot
    const statusRes = await tg.handleUpdate({
      update_id: 3,
      message: { text: "/status@LoomaTestBot", chat: { id: "999001" }, from: { username: "trung" } },
    });
    expect(statusRes.text).toContain(task.key);
    expect(statusRes.text).toContain("Core Team");

    // Level 3: /run <KEY> dispatches task to Coder
    const runRes = await tg.handleUpdate({
      update_id: 4,
      message: { text: `/run ${task.key} Focus on clean error handling`, chat: { id: "999001" }, from: { first_name: "Trung" } },
    });
    expect(runRes.text).toContain("Đã khởi chạy");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.botId).toBe("dev-1");
    expect(store.get(task.id)?.status).toBe("in-progress");

    // Level 3: /comment <KEY> adds comment to task
    const commentRes = await tg.handleUpdate({
      update_id: 5,
      message: { text: `/comment ${task.key} Nhớ test cả timeout`, chat: { id: "999001" }, from: { first_name: "Trung" } },
    });
    expect(commentRes.text).toContain("Đã thêm bình luận");
    expect(store.activities(task.id).some((a) => a.message.includes("Nhớ test cả timeout"))).toBe(true);

    // Level 3: /qa <KEY> dispatches QA agent when task is in-review
    store.transition(task.id, "in-review", { actorType: "agent", actorId: "dev-1", actorName: "Coder" });
    const qaRes = await tg.handleUpdate({
      update_id: 6,
      message: { text: `/qa ${task.key}`, chat: { id: "999001" }, from: { first_name: "Trung" } },
    });
    expect(qaRes.text).toContain("QA Agent");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]?.botId).toBe("qa-1");

    // Level 2: Budget exceeded automatically pushes Telegram alert to 999001
    sent.length = 0;
    store.recordUsage(task.id, { inputTokens: 1000, outputTokens: 1000, costUsd: 0.08, botId: "dev-1", botName: "Coder" });
    await new Promise((r) => setTimeout(r, 15));
    expect(sent.some((m) => m.chat_id === "999001" && m.text.includes("VƯỢT NGÂN SÁCH"))).toBe(true);

    // Level 2: Done pushes completion alert
    sent.length = 0;
    store.transition(task.id, "done", { actorType: "agent", actorId: "qa-1", actorName: "Quinn", isQa: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(sent.some((m) => m.chat_id === "999001" && m.text.includes("HOÀN THÀNH"))).toBe(true);

    tg.dispose();
  });
});
