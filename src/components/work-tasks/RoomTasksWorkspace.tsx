import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { useShowThreads } from "@/lib/thread-preferences";
import { openThread, useStore, type Bot, type Group } from "@/state/store";
import {
  canTransitionWorkTask,
  computeRoomTaskOverview,
  type AgentTask,
  type AgentTaskStatus,
  type RoomJiraPublicConfig,
  type RoomTimelineEvent,
  type TelegramBridgePublicConfig,
} from "../../../shared/work-tasks";
import { JiraConfigModal } from "./JiraConfigModal";
import { NewTaskModal } from "./NewTaskModal";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { TasksBoard, type BoardFilters } from "./TasksBoard";
import { TasksOverviewBar } from "./TasksOverviewBar";
import { TasksTimelineView } from "./TasksTimelineView";
import { TelegramConfigModal } from "./TelegramConfigModal";
import {
  fetchRoomJiraConfig,
  fetchRoomTimeline,
  fetchRoomWorkTasks,
  fetchTelegramConfig,
  runWorkTask,
  updateWorkTask,
} from "./work-tasks-api";

const EMPTY_FILTERS: BoardFilters = {
  q: "",
  assigneeBotId: "",
  role: "",
  status: "",
  type: "",
  priority: "",
  overdueOnly: false,
};

export function RoomTasksWorkspace({
  group,
  members,
  onSwitchToChat,
}: {
  group: Group;
  members: Bot[];
  onSwitchToChat?: () => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<RoomTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"board" | "timeline">("board");
  const [jiraConfig, setJiraConfig] = useState<RoomJiraPublicConfig | null>(null);
  const [telegramConfig, setTelegramConfig] = useState<TelegramBridgePublicConfig | null>(null);
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [jiraModalOpen, setJiraModalOpen] = useState(false);
  const [telegramModalOpen, setTelegramModalOpen] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const res = await fetchRoomTimeline(group.id);
      setTimelineEvents(res.events);
    } catch {
      // Keep last known timeline if transient network issue occurs
    } finally {
      setTimelineLoading(false);
    }
  }, [group.id]);

  const load = useCallback(async () => {
    try {
      const [tasksRes, jiraRes, tgRes] = await Promise.all([
        fetchRoomWorkTasks(group.id),
        fetchRoomJiraConfig(group.id).catch(() => ({ config: null })),
        fetchTelegramConfig().catch(() => ({ config: null })),
      ]);
      setTasks(tasksRes.tasks);
      if (jiraRes.config) setJiraConfig(jiraRes.config);
      if (tgRes.config) setTelegramConfig(tgRes.config);
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    }
  }, [group.id]);

  useEffect(() => {
    void load();
    void loadTimeline();
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind === "work-task" && frame.groupId === group.id) {
          setTasks((prev) => {
            const idx = prev.findIndex((item) => item.id === frame.task.id);
            return idx >= 0
              ? prev.map((item) => (item.id === frame.task.id ? frame.task : item))
              : [frame.task, ...prev];
          });
        } else if (frame.kind === "work-task.activity" && frame.groupId === group.id) {
          void loadTimeline();
        } else if (frame.kind === "work-task.deleted" && frame.groupId === group.id) {
          setTasks((prev) => prev.filter((item) => item.id !== frame.taskId));
          setSelectedTaskId((cur) => (cur === frame.taskId ? null : cur));
          setTimelineEvents((prev) => prev.filter((ev) => ev.taskId !== frame.taskId));
        }
      },
      onMissedFrames: () => {
        void load();
        void loadTimeline();
      },
    });
  }, [group.id, load, loadTimeline]);

  const overview = useMemo(
    () =>
      computeRoomTaskOverview(
        tasks,
        members.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.title ? { title: m.title } : {}),
          busy: Boolean(m.busy || group.busyBotId === m.id),
        })),
      ),
    [tasks, members, group.busyBotId],
  );

  const handleMoveTask = async (task: AgentTask, toStatus: AgentTaskStatus) => {
    if (task.status === toStatus) return;
    if (!canTransitionWorkTask(task.status, toStatus)) {
      setBoardError(t("workTasks.workflowError", { from: task.status, to: toStatus }));
      return;
    }
    setBoardError(null);
    try {
      const res = await updateWorkTask(task.id, { status: toStatus });
      setTasks((prev) => prev.map((item) => (item.id === task.id ? res.task : item)));
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunTask = async (task: AgentTask) => {
    setRunningTaskId(task.id);
    setBoardError(null);
    try {
      const res = await runWorkTask(task.id);
      if (!res.ok && res.error) {
        setBoardError(res.error);
      }
      setTasks((prev) => prev.map((item) => (item.id === res.task.id ? res.task : item)));
      void loadTimeline();
    } catch (err) {
      setBoardError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleOpenThreadById = (botId: string | undefined, threadId: string) => {
    const isRoomThread =
      threadId === group.threadId ||
      group.tasks?.some((gt) => gt.threadId === threadId);
    if (isRoomThread) {
      onSwitchToChat?.();
      return;
    }
    if (botId) {
      openThread(dispatch, { botId, threadId }, state, showThreads);
    }
  };

  const handleOpenThread = (task: AgentTask) => {
    if (!task.threadId) return;
    handleOpenThreadById(task.assigneeBotId, task.threadId);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <TasksOverviewBar
        overview={overview}
        members={members}
        viewMode={viewMode}
        onChangeViewMode={setViewMode}
        activeFilter={{
          status: filters.status,
          overdueOnly: filters.overdueOnly,
          assigneeBotId: filters.assigneeBotId,
        }}
        onSelectFilter={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
      />

      {viewMode === "timeline" ? (
        <TasksTimelineView
          events={timelineEvents}
          members={members}
          loading={timelineLoading}
          onRefresh={() => void loadTimeline()}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onOpenThreadById={handleOpenThreadById}
        />
      ) : (
        <TasksBoard
          tasks={tasks}
          members={members}
          filters={filters}
          jiraConfig={jiraConfig}
          telegramConfig={telegramConfig}
          onChangeFilters={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
          onResetFilters={() => setFilters(EMPTY_FILTERS)}
          onOpenNewTask={() => setNewTaskOpen(true)}
          onOpenJiraSettings={() => setJiraModalOpen(true)}
          onOpenTelegramSettings={() => setTelegramModalOpen(true)}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onMoveTask={(task, toStatus) => void handleMoveTask(task, toStatus)}
          onOpenThread={handleOpenThread}
          onRunTask={(task) => void handleRunTask(task)}
          runningTaskId={runningTaskId}
          boardError={boardError}
          onDismissError={() => setBoardError(null)}
        />
      )}

      {selectedTaskId && (
        <TaskDetailDrawer
          taskId={selectedTaskId}
          allTasks={tasks}
          members={members}
          jiraEnabled={Boolean(jiraConfig?.enabled)}
          onClose={() => setSelectedTaskId(null)}
          onOpenTask={(id) => setSelectedTaskId(id)}
          onOpenThread={handleOpenThread}
          onTaskUpdated={() => {
            void load();
            void loadTimeline();
          }}
        />
      )}

      {newTaskOpen && (
        <NewTaskModal
          roomId={group.id}
          members={members}
          existingTasks={tasks}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(created) => {
            setTasks((prev) => (prev.some((item) => item.id === created.id) ? prev : [created, ...prev]));
            void loadTimeline();
          }}
        />
      )}

      {jiraModalOpen && jiraConfig && (
        <JiraConfigModal
          roomId={group.id}
          initial={jiraConfig}
          onClose={() => setJiraModalOpen(false)}
          onSaved={(next) => setJiraConfig(next)}
        />
      )}

      {telegramModalOpen && telegramConfig && (
        <TelegramConfigModal
          initial={telegramConfig}
          onClose={() => setTelegramModalOpen(false)}
          onSaved={(next) => setTelegramConfig(next)}
        />
      )}
    </div>
  );
}
