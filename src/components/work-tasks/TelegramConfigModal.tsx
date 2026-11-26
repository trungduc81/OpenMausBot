import { useState } from "react";
import { CheckCircle2, Send, X } from "lucide-react";
import { t } from "@/lib/i18n";
import type { TelegramBridgePublicConfig } from "../../../shared/work-tasks";
import { saveTelegramConfig, testTelegramConnection } from "./work-tasks-api";

export function TelegramConfigModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: TelegramBridgePublicConfig;
  onClose: () => void;
  onSaved: (next: TelegramBridgePublicConfig) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [botToken, setBotToken] = useState("");
  const [chatIdsText, setChatIdsText] = useState(initial.allowedChatIds.join(", "));
  const [notifyOnBlocked, setNotifyOnBlocked] = useState(initial.notifyOnBlocked);
  const [notifyOnBudgetExceeded, setNotifyOnBudgetExceeded] = useState(initial.notifyOnBudgetExceeded);
  const [notifyOnDone, setNotifyOnDone] = useState(initial.notifyOnDone);
  const [notifyOnRework, setNotifyOnRework] = useState(initial.notifyOnRework);
  const [allowRemoteActions, setAllowRemoteActions] = useState(initial.allowRemoteActions);
  const [botUsername, setBotUsername] = useState(initial.botUsername ?? "");
  const [hasToken, setHasToken] = useState(initial.hasBotToken);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(initial.lastError ?? null);
  const [notice, setNotice] = useState<string | null>(null);

  const parseChatIds = () =>
    chatIdsText
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const persist = async () => {
    const res = await saveTelegramConfig({
      enabled,
      allowedChatIds: parseChatIds(),
      notifyOnBlocked,
      notifyOnBudgetExceeded,
      notifyOnDone,
      notifyOnRework,
      allowRemoteActions,
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
    });
    setHasToken(res.config.hasBotToken);
    if (res.config.botUsername) setBotUsername(res.config.botUsername);
    setBotToken("");
    onSaved(res.config);
    return res.config;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await persist();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      if (botToken.trim()) {
        await persist();
      }
      const res = await testTelegramConnection();
      if (res.config) onSaved(res.config);
      if (!res.ok) {
        setError(res.error ?? "Connection test failed");
      } else {
        if (res.botUsername) setBotUsername(res.botUsername);
        setNotice(res.botUsername ? `Connected as @${res.botUsername}` : "Connected to Telegram");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md space-y-3 rounded-2xl border border-hairline bg-panel p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-[16px] font-semibold text-ink">
            <Send size={15} />
            <span>{t("workTasks.telegram.settingsTitle")}</span>
          </h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-secondary hover:bg-ink/[0.06]">
            <X size={16} />
          </button>
        </div>

        <p className="text-[12px] text-ink-secondary">{t("workTasks.telegram.settingsHint")}</p>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success">
            <CheckCircle2 size={13} />
            <span>{notice}</span>
          </div>
        )}

        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t("workTasks.telegram.enable")}</span>
        </label>

        <div className="space-y-1 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="font-medium text-ink-secondary">
              Bot Token {hasToken ? `(${t("workTasks.jira.tokenSaved")}${botUsername ? ` · @${botUsername}` : ""})` : ""}
            </span>
            <button
              type="button"
              disabled={testing || busy || (!hasToken && !botToken.trim())}
              onClick={() => void handleTest()}
              className="text-[11px] font-medium text-accent-text hover:underline disabled:opacity-50"
            >
              {testing ? "…" : t("workTasks.telegram.testButton")}
            </button>
          </div>
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={hasToken ? "••••••••" : "123456789:AAH..."}
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 font-mono text-ink"
          />
        </div>

        <label className="block space-y-1 text-[12px]">
          <span className="font-medium text-ink-secondary">{t("workTasks.telegram.allowedChats")}</span>
          <input
            type="text"
            value={chatIdsText}
            onChange={(e) => setChatIdsText(e.target.value)}
            placeholder="123456789, -100987654321"
            className="w-full rounded-lg border border-hairline bg-inset px-3 py-1.5 font-mono text-ink"
          />
          <span className="block text-[11px] text-ink-tertiary">{t("workTasks.telegram.allowedChatsHint")}</span>
        </label>

        <div className="space-y-1.5 rounded-xl border border-hairline bg-card p-3 text-[12px]">
          <div className="font-medium text-ink-secondary">{t("workTasks.telegram.alertsTitle")}</div>
          <label className="flex items-center gap-2 text-ink">
            <input type="checkbox" checked={notifyOnBlocked} onChange={(e) => setNotifyOnBlocked(e.target.checked)} />
            <span>{t("workTasks.telegram.notifyBlocked")}</span>
          </label>
          <label className="flex items-center gap-2 text-ink">
            <input
              type="checkbox"
              checked={notifyOnBudgetExceeded}
              onChange={(e) => setNotifyOnBudgetExceeded(e.target.checked)}
            />
            <span>{t("workTasks.telegram.notifyBudget")}</span>
          </label>
          <label className="flex items-center gap-2 text-ink">
            <input type="checkbox" checked={notifyOnDone} onChange={(e) => setNotifyOnDone(e.target.checked)} />
            <span>{t("workTasks.telegram.notifyDone")}</span>
          </label>
          <label className="flex items-center gap-2 text-ink">
            <input type="checkbox" checked={notifyOnRework} onChange={(e) => setNotifyOnRework(e.target.checked)} />
            <span>{t("workTasks.telegram.notifyRework")}</span>
          </label>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={allowRemoteActions}
            onChange={(e) => setAllowRemoteActions(e.target.checked)}
          />
          <span>{t("workTasks.telegram.allowRemote")}</span>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-ink/[0.06]"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-ink px-4 py-1.5 text-[13px] font-medium text-app hover:opacity-90 disabled:opacity-50"
          >
            {t("common.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
