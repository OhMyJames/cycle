# Agent Note: 随 Cycle 发的 plugin 由 daemon 静默装好,免确认,能停用不能卸载

Status: accepted
Date: 2026-11-24
Basis: 负责人 2026-11-24 的要求:团队自己做的 plugin 放进 `packages/clawdot-plugins`(包名 `clawdot-plugins`,每个 plugin 一个子目录),内置在 Cycle 里,静默安装,默认启用,用户可以关掉;claude、agy、codex 一起做。

## Problem

团队内部工具要随 Cycle 到每台机器、每个 agent 上。三家的 plugin 机制各自独立([plugin 归 agent](2026-11-23-plugins-are-the-agents-their-mcp-is-cycles.md)),Cycle 不能自己写它们的安装目录。同时那条决定要求安装带 `acknowledged`,静默安装和它冲突。

## Decision

1. **源只有一份,Claude 的目录布局**(`.claude-plugin/plugin.json`、`skills/`、`.mcp.json`),不生成各家的产物。2026-11-24 实测:Claude 和 Codex 直接读(Codex 认 `.claude-plugin/`),agy 的 `plugin install <目录>` 自己转换(`agy plugin validate` 对未转换的 Claude 目录报错,但 `install` 可以)。
2. **安装走各家自己的命令**:Claude、Codex 把 `clawdot-plugins` 目录作为名为 `clawdot` 的本地 marketplace 加进去,再 `install name@clawdot`;agy 按目录 `install`(它没有 marketplace 管理命令,而且它的 marketplace.json 要求 `source` 是对象,和 Claude 的不通用)。这是 `PluginProvider.ensureBuiltin`。
3. **静默安装免 `acknowledged`**:这一批是 Cycle 自己的代码,随应用签名分发;`acknowledged` 约束的是用户从外部来源装代码。外部来源的路径不变。
4. **只装一次,之后尊重用户**:没装就装,已装且版本一样不动,版本落后才更新。用户停用的保持停用:Codex 的 `plugin add` 会把它重新打开,所以更新后要按原来的状态写回。
5. **能停用,不能卸载**。卸载后下次启动又装回来,语义自相矛盾,所以 `uninstall` 拒绝,界面不显示入口。L1 的 `Plugin.builtin` 标出它们(按名字,来自随应用发的清单)。
6. **失败不挡任何事**:agent 没装好、命令失败都只记一条 `builtin_plugins_failed`,下次启动这个 agent 之前再试。

## 实测

2026-11-24,隔离的 HOME 和配置目录:三家第一次都装上;再跑一次、用户停用后再跑,状态不变;把版本从 0.1.0 改到 0.3.0 再跑,三家都更新,停用的仍然停用(Codex 靠写回)。Codex 没有启停命令,开关是 `$CODEX_HOME/config.toml` 的 `[plugins."id"] enabled`,由 `CodexPlugins.setEnabled` 只改这一行。

没有验证:Windows;应用换了安装路径后 marketplace 路径的更新(代码里按路径比较并重加,没有真机测过);打包后的应用(`apps/daemon/scripts/build.ts` 把目录放在可执行文件旁边的 `clawdot-plugins/`,桌面端 `package.ts` 复制到 `bin/`,没有真的打包跑过)。

## Alternatives considered

- **生成器,为每家产出一份**:没有需要。三家已经能读或转换同一份源。
- **Cycle 自己把 plugin 写进各家的安装目录**:违背"plugin 归 agent"的决定,格式是它们内部的。
- **内置的也要求确认**:每个用户第一次启动要点一堆框,装的是我们自己的东西。
- **卸载后记住"用户不要它"**:多一份状态,要界面和语义都配合;停用已经满足需求。

## Related

- [plugin 归 agent](2026-11-23-plugins-are-the-agents-their-mcp-is-cycles.md):安装由 agent 自己的机制做、`acknowledged` 的来源。
