# cycle

基于 [codex app-server](https://developers.openai.com/codex) 的 agent 运行时环境。Bun + TypeScript + Electron。

## 架构

```
apps/desktop  (Electron)          apps/daemon  (Bun)             harness/codex               codex app-server
┌──────────────────────┐  WS     ┌───────────────────┐  Harness  ┌──────────────┐  JSON-RPC  ┌──────────────┐
│ main: 拉起 daemon     │ ──────▶ │ 会话管理 / 事件扇出 │ ────────▶ │ 协议翻译       │ ─────────▶ │ thread / turn │
│ renderer: packages/ui │ ◀────── │ 会话快照           │ ◀──────── │ 子进程管理     │ ◀───────── │ item / 审批   │
└──────────────────────┘ events  └───────────────────┘  events   └──────────────┘   stdio    └──────────────┘
            └──────────────── packages/protocol（领域模型 + wire 协议 + reducer）────────────────┘
```

| 目录 | 职责 |
| --- | --- |
| `packages/protocol` | 与具体 agent 无关的领域模型（`Item` / `SessionEvent`）、client↔daemon 的 wire 协议、`Harness` 接口，以及 daemon 和 UI 共用的 `reduceSession` |
| `harness/codex` | 用 stdio 驱动一个 `codex app-server` 子进程，把 codex 的 thread/turn/item 翻译成 `packages/protocol` 的事件 |
| `apps/daemon` | 本地 WebSocket 服务（默认 `127.0.0.1:4747`）。持有会话，窗口关掉会话也还在；只依赖 `Harness` 接口 |
| `packages/ui` | React 组件 + `CycleClient`（daemon 的类型化 WS 客户端） |
| `apps/desktop` | Electron 壳：main 进程拉起 daemon，renderer 渲染 `packages/ui` |

几个设计取舍：

- **daemon 以上的层不认识 codex。** 接别的 agent 只需要新增一个 `harness/<name>` 实现 `Harness` 接口。
- **状态是事件流的 fold。** daemon 和 UI 用同一个 `reduceSession`，所以后加入的客户端 `session.get` 拿快照、再叠加后续事件即可。
- **一个 codex 进程承载多个会话**，Cycle 的 session 与 codex 的 thread 一一对应。

## 运行

```bash
bun install
```

```bash
bun run dev
```

codex 需要凭证：先 `bunx codex login`，或设置 `OPENAI_API_KEY`。

只跑 daemon（desktop 可用 `CYCLE_DAEMON_URL=ws://127.0.0.1:4747/ws` 连接已有 daemon）：

```bash
bun run dev:daemon
```

| 环境变量 | 作用 |
| --- | --- |
| `CYCLE_DAEMON_PORT` | daemon 端口，`0` 为随机 |
| `CYCLE_DAEMON_URL` | desktop 连接已有 daemon，而不是自己拉起 |
| `CYCLE_CODEX_BIN` | 指定 `codex` 可执行文件（默认用依赖里的 `@openai/codex`） |
| `CYCLE_CODEX_CONFIG` | JSON，作为 `codex -c key=value` 覆盖项，如 `{"model":"gpt-5"}` |
| `CYCLE_DEBUG=1` | 打印 codex app-server 的日志 |

## 测试

```bash
bun test
```

```bash
bun run typecheck
```

`apps/daemon/test/e2e.test.ts` 用一个假的 Responses API（`mock-responses.ts`）顶替模型，真实地跑通
codex app-server → harness → daemon → WS 客户端，不需要凭证和网络。

## MVP 范围

已有：单会话聊天、流式输出、命令 / 文件改动条目展示、审批弹窗、中断。

还没有：多会话 UI、会话持久化与恢复（`thread/resume`）、daemon 鉴权、断线重连、应用打包。
