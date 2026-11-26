<div align="center">

# LOOMA

**Không gian làm việc đa AI Agent cục bộ (Local-first): Group Chat + 3D Classroom + Quản lý Task Kanban + Auto-QA + Jira 2 chiều + Điều khiển từ xa qua Telegram.**

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Electron](https://img.shields.io/badge/Electron-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-2B2E3A?logo=electron&logoColor=9FEAF9)
![Three.js](https://img.shields.io/badge/3D%20Classroom-Three.js-000000?logo=threedotjs&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D24-339933?logo=node.js&logoColor=white)

<sub>Phát triển dựa trên nền tảng mã nguồn mở <a href="https://github.com/milind-soni/OpenMausBot">OpenMausBot</a> (Apache 2.0). Dữ liệu hội thoại, task và cấu hình lưu cục bộ tại <code>~/.openmausbot</code>.</sub>

</div>

---

## Tính năng nổi bật của LOOMA

- **Group Chat đa AI Agent & 3D Classroom:** Tạo nhiều Agent với vai trò riêng (PM, Frontend, Backend, QA, DevOps...), phối hợp làm việc trong cùng một phòng và quan sát trực quan trên không gian **3D Classroom** (`Three.js`).
- **Quản lý công việc AI (Tasks Workspace):**
  - Bảng **Kanban** theo phòng hỗ trợ **Task cha / Subtask**, gán Agent phụ trách và bấm **Run Task** trực tiếp.
  - **Auto-QA & Auto-Rework:** Tự động chuyển cho QA Agent kiểm tra khi Task sang `In Review`; nếu chưa đạt sẽ tự đẩy về `Rework` cho Agent phụ trách sửa lại (tối đa 3 vòng).
  - **Budget Cap & Usage:** Đặt trần chi phí USD cho từng Task, tự động cộng dồn chi phí token từ các lượt chạy và dừng/cảnh báo khi vượt ngân sách.
  - **Execution Timeline:** Theo dõi lịch sử thực thi theo dòng thời gian (ai làm gì, chuyển trạng thái, QA duyệt, lỗi/rework).
- **Đồng bộ Jira 2 chiều (chỉ cần API Token):** Đẩy Task/Subtask từ LOOMA lên Jira và kéo ngược (**Pull from Jira**) về LOOMA, tự ánh xạ trạng thái, Subtask và người phụ trách.
- **Điều khiển & cảnh báo qua Telegram (Long Polling — không cần ngrok/mở port):**
  - **Mức 1 (Xem tiến độ):** `/status`, `/tasks`, `/task <KEY>`, `/blocked`, `/myid`, `/help`.
  - **Mức 2 (Cảnh báo tự động):** Đẩy tin nhắn khi Task `Blocked/Failed`, vượt `Budget Cap`, `Done`, hoặc `Rework`.
  - **Mức 3 (Điều khiển từ xa):** `/run <KEY>`, `/qa <KEY>`, `/comment <KEY> <nội dung>` (hỗ trợ cả chat cá nhân lẫn Group Chat).
- **Hệ sinh thái công cụ tích hợp:** Trình duyệt tích hợp, Team Files, Published Apps (`show_html`), Connected Apps (Composio / MCP Servers), Routines (lịch chạy tự động), Voice/TTS và điều khiển máy tính cục bộ/Cloud.

---

## Yêu cầu môi trường

Trước khi chạy từ source code, máy cần cài sẵn:

1. **Hệ điều hành:** Windows x64, macOS, hoặc Ubuntu 24.04 x64.
2. **Node.js `>= 24`** — kiểm tra bằng `node -v`.
3. **pnpm `10.x`** — cài qua Corepack hoặc npm:
   ```sh
   corepack enable
   # hoặc: npm install -g pnpm
   ```
4. **Ít nhất một AI Engine:**
   - Cài và đăng nhập sẵn một trong các CLI cục bộ: [`claude`](https://claude.com/claude-code), [`codex`](https://github.com/openai/codex), hoặc [`grok`](https://x.ai/cli), **HOẶC**
   - Dán API Key (Anthropic, OpenAI, OpenRouter, Gemini, ...) trực tiếp trong **Settings → AI** sau khi mở app.

---

## Cài đặt & Chạy từ source (Quick Start)

### 1. Clone repo & cài dependencies

```sh
git clone https://github.com/trungduc81/OpenMausBot.git
cd OpenMausBot
pnpm install
```

### 2. Chạy ở chế độ Web (nhanh nhất để phát triển)

Mở **2 cửa sổ terminal** tại thư mục dự án:

**Terminal 1 — Chạy Harness Server (`http://127.0.0.1:8799`):**
```sh
pnpm dev:server
```

**Terminal 2 — Chạy Frontend Vite (`http://127.0.0.1:5199`):**
```sh
pnpm dev
```

Sau đó mở trình duyệt và truy cập: **`http://127.0.0.1:5199`**

### 3. Chạy ở chế độ Desktop App (Electron)

Giữ nguyên 2 terminal ở bước 2 đang chạy, mở thêm **Terminal 3**:

```sh
pnpm dev:desktop
```

---

## Cấu hình nhanh sau khi mở app

Mọi API key và token đều cấu hình trực tiếp trên giao diện (không cần sửa code):

1. **AI Provider / Model:** Vào **Settings → AI** để chọn CLI cục bộ (`claude` / `codex` / `grok`) hoặc thêm API key nhà cung cấp mô hình.
2. **Jira (tùy chọn — theo từng phòng):** Mở tab **Tasks → Jira Settings** → nhập Site URL, Email, Jira API Token và Project Key → bấm **Test** và **Pull from Jira** / bật Auto-Sync.
3. **Telegram Control Plane (tùy chọn — dùng chung toàn LOOMA):**
   - Tạo bot với `@BotFather` trên Telegram để lấy **Bot Token**.
   - Mở tab **Tasks → Telegram** → dán Bot Token → bấm **Kiểm tra Token** và bật **Long Polling**.
   - Nhắn `/myid` cho bot (trong chat riêng hoặc trong nhóm Telegram) để lấy Chat ID (ID nhóm có dấu `-` ở đầu, ví dụ `-1001234567890`) rồi dán vào **Allowed Chat IDs**.
4. **Connected Apps (tùy chọn):** Vào **Apps** để kết nối Composio hoặc thêm MCP Server riêng cho các bot sử dụng.

---

## Kiểm tra code & Đóng gói ứng dụng (.exe / .dmg / .deb)

### Các lệnh kiểm tra chất lượng

```sh
pnpm typecheck       # Kiểm tra TypeScript (frontend + server + phone-protocol)
pnpm lint            # Kiểm tra lint bằng oxlint
pnpm test            # Chạy bộ test tự động
pnpm build           # Build production (tsc + vite build)
pnpm check:electron  # Kiểm tra cú pháp các file Electron main/preload
```

### Đóng gói file cài đặt Desktop

```sh
pnpm package:win     # Windows x64 → tạo file cài đặt & bản portable trong release/
pnpm package:mac     # macOS (DMG + ZIP; cần Xcode Command Line Tools)
pnpm package:linux   # Ubuntu x64 (.deb + AppImage)
```

Trên Windows, sau khi chạy `pnpm package:win`, kết quả nằm trong thư mục `release/`:
- `release/OpenMausBot-<version>-setup.exe` — Bộ cài đặt 1-click (per-user, không cần quyền Admin).
- `release/Looma-<version>-x64.zip` — Bản nén giải nén dùng ngay.
- `release/win-unpacked/Looma.exe` — File thực thi đã giải nén sẵn.

> **Lưu ý trên Windows:** Nếu bộ cài chưa được ký chứng chỉ thương mại, Windows SmartScreen có thể hiện cảnh báo *"Unknown publisher"* → chọn **More info → Run anyway**.

---

## Cấu trúc dự án

| Thư mục | Vai trò |
|---|---|
| `src/` | Giao diện React 19 + Vite + Tailwind CSS, bao gồm `src/components/room-classroom3d/` (3D Classroom) và `src/components/work-tasks/` (Kanban, Timeline, Jira, Telegram UI). |
| `server/` | Harness server (`127.0.0.1:8799`), HTTP + SSE API, driver các AI CLI (`server/drivers/`), Work Tasks store & runtime (`work-tasks*.ts`). |
| `packages/phone-protocol/` | Kiểu dữ liệu dùng chung (trong đó có schema `work-tasks.ts`). |
| `shared/` | Helper và hợp đồng wire dùng chung giữa frontend & server. |
| `electron/` | Lớp vỏ Desktop Electron (main, preload, updater, tích hợp nền tảng). |
| `docs/` | Tài liệu kỹ thuật (MCP server, headless CLI, Composio, self-hosting...). |

---

## Xử lý sự cố thường gặp

- **Lỗi Node version / `--experimental-strip-types`:** Đảm bảo đang dùng **Node.js 24 trở lên** (`node -v`).
- **Cổng `8799` hoặc `5199` đã bị chiếm:** Tắt tiến trình cũ đang chạy trên cổng đó, hoặc cấu hình biến môi trường `OMB_PORT` cho server.
- **Bot Telegram không trả lời trong nhóm:** Kiểm tra đã copy **cả dấu trừ `-`** của Group Chat ID vào `Allowed Chat IDs` chưa (nhắn `/myid@TenBot` trong nhóm để lấy lại nếu nhóm vừa nâng cấp lên Supergroup).
- **Chạy test riêng phần Work Tasks:**
  ```sh
  pnpm exec vitest run work-tasks RoomTasksWorkspace
  ```

---

## Giấy phép & Ghi công

Dự án được phát hành theo [Apache License 2.0](LICENSE) dựa trên nền tảng mã nguồn mở [OpenMausBot](https://github.com/milind-soni/OpenMausBot) © 2026 Milind Soni và các cộng tác viên (ngoại trừ thư mục `enterprise/` tuân theo [giấy phép riêng](enterprise/LICENSE)). Xem thêm chi tiết tại [LICENSING.md](LICENSING.md).
