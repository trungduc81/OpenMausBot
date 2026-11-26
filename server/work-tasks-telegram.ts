import type { AgentTask, TaskActivity, TelegramBridgePublicConfig } from "../shared/work-tasks.ts";
import type { BotRecord, GroupRecord } from "./store.ts";
import type { JiraSyncService } from "./work-tasks-jira.ts";
import {
  dispatchWorkTaskRun,
  maybeTriggerAutoQaReview,
  type WorkTaskDispatcher,
} from "./work-tasks-runtime.ts";
import type { WorkTaskStore } from "./work-tasks.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id: number | string; type?: string; title?: string };
    from?: { id?: number | string; username?: string; first_name?: string; last_name?: string };
  };
}

export interface TelegramBridgeServiceOptions {
  store: WorkTaskStore;
  jira?: JiraSyncService;
  dispatcher?: WorkTaskDispatcher;
  group: (id: string) => GroupRecord | undefined;
  groups: () => readonly GroupRecord[];
  botLookup: (id: string) => BotRecord | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollTimeoutSeconds?: number;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_TEXT = 3950;

function trimTelegramText(text: string): string {
  const clean = text.trim();
  if (clean.length <= TELEGRAM_MAX_TEXT) return clean;
  return `${clean.slice(0, TELEGRAM_MAX_TEXT - 12)}\n...(truncated)`;
}

function normalizeSlashCommand(raw: string): { cmd: string; rest: string } {
  const trimmed = raw.trim();
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  // In Telegram groups, commands often arrive as `/status@MyBotName`.
  const cmd = head.split("@")[0]!.toLowerCase();
  return { cmd, rest };
}

function senderDisplayName(from?: { username?: string; first_name?: string; last_name?: string }): string {
  if (!from) return "Telegram User";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (full) return from.username ? `${full} (@${from.username})` : full;
  if (from.username) return `@${from.username}`;
  return "Telegram User";
}

export class TelegramBridgeService {
  private readonly store: WorkTaskStore;
  private readonly jira?: JiraSyncService;
  private readonly dispatcher?: WorkTaskDispatcher;
  private readonly group: (id: string) => GroupRecord | undefined;
  private readonly groups: () => readonly GroupRecord[];
  private readonly botLookup: (id: string) => BotRecord | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pollTimeoutSeconds: number;

  private running = false;
  private offset = 0;
  private abortController: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeActivity: (() => void) | null = null;

  constructor(options: TelegramBridgeServiceOptions) {
    this.store = options.store;
    this.jira = options.jira;
    this.dispatcher = options.dispatcher;
    this.group = options.group;
    this.groups = options.groups;
    this.botLookup = options.botLookup;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;

    this.unsubscribeActivity = this.store.subscribeActivity((task, activity) => {
      void this.maybeSendAlert(task, activity);
    });
  }

  getConfig(): TelegramBridgePublicConfig {
    return this.store.getTelegramConfig();
  }

  start(): void {
    const { config, botToken } = this.store.getTelegramSecrets();
    if (!config.enabled || !botToken) {
      this.stop();
      return;
    }
    if (this.running) return;
    this.running = true;
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  dispose(): void {
    this.stop();
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
  }

  reload(): void {
    this.stop();
    this.start();
  }

  private async callTelegramApi<T = any>(
    botToken: string,
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result?: T; description?: string }> {
    const url = `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/${method}`;
    const res = await this.fetchImpl(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !payload?.ok) {
      return { ok: false, description: payload?.description || `Telegram HTTP ${res.status}` };
    }
    return { ok: true, result: payload.result };
  }

  async testConnection(): Promise<{ ok: boolean; botUsername?: string; error?: string }> {
    const { botToken } = this.store.getTelegramSecrets();
    if (!botToken) {
      return { ok: false, error: "Chưa cấu hình Telegram Bot Token." };
    }
    try {
      const res = await this.callTelegramApi<{ username?: string; first_name?: string }>(botToken, "getMe");
      if (!res.ok) {
        const msg = res.description || "Không thể kết nối tới Telegram API.";
        this.store.saveTelegramConfig({ lastError: msg });
        return { ok: false, error: msg };
      }
      const username = res.result?.username || res.result?.first_name || "";
      this.store.saveTelegramConfig({ botUsername: username, lastError: "" });
      return { ok: true, botUsername: username };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.store.saveTelegramConfig({ lastError: msg });
      return { ok: false, error: msg };
    }
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    const { botToken } = this.store.getTelegramSecrets();
    if (!botToken || !chatId.trim()) return false;
    try {
      const res = await this.callTelegramApi(botToken, "sendMessage", {
        chat_id: chatId.trim(),
        text: trimTelegramText(text),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Level 2: Push alerts to allowed Telegram chats on critical work-task events. */
  async maybeSendAlert(task: AgentTask, activity: TaskActivity): Promise<void> {
    const { config, botToken } = this.store.getTelegramSecrets();
    if (!config.enabled || !botToken || config.allowedChatIds.length === 0) return;

    let heading: string | null = null;
    if (config.notifyOnBudgetExceeded && activity.type === "budget-exceeded") {
      heading = `🚨 VƯỢT NGÂN SÁCH · ${task.key}`;
    } else if (
      config.notifyOnBlocked &&
      (activity.toStatus === "blocked" || activity.toStatus === "failed" || activity.type === "blocked")
    ) {
      heading = `⚠️ CẦN XỬ LÝ (${task.status.toUpperCase()}) · ${task.key}`;
    } else if (config.notifyOnDone && activity.toStatus === "done") {
      heading = `✅ HOÀN THÀNH · ${task.key}`;
    } else if (config.notifyOnRework && activity.toStatus === "rework") {
      heading = `🔁 YÊU CẦU SỬA (REWORK) · ${task.key}`;
    }

    if (!heading) return;

    const roomName = this.group(task.roomId)?.name ?? task.roomId;
    const lines = [
      heading,
      `Phòng: ${roomName}`,
      `Task: ${task.title}`,
      `Phụ trách: ${task.assigneeName ?? "Chưa gán"}`,
      `Chi tiết: ${activity.message}`,
    ];
    if (task.usage?.costUsd !== undefined && task.usage.costUsd > 0) {
      lines.push(
        `Chi phí: $${task.usage.costUsd.toFixed(4)}${task.budgetUsd ? ` / $${task.budgetUsd.toFixed(2)}` : ""}`,
      );
    }

    const body = lines.join("\n");
    await Promise.all(config.allowedChatIds.map((chatId) => this.sendMessage(chatId, body)));
  }

  /** Processes a single Telegram update (Level 1 read commands + Level 3 remote control actions). */
  async handleUpdate(update: TelegramUpdate): Promise<{ replied: boolean; text?: string }> {
    const msg = update.message;
    const rawText = msg?.text?.trim();
    const chatId = msg?.chat?.id !== undefined ? String(msg.chat.id) : "";
    if (!rawText || !chatId) return { replied: false };

    const { cmd, rest } = normalizeSlashCommand(rawText);
    if (!cmd.startsWith("/")) return { replied: false };

    // Always allow `/myid` so the user can easily find their Chat ID during setup.
    if (cmd === "/myid") {
      const reply = `Chat ID của bạn là: ${chatId}\nHãy dán ID này vào mục "Allowed Chat IDs" trong cài đặt Telegram của LOOMA.`;
      await this.sendMessage(chatId, reply);
      return { replied: true, text: reply };
    }

    const { config } = this.store.getTelegramSecrets();
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
      const denied = `⛔ Chat ID ${chatId} chưa được cấp quyền truy cập LOOMA.`;
      await this.sendMessage(chatId, denied);
      return { replied: true, text: denied };
    }

    if (cmd === "/help" || cmd === "/start") {
      const help = [
        "🤖 LOOMA Telegram Control Plane",
        "",
        "📊 Xem tiến độ (Mức 1):",
        "- /status — Tổng quan các phòng & Agent",
        "- /tasks — Toàn bộ Task",
        "- /tasks <Tên Agent> — Lọc Task theo Agent",
        "- /task <KEY> — Chi tiết Task (vd: /task LOOMA-101)",
        "- /blocked — Danh sách Task đang bị kẹt/lỗi",
        "",
        "⚡ Điều khiển từ xa (Mức 3):",
        "- /run <KEY> [ghi chú] — Chạy ngay Task",
        "- /qa <KEY> — Gửi Task đang In Review sang QA duyệt",
        "- /comment <KEY> <nội dung> — Bình luận / chỉ đạo vào Task",
        "",
        "🔑 Tiện ích:",
        "- /myid — Xem Chat ID của bạn",
      ].join("\n");
      await this.sendMessage(chatId, help);
      return { replied: true, text: help };
    }

    // Level 3: Remote control commands
    if (cmd === "/run" || cmd === "/qa" || cmd === "/comment") {
      if (!config.allowRemoteActions) {
        const reply = "🔒 Chế độ điều khiển từ xa (/run, /qa, /comment) đang tắt trong cài đặt LOOMA.";
        await this.sendMessage(chatId, reply);
        return { replied: true, text: reply };
      }

      const [keyArg, ...tail] = rest.split(/\s+/);
      const taskKey = keyArg?.trim() || "";
      const extraText = tail.join(" ").trim();
      if (!taskKey) {
        const usage =
          cmd === "/comment"
            ? "Cú pháp: /comment <KEY> <nội dung>\nVí dụ: /comment LOOMA-101 Nhớ kiểm tra edge case"
            : `Cú pháp: ${cmd} <KEY>\nVí dụ: ${cmd} LOOMA-101`;
        await this.sendMessage(chatId, usage);
        return { replied: true, text: usage };
      }

      const task = this.store.get(taskKey);
      if (!task) {
        const notFound = `Không tìm thấy Task "${taskKey}".`;
        await this.sendMessage(chatId, notFound);
        return { replied: true, text: notFound };
      }

      const who = senderDisplayName(msg?.from);

      if (cmd === "/comment") {
        if (!extraText) {
          const reply = `Vui lòng nhập nội dung bình luận. Ví dụ: /comment ${task.key} Kiểm tra lại test`;
          await this.sendMessage(chatId, reply);
          return { replied: true, text: reply };
        }
        const updated = this.store.addActivity(
          task.id,
          { type: "comment", message: extraText },
          { actorType: "user", actorName: `${who} (Telegram)` },
        );
        if (this.jira && updated.jiraSync?.issueKey) {
          const jiraCfg = this.store.getRoomJiraConfig(updated.roomId);
          if (jiraCfg.enabled && jiraCfg.autoSync) {
            void this.jira
              .syncTaskToJira(updated.id, extraText, { name: `${who} (Telegram)`, type: "user" })
              .catch((err) => console.warn("[telegram] Jira comment sync failed:", err));
          }
        }
        const reply = `💬 Đã thêm bình luận vào ${task.key}: "${extraText}"`;
        await this.sendMessage(chatId, reply);
        return { replied: true, text: reply };
      }

      if (!this.dispatcher) {
        const reply = "Bộ điều phối chạy Task hiện không khả dụng.";
        await this.sendMessage(chatId, reply);
        return { replied: true, text: reply };
      }

      if (cmd === "/run") {
        try {
          const res = await dispatchWorkTaskRun({
            workTasks: this.store,
            jira: this.jira,
            group: this.group,
            botLookup: this.botLookup,
            dispatcher: this.dispatcher,
            taskId: task.id,
            actor: { actorType: "user", actorName: `${who} (Telegram)` },
            ...(extraText ? { extraPrompt: extraText } : {}),
          });
          const reply = res.ok
            ? `▶️ Đã khởi chạy ${res.task.key} trên Agent ${res.task.assigneeName ?? res.task.assigneeBotId ?? ""}.`
            : `❌ Không thể chạy ${task.key}: ${res.error ?? "lỗi không xác định"}`;
          await this.sendMessage(chatId, reply);
          return { replied: true, text: reply };
        } catch (err) {
          const reply = `❌ Không thể chạy ${task.key}: ${err instanceof Error ? err.message : String(err)}`;
          await this.sendMessage(chatId, reply);
          return { replied: true, text: reply };
        }
      }

      if (cmd === "/qa") {
        const res = await maybeTriggerAutoQaReview({
          workTasks: this.store,
          jira: this.jira,
          group: this.group,
          botLookup: this.botLookup,
          dispatcher: this.dispatcher,
          taskId: task.id,
          force: true,
        });
        const reply = res.dispatched
          ? `🛡️ Đã gửi ${task.key} sang QA Agent (${res.qaBotName ?? res.qaBotId}) kiểm duyệt.`
          : `⚠️ Không thể gửi ${task.key} sang QA: ${res.reason ?? "Task chưa ở trạng thái In Review hoặc chưa có QA bot."}`;
        await this.sendMessage(chatId, reply);
        return { replied: true, text: reply };
      }
    }

    // Level 1: Read-only queries (`/status`, `/tasks`, `/task`, `/blocked`)
    const visibleRooms = this.groups()
      .filter((g) => !g.dm)
      .map((g) => ({ id: g.id, name: g.name }));
    const formatted = this.store.formatTelegramCommand(rest ? `${cmd} ${rest}` : cmd, visibleRooms);
    await this.sendMessage(chatId, formatted.text);
    return { replied: true, text: formatted.text };
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 2000;
    while (this.running) {
      const { config, botToken } = this.store.getTelegramSecrets();
      if (!config.enabled || !botToken) {
        this.running = false;
        return;
      }

      const controller = new AbortController();
      this.abortController = controller;
      const timeoutHandle = setTimeout(() => controller.abort(), (this.pollTimeoutSeconds + 10) * 1000);

      try {
        const url = `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/getUpdates?offset=${this.offset}&timeout=${this.pollTimeoutSeconds}&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
        const res = await this.fetchImpl(url, { signal: controller.signal });
        clearTimeout(timeoutHandle);

        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          result?: TelegramUpdate[];
          description?: string;
        } | null;

        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.description || `Telegram HTTP ${res.status}`);
        }

        backoffMs = 2000;
        const updates = payload.result ?? [];
        if (config.lastError) {
          this.store.saveTelegramConfig({ lastPollAt: this.now(), lastError: "" });
        }

        for (const update of updates) {
          if (typeof update.update_id === "number" && update.update_id >= this.offset) {
            this.offset = update.update_id + 1;
          }
          try {
            await this.handleUpdate(update);
          } catch (err) {
            console.warn("[telegram] update handler error:", err);
          }
        }
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (!this.running || (error instanceof Error && error.name === "AbortError")) {
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        this.store.saveTelegramConfig({ lastError: msg });
        await new Promise<void>((resolve) => {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            resolve();
          }, backoffMs);
        });
        backoffMs = Math.min(30_000, backoffMs * 2);
      } finally {
        if (this.abortController === controller) {
          this.abortController = null;
        }
      }
    }
  }
}
