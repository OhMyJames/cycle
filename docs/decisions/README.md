# 设计决策记录

一条决策一个文件,命名为 `NNNN-标题.md`,编号递增。状态:提议、已接受、已取代。

## 索引

- [0001 Claude 的 ACP 适配](0001-claude-acp-adapter.md):已接受(自己写,不用官方包)
- [0002 session 持久化](0002-session-persistence.md):已接受(daemon 自己存 JSONL,是历史唯一来源)
- [0003 L1 schema 的事实来源](0003-schema-source.md):已接受(zod)
- [0004 v1 鉴权](0004-auth.md):已接受(仅 SSH 和 socket 权限)
- [0005 以 ACP v2 为蓝本,L1 自己定义类型](0005-acp-v2.md):已接受(方案 C)
- [0006 只管理 Cycle 自己的 session](0006-own-sessions.md):已接受
- [0007 每个 session 一个常驻的 Claude 进程](0007-resident-claude-process.md):已接受(空闲时释放)
- [0008 发布:不用打包器,签名加公证](0008-release-without-a-packager.md):已接受
- [0009 应用自己更新自己](0009-self-update.md):已接受(自己写,不用 Squirrel)
- [0010 附件以 ACP 内容块内联发送](0010-attachments-inline.md):已接受(有大小上限;落盘方案推迟)
- [0011 agent 向用户提问(elicitation)](0011-elicitation.md):已接受(只发给声明了能力的客户端,没有就回退)
- [0012 界面的源语言是 en-US,为 i18n 预留](0012-ui-language-en-us.md):已接受(文字进消息目录;新文字走目录,存量由棘轮只减不增)
- [0013 附件字节落盘,日志里只留引用](0013-attachment-blobs.md):已接受(包在存储接口外面,读出时还原)
- [0014 新 session 提前起进程;子 agent 只做通告](0014-warm-start-and-subagents.md):已接受(提前起是开关,默认关);子 agent 只做通告的部分已被 [子 agent 的对话转发到客户端](../../.agents/notes/2026-11-23-subagent-conversations-are-forwarded.md) 取代
