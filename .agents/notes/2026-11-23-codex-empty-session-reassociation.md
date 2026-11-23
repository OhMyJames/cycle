# Agent Note: Codex 空会话恢复允许关联新的 agent session ID

Status: accepted
Date: 2026-11-23
Basis: CYCL-152 实施阶段评审；Codex CLI 0.171.0 真实账号测试与 daemon 集成测试（2026-11-23）

## Problem

Codex 在 `thread/start` 后、第一轮结束前可能还没有可恢复的 rollout。daemon 仍然需要保留 Cycle 的 L1 `sessionId`，同时不能让 Codex 伪造一个不存在的旧 thread。已有回答回合的记录丢失时，自动创建新 thread 会掩盖数据丢失。

## Decision

恢复时，Codex 先尝试 `thread/resume`。只有 app-server 明确返回原 thread 没有 rollout，且 daemon 没有记录已回答回合时，适配器才创建新 thread，并在 `session/resume` 的 `_meta["cycle/agentSessionId"]` 返回新 ID。daemon 在恢复设置和接受下一条 prompt 前，先校验并持久化新的映射。daemon 已记录 `cycle/hadTurn` 时，恢复失败直接报告 `resume_failed`，不能换成新 thread。

## Alternatives considered

- 让 Codex 适配器在自己的 `CODEX_HOME` 保存 `Cycle sessionId → threadId`：没有选择，因为会增加一份可能和 daemon 索引不一致的状态。
- 恢复失败时静默创建新 thread：没有选择，因为会把已有对话的数据丢失伪装成一段新对话。

## Consequences

L1 客户端继续只看到稳定的 Cycle session ID。Codex 的 agent session ID 只出现在 daemon 索引和适配器内部。首次 prompt 尚未完成的会话可能在恢复后关联新 ID。真实账号测试已覆盖随机字符串跨 daemon 重启，模拟测试覆盖空 thread 关联、拒绝命令和已回答记录缺失。
