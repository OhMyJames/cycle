# 上手:安装和使用

Cycle 由两部分组成:**桌面应用**(macOS,Apple 芯片)和 **daemon**(运行 agent 和保存会话的后台程序)。daemon 可以在你的 Mac 上(应用自带),也可以在远端的 Linux 机器上,应用通过 ssh 连它。

## 1. 安装 Mac 应用

从 GitHub 的 Releases 下载 `Cycle-<版本>-darwin-arm64.zip`,解压得到 `Cycle.app`,放进"应用程序"。

- 只有 Apple 芯片(M 系列),没有 Intel 版。
- 从 0.3.16 起,发布的包有 Developer ID 签名并经过公证,下载后直接打开即可。
- 0.3.15 及更早的发布只有 ad hoc 签名(Release 标成 pre-release)。浏览器下载的这类包会被 Gatekeeper 拦住,要先去掉隔离标记:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Cycle.app
  ```

  已经装了旧版的,用应用内更新升到 0.3.16 就行,不需要重新下载。
- 校验:同一个 Release 里有 `latest-darwin-arm64.json`,里面是 zip 的 sha256 和大小。

应用里自带 daemon 和 Claude,所以装完之后"This computer"这个主机就能用,不需要另外装任何东西。

## 2. 给 Claude 凭证

daemon 启动 Claude 时**不继承**你 shell 的环境变量(防止你环境里的 API key 悄悄计费),凭证要明确写在 daemon 所在机器的 `<数据目录>/config.json`。数据目录默认 `~/.cycle`(`CYCLE_HOME` 可改)。

三种方式,选一种:

**A. 订阅账号的 OAuth token(推荐)**:在任意一台装了 Claude Code 的机器上运行 `claude setup-token`,得到一个长期 token,写进 config.json:

```json
{ "claude": { "env": { "CLAUDE_CODE_OAUTH_TOKEN": "<token>" } } }
```

**B. API key**:

```json
{ "claude": { "env": { "ANTHROPIC_API_KEY": "<key>" } } }
```

**C. 在 daemon 的机器上登录**:`cycle login`(应用自带的在 `Cycle.app/Contents/Resources/app/bin/cycle`)。登录信息存在 `<数据目录>/claude`,不会碰你的 `~/.claude`。这一条需要浏览器完成 OAuth,还没有在真实账号上完整验证过。

写完请收紧权限:`chmod 600 ~/.cycle/config.json`。其他可选项(模型、已有的 Claude 配置目录、环境白名单)见 [daemon.md](daemon.md)。

## 3. 在远端 Linux 机器上装 daemon

在远端 Linux x64 或 ARM64 机器上，从同一 Release 下载 `install.sh` 和 `install.sh.sha256`，把下面的版本换成该 Release 的标签。安装器识别架构，下载对应包并校验 SHA-256。

```bash
sha256sum -c install.sh.sha256
sh install.sh v0.3.1
```

离线安装时，将对应的 `cycle-linux-x64.tar.gz` 或 `cycle-linux-arm64.tar.gz` 及其 `.sha256` 放在安装器旁，执行 `sh install.sh`。

`install.sh` 只装给当前用户,不要 root:程序放在 `~/.local/share/cycle/`,`~/.local/bin/cycle` 是一个启动器。机器上不需要 Bun、Node,也不需要装 `claude`。然后按第 2 节在那台机器上写 config.json。

不需要手动启动:应用连接时(`cycle proxy`)会把 daemon 起起来,它脱离 ssh 连接继续运行,所以断线后会话照常进行。

```bash
cycle status   # 是否在运行
cycle stop     # 停掉;有会话在工作时会列出来,问你等它们结束还是立即中断
cycle stop --wait    # 等所有会话结束再停
cycle stop --force   # 立即停:进行中的回合标为"已中断",排队的消息保留
```

**升级**:重新下载,再运行一次 `install.sh`。已经在运行的 daemon 继续用旧文件,直到你 `stop` 它,下一次连接会起新的。被中断的回合在历史里会标明是 daemon 停止打断的,重新连上后可以看到;重启后不会自动接着做。

## 4. 在应用里添加远端主机

1. 先在 Mac 终端里手动 `ssh user@host true` 一次。应用的 ssh 是非交互的(`BatchMode=yes`),不会问你是否信任主机、也不会问密码,所以主机密钥要已经在 `known_hosts` 里,登录要用密钥(或 ssh-agent)。
2. 应用里点 "Add environment":名字随便起;Address 填 `ssh` 能认的(`user@host`,或 `~/.ssh/config` 里的别名);命令默认 `cycle proxy`。
3. 如果连不上并提示找不到命令,是因为 ssh 非交互会话的 PATH 里没有 `~/.local/bin`。把命令改成绝对路径:`/home/<用户>/.local/bin/cycle proxy`。

## 更新

应用启动时检查一次更新,之后每分钟检查一次;侧栏底部 App settings 菜单(齿轮)里的 "Check for updates" 可以立即检查。发现新版本时顶部出现横幅,点 "Update and restart" 并确认,应用会下载、校验、替换自己并重新打开。"This computer" 上正在工作的会话会被中断,远端主机上的会话不受影响。

应用放在你有写权限的目录(`/Applications` 通常可以,`~/Applications` 也行)。直接从下载位置打开的应用不能更新自己,先把它移到应用程序里。

远端 Linux 机器上的 `cycle` 不会自己更新。只有它**低于这个应用要求的最低版本**时,选中那台主机才会在标题栏下面看到一行提示和一个"Update to …"按钮;点了并确认,应用会通过 ssh 在那台机器上完成下载、校验、安装并停掉旧的 daemon(下一次连接会起新的)。失败时提示会附上同样的命令,可以手动在那台机器上运行。运行后正在工作的会话会被中断。`cycle version` 可以看那台机器上装的是哪个版本。

## 5. 用

选环境,"New session",选工作目录,开始对话。Claude 要执行命令或改文件时会弹出确认卡片,Allow 或 Deny。输入框下方工具条显示上下文用量、累计费用以及权限模式和模型设置,点击可切换,齿轮按钮可改全部会话设置;"Agent defaults" 设新会话的默认值。

## 排障

- **主机一直 connecting/closed**:在终端里手动运行和应用同一条命令,比如 `ssh user@host cycle proxy`,看它输出什么(应该是安静地等待输入)。
- **Claude 不可用(`available: false`)**:`claude` 二进制不在 `cycle` 旁边,重新运行 `install.sh`。
- **提示没有凭证或认证失败**:检查那台机器上的 config.json;注意 daemon 不读你的 shell 环境变量。
- **看 daemon 的日志**:在那台机器上 `cycle logs`(最后 100 行),`cycle status` 会给出文件位置(`<数据目录>/daemon.log`,只有你能读,自动轮转,最多约 4 MB)。里面只有发生了什么和出了什么错,没有 prompt、回答和凭证。daemon 意外退出时,原因和出错的代码位置在最后几行;要更细的记录,在 `config.json` 里设 `"log": { "level": "debug" }`。

## 安全

- daemon 只监听数据目录里的 unix socket(权限 0600,目录 0700),不监听网络。远程访问**只**走 ssh,谁能 ssh 登录这个用户,谁就能用这个 daemon,也就能让 Claude 在那台机器上以这个用户的身份执行命令。
- config.json 里的凭证是明文,靠文件权限保护。
- 删除会话是永久的,应用会先确认。
