import { api } from "@/state/api";
import type {
  AgentTask,
  AgentTaskEvidenceType,
  AgentTaskPriority,
  AgentTaskStatus,
  AgentTaskType,
  RoomJiraPublicConfig,
  RoomTimelineEvent,
  RoomWorkTaskOverview,
  TaskActivity,
  TelegramBridgePublicConfig,
} from "../../../shared/work-tasks";

export interface WorkTaskListResponse {
  tasks: AgentTask[];
  overview?: RoomWorkTaskOverview;
}

export interface WorkTaskDetailResponse {
  task: AgentTask;
  subtasks: AgentTask[];
  activities: TaskActivity[];
}

export interface RoomTimelineResponse {
  events: RoomTimelineEvent[];
  overview: RoomWorkTaskOverview;
}

export async function fetchRoomWorkTasks(roomId: string): Promise<WorkTaskListResponse> {
  return api<WorkTaskListResponse>(`/api/work-tasks?roomId=${encodeURIComponent(roomId)}`);
}

export async function fetchRoomTimeline(roomId: string, limit = 150): Promise<RoomTimelineResponse> {
  return api<RoomTimelineResponse>(`/api/work-tasks/rooms/${encodeURIComponent(roomId)}/timeline?limit=${limit}`);
}

export async function fetchWorkTaskDetail(idOrKey: string): Promise<WorkTaskDetailResponse> {
  return api<WorkTaskDetailResponse>(`/api/work-tasks/${encodeURIComponent(idOrKey)}`);
}

export async function createWorkTask(input: {
  roomId: string;
  title: string;
  description?: string;
  type?: AgentTaskType;
  priority?: AgentTaskPriority;
  status?: AgentTaskStatus;
  parentTaskId?: string;
  assigneeBotId?: string;
  qaBotId?: string;
  autoQa?: boolean;
  budgetUsd?: number;
  acceptanceCriteria?: string[];
  labels?: string[];
  dueAt?: number;
  dependencies?: string[];
}): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateWorkTask(
  idOrKey: string,
  patch: {
    title?: string;
    description?: string;
    type?: AgentTaskType;
    priority?: AgentTaskPriority;
    status?: AgentTaskStatus;
    statusNote?: string;
    parentTaskId?: string | null;
    assigneeBotId?: string | null;
    qaBotId?: string | null;
    autoQa?: boolean;
    budgetUsd?: number | null;
    acceptanceCriteria?: string[];
    labels?: string[];
    dueAt?: number | null;
    dependencies?: string[];
    blockedBy?: string[];
    needsUserAction?: boolean;
    needsUserReason?: string | null;
  },
): Promise<{ task: AgentTask }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function runWorkTask(
  idOrKey: string,
  options?: { botId?: string; prompt?: string; force?: boolean },
): Promise<{ ok: boolean; task: AgentTask; threadId?: string; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/run`, {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

export async function triggerWorkTaskQa(
  idOrKey: string,
): Promise<{ dispatched: boolean; qaBotId?: string; qaBotName?: string; threadId?: string; reason?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/qa`, {
    method: "POST",
    body: "{}",
  });
}

export async function addWorkTaskComment(
  idOrKey: string,
  message: string,
): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/comments`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function addWorkTaskEvidence(
  idOrKey: string,
  input: { type: AgentTaskEvidenceType; label: string; value: string },
): Promise<{ task: AgentTask; activities: TaskActivity[] }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/evidence`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteWorkTask(idOrKey: string): Promise<{ ok: boolean }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}`, {
    method: "DELETE",
  });
}

export async function fetchRoomJiraConfig(roomId: string): Promise<{ config: RoomJiraPublicConfig }> {
  return api(`/api/work-tasks/rooms/${encodeURIComponent(roomId)}/jira`);
}

export async function saveRoomJiraConfig(
  roomId: string,
  input: Partial<RoomJiraPublicConfig> & { apiToken?: string | null },
): Promise<{ config: RoomJiraPublicConfig }> {
  return api(`/api/work-tasks/rooms/${encodeURIComponent(roomId)}/jira`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function createJiraForTask(idOrKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/create`, { method: "POST", body: "{}" });
}

export async function linkJiraToTask(
  idOrKey: string,
  issueKey: string,
): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/link`, {
    method: "POST",
    body: JSON.stringify({ issueKey }),
  });
}

export async function syncJiraForTask(idOrKey: string): Promise<{ ok: boolean; task?: AgentTask; error?: string }> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/sync`, { method: "POST", body: "{}" });
}

export async function pullJiraForTask(idOrKey: string): Promise<{
  ok: boolean;
  task?: AgentTask;
  createdSubtasks: AgentTask[];
  updatedSubtasks: AgentTask[];
  error?: string;
}> {
  return api(`/api/work-tasks/${encodeURIComponent(idOrKey)}/jira/pull`, { method: "POST", body: "{}" });
}

export async function fetchTelegramConfig(): Promise<{ config: TelegramBridgePublicConfig }> {
  return api(`/api/work-tasks/telegram/config`);
}

export async function saveTelegramConfig(
  input: Partial<TelegramBridgePublicConfig> & { botToken?: string | null },
): Promise<{ config: TelegramBridgePublicConfig }> {
  return api(`/api/work-tasks/telegram/config`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function testTelegramConnection(): Promise<{
  ok: boolean;
  botUsername?: string;
  error?: string;
  config?: TelegramBridgePublicConfig;
}> {
  return api(`/api/work-tasks/telegram/test`, { method: "POST", body: "{}" });
}

