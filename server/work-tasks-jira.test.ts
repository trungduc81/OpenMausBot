import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkTaskStore } from "./work-tasks.ts";
import { JiraSyncService } from "./work-tasks-jira.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "looma-jira-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("JiraSyncService bidirectional sync, logical assignee & resilience", () => {
  it("pushes issue with logical agent custom field, labels, attributed comments, and prevents echo/stale loops", async () => {
    const dir = tempDir();
    let clock = 1_700_000_000_000;
    const store = new WorkTaskStore({ file: join(dir, "work-tasks.json"), now: () => (clock += 1000) });

    store.saveRoomJiraConfig("room-1", {
      enabled: true,
      baseUrl: "https://acme.atlassian.net",
      email: "bot@acme.com",
      apiToken: "secret-jira-token",
      projectKey: "PROJ",
      issueType: "Task",
      assigneeCustomFieldId: "customfield_10042",
      autoSync: true,
    });

    const { task } = store.create(
      {
        roomId: "room-1",
        title: "Build Auth Service",
        assigneeBotId: "backend",
        assigneeName: "Backend-Agent",
        assigneeRole: "Backend Engineer",
        coordinatorBotId: "coord",
      },
      { actorType: "agent", actorId: "coord", actorName: "Coordinator", isCoordinator: true },
    );

    const calls: Array<{ url: string; method: string; body: any }> = [];
    let failMode = false;
    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });

      if (failMode) {
        return new Response(JSON.stringify({ errorMessages: ["Jira temporary 503"] }), { status: 503 });
      }
      if (url.endsWith("/rest/api/3/issue") && method === "POST") {
        return new Response(JSON.stringify({ id: "10001", key: "PROJ-42" }), { status: 201 });
      }
      if (url.includes("/transitions") && method === "GET") {
        return new Response(
          JSON.stringify({ transitions: [{ id: "31", name: "In Progress", to: { name: "In Progress" } }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const jira = new JiraSyncService({ store, fetchImpl: mockFetch, now: () => (clock += 1000) });

    const created = await jira.createIssueForTask(task.id);
    expect(created.ok).toBe(true);
    expect(created.task?.jiraSync?.issueKey).toBe("PROJ-42");

    // Verify logical agent custom field and labels were sent (never Jira Assignee)
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/rest/api/3/issue"));
    expect(createCall?.body.fields.customfield_10042).toBe("Backend-Agent (Backend Engineer)");
    expect(createCall?.body.fields.labels).toContain("looma-agent:Backend-Agent");
    expect(createCall?.body.fields.assignee).toBeUndefined();

    // Sync a comment with attributed logical agent
    store.transition(task.id, "in-progress", {
      actorType: "agent",
      actorId: "backend",
      actorName: "Backend-Agent",
      actorRole: "Backend Engineer",
    });
    const synced = await jira.syncTaskToJira(task.id, "Auth tests passed", {
      name: "Backend-Agent",
      role: "Backend Engineer",
      type: "agent",
    });
    expect(synced.ok).toBe(true);
    const commentCall = calls.find((c) => c.url.includes("/comment"));
    expect(JSON.stringify(commentCall?.body)).toContain("[Backend-Agent (Backend Engineer) via LOOMA]: Auth tests passed");

    // Jira echo webhook with LOOMA-authored comment must be ignored
    const echo = jira.handleWebhook({
      issue: {
        key: "PROJ-42",
        fields: {
          updated: new Date(clock + 1000).toISOString(),
          status: { name: "In Progress" },
        },
      },
      comment: {
        body: "[Backend-Agent (Backend Engineer) via LOOMA]: Auth tests passed",
      },
    });
    expect(echo.handled).toBe(false);

    // Stale Jira webhook older than local LOOMA task update must NOT overwrite local state
    const stale = jira.handleWebhook({
      issue: {
        key: "PROJ-42",
        fields: {
          updated: new Date(clock - 500_000).toISOString(),
          status: { name: "Backlog" },
        },
      },
    });
    expect(stale.handled).toBe(false);
    expect(store.get(task.id)?.status).toBe("in-progress");

    // Fault tolerance: if Jira goes down, LOOMA local mutation persists & retry succeeds later
    failMode = true;
    store.transition(task.id, "in-review", {
      actorType: "agent",
      actorId: "backend",
      actorName: "Backend-Agent",
    });
    const failedSync = await jira.syncTaskToJira(task.id);
    expect(failedSync.ok).toBe(false);
    expect(store.get(task.id)?.status).toBe("in-review"); // local status preserved!
    expect(store.get(task.id)?.jiraSync?.lastError).toContain("503");

    failMode = false;
    const retried = await jira.syncTaskToJira(task.id);
    expect(retried.ok).toBe(true);
    expect(store.get(task.id)?.jiraSync?.lastError).toBeUndefined();
  });

  it("syncs subtasks bidirectionally (LOOMA -> Jira Sub-task, Jira -> LOOMA pull & webhook) and assigns room bots", async () => {
    const dir = tempDir();
    let clock = 1_700_000_000_000;
    const store = new WorkTaskStore({ file: join(dir, "work-tasks.json"), now: () => (clock += 1000) });

    store.saveRoomJiraConfig("room-1", {
      enabled: true,
      baseUrl: "https://acme.atlassian.net",
      email: "bot@acme.com",
      apiToken: "secret-jira-token",
      projectKey: "PROJ",
      issueType: "Task",
      assigneeCustomFieldId: "customfield_10042",
      autoSync: true,
    });

    const { task: parent } = store.create(
      { roomId: "room-1", title: "Release v2", assigneeBotId: "coord", assigneeName: "Coordinator" },
      { actorType: "user", actorName: "Owner" },
    );

    const calls: Array<{ url: string; method: string; body: any }> = [];
    const mockFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });

      if (url.endsWith("/rest/api/3/issue") && method === "POST") {
        if (body.fields.issuetype?.name === "Sub-task") {
          // Simulate team-managed project expecting "Subtask" instead of "Sub-task"
          return new Response(JSON.stringify({ errors: { issuetype: "Invalid issue type" } }), { status: 400 });
        }
        if (body.fields.issuetype?.name === "Subtask") {
          return new Response(JSON.stringify({ id: "20002", key: "PROJ-101" }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: "20001", key: "PROJ-100" }), { status: 201 });
      }
      if (url.includes("/rest/api/3/issue/PROJ-100?")) {
        return new Response(
          JSON.stringify({
            key: "PROJ-100",
            fields: {
              summary: "[LOOMA-101] Release v2",
              status: { name: "In Progress" },
              priority: { name: "High" },
              updated: new Date(clock + 10_000).toISOString(),
              subtasks: [{ id: "20003", key: "PROJ-102" }],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/rest/api/3/issue/PROJ-102?")) {
        return new Response(
          JSON.stringify({
            key: "PROJ-102",
            fields: {
              summary: "Write migration script",
              description: "Run DB migration cleanly",
              status: { name: "To Do" },
              priority: { name: "High" },
              labels: ["looma-agent:Backend-Agent"],
              updated: new Date(clock + 10_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const jira = new JiraSyncService({
      store,
      fetchImpl: mockFetch,
      now: () => (clock += 1000),
      resolveRoomBot: (_roomId, hint) => {
        if (hint.toLowerCase().includes("backend")) {
          return { id: "backend", name: "Backend-Agent", title: "Backend Engineer" };
        }
        if (hint.toLowerCase().includes("qa")) {
          return { id: "qa", name: "QA-Agent", title: "QA Reviewer" };
        }
        return undefined;
      },
    });

    // 1. Push parent task to Jira -> PROJ-100
    const parentRes = await jira.createIssueForTask(parent.id);
    expect(parentRes.ok).toBe(true);
    expect(parentRes.task?.jiraSync?.issueKey).toBe("PROJ-100");

    // 2. Create manual subtask in LOOMA and push -> becomes Jira Subtask with parent PROJ-100
    const { task: localSub } = store.create(
      { roomId: "room-1", parentTaskId: parent.id, type: "subtask", title: "Build UI", assigneeBotId: "backend", assigneeName: "Backend-Agent" },
      { actorType: "user", actorName: "Owner" },
    );
    const subRes = await jira.createIssueForTask(localSub.id);
    expect(subRes.ok).toBe(true);
    expect(subRes.task?.jiraSync?.issueKey).toBe("PROJ-101");
    const subPost = calls.find((c) => c.method === "POST" && c.body?.fields?.issuetype?.name === "Subtask");
    expect(subPost?.body.fields.parent).toEqual({ key: "PROJ-100" });

    // 3. Pull from Jira using API token -> imports manually created Jira subtask PROJ-102 and assigns Backend-Agent
    const pulled = await jira.pullFromJira(parent.id);
    expect(pulled.ok).toBe(true);
    expect(pulled.createdSubtasks).toHaveLength(1);
    expect(pulled.createdSubtasks[0]?.title).toBe("Write migration script");
    expect(pulled.createdSubtasks[0]?.parentTaskId).toBe(parent.id);
    expect(pulled.createdSubtasks[0]?.assigneeBotId).toBe("backend");

    // 4. Incoming Jira webhook for another manually created subtask PROJ-103 -> auto-imported & assigned to QA-Agent
    const webhookRes = jira.handleWebhook({
      issue: {
        id: "20004",
        key: "PROJ-103",
        fields: {
          summary: "Verify release checklist",
          parent: { key: "PROJ-100" },
          status: { name: "To Do" },
          priority: { name: "Medium" },
          customfield_10042: "QA-Agent (QA Reviewer)",
          updated: new Date(clock + 20_000).toISOString(),
        },
      },
    });
    expect(webhookRes.handled).toBe(true);
    expect(webhookRes.task?.type).toBe("subtask");
    expect(webhookRes.task?.parentTaskId).toBe(parent.id);
    expect(webhookRes.task?.assigneeBotId).toBe("qa");
  });
});
