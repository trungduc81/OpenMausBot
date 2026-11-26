import type { CoordinateBotsCall, HandoffView } from "./coordinator.ts";
import { isQaBot, isTaskOverBudget, type AgentTask } from "../shared/work-tasks.ts";
import { chiefLevel } from "./chief-level.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";
import type { JiraSyncService } from "./work-tasks-jira.ts";
import { WorkTaskError, type WorkTaskActor, type WorkTaskStore } from "./work-tasks.ts";

export const MAX_AUTO_REWORK_LOOPS = 3;

export interface WorkTaskDispatchResult {
  ok: boolean;
  threadId?: string;
  botId?: string;
  botName?: string;
  error?: string;
}

export interface WorkTaskDispatcher {
  dispatchToBot: (params: {
    botId: string;
    roomId: string;
    existingThreadId?: string;
    threadTitle: string;
    prompt: string;
    onSettled?: (outcome: { ok: boolean; text: string }) => void;
  }) => Promise<WorkTaskDispatchResult>;
}

function botActor(bot: BotRecord | null | undefined, fallbackId: string, roomDefaultResponderId?: string): WorkTaskActor {
  if (!bot) {
    return { actorType: "agent", actorId: fallbackId, actorName: fallbackId, actorRole: "Worker" };
  }
  const isCoordinator = chiefLevel(bot) || roomDefaultResponderId === bot.id;
  const isQa = isQaBot(bot);
  const actorRole = bot.title?.trim() || (isCoordinator ? "Coordinator" : isQa ? "QA" : "Worker");
  return {
    actorType: "agent",
    actorId: bot.id,
    actorName: bot.name,
    actorRole,
    isCoordinator,
    isQa,
  };
}

function triggerAutoJira(workTasks: WorkTaskStore, jira: JiraSyncService | undefined, task: AgentTask | undefined): void {
  if (!jira || !task?.jiraSync?.issueKey) return;
  const cfg = workTasks.getRoomJiraConfig(task.roomId);
  if (!cfg.enabled || !cfg.autoSync) return;
  void jira.syncTaskToJira(task.id).catch((err) => {
    console.warn(`[work-tasks] Jira auto-sync failed for ${task.key}:`, err instanceof Error ? err.message : err);
  });
}

export function resolveQaBotForTask(
  task: AgentTask,
  room: GroupRecord | undefined,
  botLookup: (id: string) => BotRecord | undefined,
): BotRecord | undefined {
  if (task.qaBotId) {
    const explicit = botLookup(task.qaBotId);
    if (explicit && explicit.id !== task.assigneeBotId) return explicit;
  }
  if (!room) return undefined;
  for (const id of room.memberIds) {
    if (id === task.assigneeBotId) continue;
    const member = botLookup(id);
    if (member && isQaBot(member, task)) return member;
  }
  return undefined;
}

export function buildWorkTaskPrompt(task: AgentTask, extraPrompt?: string, reworkReason?: string): string {
  const lines: string[] = [
    `[Work Task ${task.key}] ${task.title}`,
    `Priority: ${task.priority} | Type: ${task.type}`,
  ];
  if (task.description?.trim()) {
    lines.push("", "Description:", task.description.trim());
  }
  if (task.acceptanceCriteria?.length) {
    lines.push("", "Acceptance Criteria:", ...task.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`));
  }
  if (reworkReason?.trim()) {
    lines.push("", "QA Rework Feedback (address all points):", reworkReason.trim());
  }
  if (extraPrompt?.trim()) {
    lines.push("", "Additional Instructions:", extraPrompt.trim());
  }
  lines.push(
    "",
    `When finished, attach concrete evidence using work task tools (taskId: "${task.key}") and move status to "in-review".`,
  );
  return lines.join("\n");
}

export function buildQaReviewPrompt(task: AgentTask, workerSummary?: string): string {
  const lines: string[] = [
    `[Auto-QA Review for ${task.key}] ${task.title}`,
    `Assigned worker: ${task.assigneeName ?? task.assigneeBotId ?? "Unknown"}`,
  ];
  if (task.description?.trim()) {
    lines.push("", "Task Description:", task.description.trim());
  }
  if (task.acceptanceCriteria?.length) {
    lines.push("", "Acceptance Criteria to Verify:", ...task.acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`));
  }
  if (task.evidence?.length) {
    lines.push(
      "",
      "Submitted Evidence:",
      ...task.evidence.slice(-8).map((ev) => `- [${ev.type}] ${ev.label}: ${ev.value}`),
    );
  }
  if (workerSummary?.trim()) {
    lines.push("", "Worker Final Output:", workerSummary.trim().slice(0, 2000));
  }
  lines.push(
    "",
    `Verify the work against every acceptance criterion. Update task "${task.key}" via work task tools:`,
    `- If everything passes, set status to "done" with a brief verification note.`,
    `- If anything fails or is missing, set status to "rework" with clear, actionable feedback in statusNote.`,
  );
  return lines.join("\n");
}

export async function maybeTriggerAutoQaReview(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  group: (id: string) => GroupRecord | undefined;
  botLookup: (id: string) => BotRecord | undefined;
  dispatcher?: WorkTaskDispatcher;
  taskId: string;
  workerSummary?: string;
  force?: boolean;
}): Promise<{ dispatched: boolean; qaBotId?: string; qaBotName?: string; threadId?: string; reason?: string }> {
  const { workTasks, jira, group, botLookup, dispatcher, taskId, workerSummary, force } = params;
  if (!dispatcher) return { dispatched: false, reason: "dispatcher_unavailable" };
  const task = workTasks.get(taskId);
  if (!task) return { dispatched: false, reason: "not_found" };
  if (task.status !== "in-review") return { dispatched: false, reason: "not_in_review" };
  if (!force && task.autoQa === false) return { dispatched: false, reason: "auto_qa_disabled" };
  if (!force && isTaskOverBudget(task)) return { dispatched: false, reason: "budget_exceeded" };

  const room = group(task.roomId);
  const qaBot = resolveQaBotForTask(task, room, botLookup);
  if (!qaBot) return { dispatched: false, reason: "no_qa_bot" };

  const prompt = buildQaReviewPrompt(task, workerSummary);
  const startedAt = Date.now();
  const result = await dispatcher.dispatchToBot({
    botId: qaBot.id,
    roomId: task.roomId,
    existingThreadId: task.qaThreadId,
    threadTitle: `QA · ${task.key}: ${task.title}`,
    prompt,
    onSettled: (outcome) => {
      const latest = workTasks.get(task.id);
      if (!latest) return;
      const durationMs = Date.now() - startedAt;
      if (!outcome.ok && latest.status === "in-review") {
        workTasks.addActivity(
          latest.id,
          {
            type: "error",
            message: `Auto-QA review by ${qaBot.name} failed: ${outcome.text.slice(0, 600)}`,
            durationMs,
            threadId: latest.qaThreadId,
          },
          { actorType: "system", actorName: "Auto-QA" },
        );
      }
    },
  });

  if (!result.ok) {
    workTasks.addActivity(
      task.id,
      {
        type: "error",
        message: `Auto-QA dispatch to ${qaBot.name} failed: ${result.error ?? "unknown error"}`,
      },
      { actorType: "system", actorName: "Auto-QA" },
    );
    return { dispatched: false, qaBotId: qaBot.id, qaBotName: qaBot.name, reason: result.error };
  }

  if (result.threadId) {
    workTasks.bindRuntime(task.id, { qaThreadId: result.threadId });
  }
  workTasks.addActivity(
    task.id,
    {
      type: "dispatched",
      message: `Auto-QA review dispatched to ${qaBot.name}`,
      threadId: result.threadId,
    },
    { actorType: "system", actorName: "Auto-QA", actorRole: "QA" },
  );
  triggerAutoJira(workTasks, jira, workTasks.get(task.id));
  return { dispatched: true, qaBotId: qaBot.id, qaBotName: qaBot.name, threadId: result.threadId };
}

export async function maybeTriggerAutoRework(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  group: (id: string) => GroupRecord | undefined;
  botLookup: (id: string) => BotRecord | undefined;
  dispatcher?: WorkTaskDispatcher;
  taskId: string;
  reason?: string;
}): Promise<{ dispatched: boolean; reworkCount?: number; threadId?: string; reason?: string }> {
  const { workTasks, jira, group, botLookup, dispatcher, taskId, reason } = params;
  if (!dispatcher) return { dispatched: false, reason: "dispatcher_unavailable" };
  const task = workTasks.get(taskId);
  if (!task) return { dispatched: false, reason: "not_found" };
  if (task.status !== "rework") return { dispatched: false, reason: "not_rework" };
  if (task.autoQa === false) return { dispatched: false, reason: "auto_qa_disabled" };
  if (!task.assigneeBotId) return { dispatched: false, reason: "no_assignee" };
  if (isTaskOverBudget(task)) return { dispatched: false, reason: "budget_exceeded" };

  const currentLoops = task.reworkCount ?? 0;
  if (currentLoops >= MAX_AUTO_REWORK_LOOPS) {
    const capMsg = `Reached maximum ${MAX_AUTO_REWORK_LOOPS} automatic QA rework cycles — manual review required.`;
    workTasks.update(
      task.id,
      { needsUserAction: true, needsUserReason: capMsg },
      { actorType: "system", actorName: "Auto-QA" },
    );
    workTasks.addActivity(
      task.id,
      { type: "blocked", message: capMsg },
      { actorType: "system", actorName: "Auto-QA" },
    );
    return { dispatched: false, reworkCount: currentLoops, reason: "max_rework_reached" };
  }

  const nextLoops = currentLoops + 1;
  workTasks.bindRuntime(task.id, { reworkCount: nextLoops });
  const dispatched = await dispatchWorkTaskRun({
    workTasks,
    jira,
    group,
    botLookup,
    dispatcher,
    taskId: task.id,
    actor: { actorType: "system", actorName: "Auto-QA", actorRole: "QA" },
    reworkReason: reason || "QA requested rework on this task.",
    dispatchMessage: `Auto-Rework #${nextLoops} dispatched to ${task.assigneeName ?? task.assigneeBotId}`,
  });
  return {
    dispatched: dispatched.ok,
    reworkCount: nextLoops,
    threadId: dispatched.threadId,
    reason: dispatched.error,
  };
}

export async function dispatchWorkTaskRun(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  group: (id: string) => GroupRecord | undefined;
  botLookup: (id: string) => BotRecord | undefined;
  dispatcher: WorkTaskDispatcher;
  taskId: string;
  actor: WorkTaskActor;
  botIdOverride?: string;
  extraPrompt?: string;
  reworkReason?: string;
  dispatchMessage?: string;
  force?: boolean;
}): Promise<{ ok: boolean; task: AgentTask; threadId?: string; error?: string }> {
  const { workTasks, jira, group, botLookup, dispatcher, taskId, actor, botIdOverride, extraPrompt, reworkReason, dispatchMessage, force } = params;
  let task = workTasks.get(taskId);
  if (!task) throw new WorkTaskError(404, `Task "${taskId}" not found.`);

  if (!force && isTaskOverBudget(task)) {
    throw new WorkTaskError(
      409,
      `Task ${task.key} has reached its budget cap ($${(task.usage?.costUsd ?? 0).toFixed(4)} / $${task.budgetUsd?.toFixed(2)}). Increase budget or pass force=true to run.`,
    );
  }

  const room = group(task.roomId);
  const targetBotId = botIdOverride || task.assigneeBotId || (room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined);
  if (!targetBotId) {
    throw new WorkTaskError(400, `Assign an agent to ${task.key} before running.`);
  }
  const targetBot = botLookup(targetBotId);
  if (!targetBot) {
    throw new WorkTaskError(404, `Assigned agent "${targetBotId}" no longer exists.`);
  }

  if (task.assigneeBotId !== targetBot.id) {
    task = workTasks.assign(
      task.id,
      {
        assigneeBotId: targetBot.id,
        assigneeName: targetBot.name,
        assigneeRole: targetBot.title ?? (isQaBot(targetBot) ? "QA" : "Worker"),
      },
      actor,
    );
  }

  // Transition cleanly to in-progress
  if (task.status === "backlog") {
    task = workTasks.transition(task.id, "todo", { actorType: "system", actorName: "Runtime" });
  }
  if (["todo", "rework", "blocked", "failed"].includes(task.status)) {
    task = workTasks.transition(task.id, "in-progress", actor, {
      message: dispatchMessage ?? `Dispatched ${task.key} to ${targetBot.name}`,
    });
  } else if (task.status === "done" || task.status === "cancelled") {
    throw new WorkTaskError(409, `Cannot run a task in "${task.status}" status. Reopen it first.`);
  }

  const startedAt = Date.now();
  const activeTaskId = task.id;
  const prompt = buildWorkTaskPrompt(task, extraPrompt, reworkReason);
  const result = await dispatcher.dispatchToBot({
    botId: targetBot.id,
    roomId: task.roomId,
    existingThreadId: task.threadId,
    threadTitle: `${task.key}: ${task.title}`,
    prompt,
    onSettled: (outcome) => {
      const latest = workTasks.get(activeTaskId);
      if (!latest) return;
      const durationMs = Date.now() - startedAt;
      if (!outcome.ok) {
        if (["in-progress", "todo", "rework", "blocked"].includes(latest.status)) {
          const failed = workTasks.transition(
            latest.id,
            "failed",
            { actorType: "system", actorName: "Runtime" },
            {
              message: (outcome.text || "Agent run failed").slice(0, 800),
              needsUserAction: true,
              needsUserReason: (outcome.text || "Agent run failed").slice(0, 400),
              activityType: "error",
            },
          );
          triggerAutoJira(workTasks, jira, failed);
        }
        return;
      }
      if (latest.status === "in-progress" && !workTasks.hasUnfinishedSubtasks(latest.id)) {
        const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
        const workerActor = botActor(targetBot, targetBot.id, defaultRespId);
        const reviewed = workTasks.transition(latest.id, "in-review", workerActor, {
          message: `${targetBot.name} finished execution (${Math.round(durationMs / 1000)}s) and moved ${latest.key} to In Review`,
        });
        triggerAutoJira(workTasks, jira, reviewed);
        void maybeTriggerAutoQaReview({
          workTasks,
          jira,
          group,
          botLookup,
          dispatcher,
          taskId: reviewed.id,
          workerSummary: outcome.text,
        });
      }
    },
  });

  if (!result.ok) {
    workTasks.addActivity(
      task.id,
      { type: "error", message: `Failed to dispatch ${task.key} to ${targetBot.name}: ${result.error ?? "unknown error"}` },
      { actorType: "system", actorName: "Runtime" },
    );
    return { ok: false, task: workTasks.get(task.id) ?? task, error: result.error };
  }

  if (result.threadId) {
    task = workTasks.bindRuntime(task.id, { threadId: result.threadId }) ?? task;
  }
  workTasks.addActivity(
    task.id,
    {
      type: "dispatched",
      message: dispatchMessage ?? `Dispatched ${task.key} to ${targetBot.name}`,
      threadId: result.threadId,
    },
    actor,
  );
  triggerAutoJira(workTasks, jira, task);
  return { ok: true, task: workTasks.get(task.id) ?? task, threadId: result.threadId };
}

export function syncTaskOnCoordinateDispatch(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  sender: BotRecord;
  recipient: BotRecord;
  senderThreadId: string;
  node: HandoffView;
  call: CoordinateBotsCall;
}): AgentTask | undefined {
  const { workTasks, jira, store, sender, recipient, senderThreadId, node, call } = params;
  if (call.consult) return undefined;

  const parentWorkTask =
    (node.parentId ? workTasks.findByAssignmentId(node.parentId) : undefined) ??
    workTasks.findByThreadId(senderThreadId);
  const targetRoom =
    (node.groupId ? store.group(node.groupId) : undefined) ??
    (call.groupId ? store.group(call.groupId) : undefined) ??
    store.groupByThread(senderThreadId) ??
    (parentWorkTask ? store.group(parentWorkTask.roomId) : undefined);

  const roomId = targetRoom?.id ?? parentWorkTask?.roomId;
  const defaultRespId =
    targetRoom?.defaultResponder.kind === "member" ? targetRoom.defaultResponder.botId : undefined;
  const senderActor = {
    ...botActor(sender, sender.id, defaultRespId),
    isCoordinator: true,
  };

  if (call.workTaskId) {
    const existing = workTasks.get(call.workTaskId);
    if (!existing) return undefined;
    const assigned = workTasks.assign(
      existing.id,
      {
        assigneeBotId: recipient.id,
        assigneeName: recipient.name,
        assigneeRole: recipient.title ?? (isQaBot(recipient) ? "QA" : "Worker"),
        coordinatorBotId: sender.id,
        threadId: node.threadId,
        assignmentId: node.id,
      },
      senderActor,
    );
    triggerAutoJira(workTasks, jira, assigned);
    return assigned;
  }

  if (!roomId) return undefined;

  const alreadyBound = workTasks.findByAssignmentId(node.id);
  if (alreadyBound) return alreadyBound;

  const firstLine = call.message.replace(/\s+/g, " ").trim().slice(0, 80);
  const title = call.title?.trim() || firstLine || `Work for ${recipient.name}`;
  const created = workTasks.create(
    {
      roomId,
      ...(parentWorkTask ? { parentTaskId: parentWorkTask.id, type: "subtask" as const } : { type: "task" as const }),
      title,
      description: call.message,
      status: "todo",
      coordinatorBotId: sender.id,
      assigneeBotId: recipient.id,
      assigneeName: recipient.name,
      assigneeRole: recipient.title ?? (isQaBot(recipient) ? "QA" : "Worker"),
      ...(call.doneWhen ? { acceptanceCriteria: [call.doneWhen] } : {}),
      threadId: node.threadId,
      assignmentId: node.id,
    },
    senderActor,
  );
  return created.task;
}

export function syncTaskOnRuntimeStart(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  node: HandoffView;
  bot: BotRecord;
}): void {
  const { workTasks, jira, store, node, bot } = params;
  const task = workTasks.findByAssignmentId(node.id);
  if (!task) return;
  if (task.threadId !== node.threadId) {
    workTasks.bindRuntime(task.id, { threadId: node.threadId });
  }
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, bot.id, defaultRespId);

  if (task.status === "backlog") {
    const asTodo = workTasks.transition(task.id, "todo", {
      actorType: "system",
      actorName: "Runtime",
    });
    const started = workTasks.transition(asTodo.id, "in-progress", actor, {
      message: `${bot.name} started working on ${asTodo.key}`,
    });
    triggerAutoJira(workTasks, jira, started);
    return;
  }

  if (task.status === "todo" || task.status === "rework" || task.status === "blocked") {
    const started = workTasks.transition(task.id, "in-progress", actor, {
      message: `${bot.name} started execution in thread ${node.threadId}`,
    });
    triggerAutoJira(workTasks, jira, started);
  }
}

export function syncTaskOnRuntimePark(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  node: HandoffView;
  question: string;
}): void {
  const { workTasks, jira, store, node, question } = params;
  const task = workTasks.findByAssignmentId(node.id);
  if (!task) return;
  if (!["todo", "in-progress", "rework"].includes(task.status)) return;
  const bot = store.bot(node.botId);
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, node.botId, defaultRespId);
  const blocked = workTasks.transition(task.id, "blocked", actor, {
    message: question || "Waiting for user or coordinator answer",
    needsUserAction: true,
    needsUserReason: question || "Needs input",
  });
  triggerAutoJira(workTasks, jira, blocked);
}

export function syncTaskOnRuntimeReport(params: {
  workTasks: WorkTaskStore;
  jira?: JiraSyncService;
  store: Store;
  dispatcher?: WorkTaskDispatcher;
  child: HandoffView;
  hasActiveChildren: boolean;
}): void {
  const { workTasks, jira, store, dispatcher, child, hasActiveChildren } = params;
  const task = workTasks.findByAssignmentId(child.id);
  if (!task) return;
  const bot = store.bot(child.botId);
  const room = store.group(task.roomId);
  const defaultRespId = room?.defaultResponder.kind === "member" ? room.defaultResponder.botId : undefined;
  const actor = botActor(bot, child.botId, defaultRespId);

  if (child.status === "completed") {
    const unfinishedChildren = hasActiveChildren || workTasks.hasUnfinishedSubtasks(task.id);
    if (unfinishedChildren) {
      workTasks.addActivity(
        task.id,
        {
          type: "progress",
          message: `${bot?.name ?? child.botId} finished turn, waiting on child subtasks before review`,
          threadId: child.threadId,
        },
        actor,
      );
      return;
    }
    let reviewed: AgentTask | undefined;
    if (task.status === "in-progress") {
      reviewed = workTasks.transition(task.id, "in-review", actor, {
        message: `${bot?.name ?? child.botId} completed work and moved ${task.key} to In Review`,
      });
    } else if (task.status === "todo" || task.status === "rework") {
      const inProg = workTasks.transition(task.id, "in-progress", actor);
      reviewed = workTasks.transition(inProg.id, "in-review", actor, {
        message: `${bot?.name ?? child.botId} completed work and moved ${task.key} to In Review`,
      });
    }
    if (reviewed) {
      triggerAutoJira(workTasks, jira, reviewed);
      if (dispatcher) {
        void maybeTriggerAutoQaReview({
          workTasks,
          jira,
          group: (id) => store.group(id),
          botLookup: (id) => store.bot(id) ?? undefined,
          dispatcher,
          taskId: reviewed.id,
          workerSummary: child.result,
        });
      }
    }
    return;
  }

  if (child.status === "failed") {
    const cause = child.outcomeDetail || child.result || "Agent runtime failed";
    if (["todo", "in-progress", "blocked", "in-review"].includes(task.status)) {
      const failed = workTasks.transition(task.id, "failed", { actorType: "system", actorName: "Runtime" }, {
        message: cause.slice(0, 800),
        needsUserAction: true,
        needsUserReason: cause.slice(0, 400),
        activityType: "error",
      });
      triggerAutoJira(workTasks, jira, failed);
    } else {
      workTasks.addActivity(task.id, { type: "error", message: cause.slice(0, 800), threadId: child.threadId }, { actorType: "system", actorName: "Runtime" });
    }
  }
}
