import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Coins,
  FileCheck2,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatTokens } from "@/lib/usage";
import type { Bot } from "@/state/store";
import type { RoomTimelineEvent, TaskActivityType } from "../../../shared/work-tasks";
import { BotAvatar } from "../Avatar";

const EVENT_TONE: Record<TaskActivityType, string> = {
  created: "bg-raised text-ink-secondary",
  assigned: "bg-accent/10 text-accent-text",
  dispatched: "bg-accent/15 text-accent-text",
  "status-changed": "bg-raised text-ink",
  progress: "bg-raised text-ink-secondary",
  comment: "bg-raised text-ink-secondary",
  "evidence-added": "bg-success/15 text-success",
  blocked: "bg-warning/15 text-warning",
  reviewed: "bg-success/15 text-success",
  "jira-synced": "bg-accent/10 text-accent-text",
  "budget-exceeded": "bg-danger/15 text-danger",
  error: "bg-danger/15 text-danger",
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

export function TasksTimelineView({
  events,
  members,
  loading,
  onRefresh,
  onSelectTask,
  onOpenThreadById,
}: {
  events: RoomTimelineEvent[];
  members: Bot[];
  loading: boolean;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenThreadById: (botId: string | undefined, threadId: string) => void;
}) {
  const [agentFilter, setAgentFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TaskActivityType | "">("");

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const filtered = useMemo(
    () =>
      events.filter((ev) => {
        if (agentFilter && ev.actorId !== agentFilter && ev.assigneeBotId !== agentFilter) return false;
        if (typeFilter && ev.type !== typeFilter) return false;
        return true;
      }),
    [events, agentFilter, typeFilter],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-app px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            aria-label={t("workTasks.filter.agent")}
            className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.filter.allAgents")}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TaskActivityType | "")}
            className="rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink"
          >
            <option value="">{t("workTasks.timeline.allTypes")}</option>
            <option value="dispatched">Dispatched</option>
            <option value="status-changed">Status Changed</option>
            <option value="reviewed">Reviewed</option>
            <option value="evidence-added">Evidence</option>
            <option value="budget-exceeded">Budget Exceeded</option>
            <option value="blocked">Blocked</option>
            <option value="error">Error</option>
          </select>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
          <span>{t("workTasks.timeline.refresh")}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {filtered.length === 0 ? (
          <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-hairline text-[13px] text-ink-secondary">
            {t("workTasks.timeline.empty")}
          </div>
        ) : (
          <div className="relative space-y-2.5 before:absolute before:bottom-3 before:left-[15px] before:top-3 before:w-px before:bg-hairline">
            {filtered.map((ev) => {
              const actorBot = ev.actorId ? memberById.get(ev.actorId) : undefined;
              const Icon =
                ev.type === "dispatched"
                  ? Play
                  : ev.type === "budget-exceeded" || ev.type === "error"
                    ? AlertTriangle
                    : ev.type === "reviewed"
                      ? ShieldCheck
                      : ev.type === "evidence-added"
                        ? FileCheck2
                        : CheckCircle2;

              return (
                <div key={ev.id} className="relative flex items-start gap-3 pl-9">
                  <span
                    className={cn(
                      "absolute left-1.5 top-2.5 flex size-5 items-center justify-center rounded-full border border-hairline bg-panel",
                      ev.type === "error" || ev.type === "budget-exceeded"
                        ? "text-danger"
                        : ev.type === "dispatched"
                          ? "text-accent-text"
                          : "text-ink-secondary",
                    )}
                  >
                    <Icon size={11} />
                  </span>

                  <div className="flex-1 rounded-xl border border-hairline bg-card p-3 transition-colors hover:border-edge">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectTask(ev.taskId)}
                          className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-text hover:underline"
                        >
                          {ev.taskKey}
                        </button>
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", EVENT_TONE[ev.type])}>
                          {ev.type}
                        </span>
                        {ev.fromStatus && ev.toStatus && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
                            <span>{ev.fromStatus}</span>
                            <ArrowRight size={10} />
                            <span className="font-medium text-ink">{ev.toStatus}</span>
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-ink-tertiary">
                        {formatTimestamp(ev.createdAt)}
                      </span>
                    </div>

                    <div className="mt-1.5 text-[13px] text-ink">{ev.message}</div>

                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-secondary">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5">
                          {actorBot && <BotAvatar bot={actorBot} state="happy" size={14} animated={false} />}
                          <span className="font-medium text-ink">{ev.actorName ?? ev.actorType}</span>
                          {ev.actorRole && <span className="text-ink-tertiary">· {ev.actorRole}</span>}
                        </span>
                        {ev.taskTitle && (
                          <span className="max-w-[260px] truncate text-ink-tertiary">— {ev.taskTitle}</span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {typeof ev.costUsd === "number" && (
                          <span className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink">
                            <Coins size={10} />
                            {formatUsd(ev.costUsd)}
                            {typeof ev.tokens === "number" ? ` · ${formatTokens(ev.tokens)}` : ""}
                          </span>
                        )}
                        {typeof ev.durationMs === "number" && (
                          <span className="font-mono text-[10px] tabular-nums text-ink-tertiary">
                            {Math.max(1, Math.round(ev.durationMs / 1000))}s
                          </span>
                        )}
                        {ev.threadId && (
                          <button
                            type="button"
                            onClick={() => onOpenThreadById(ev.actorId ?? ev.assigneeBotId, ev.threadId!)}
                            className="inline-flex items-center gap-1 rounded border border-hairline bg-control px-1.5 py-0.5 text-[10px] text-ink hover:bg-raised-hover"
                          >
                            <MessageSquare size={10} />
                            <span>{t("workTasks.detail.openThread")}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
