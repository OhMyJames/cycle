# Agent Note: 用户账号用 SSO 登录，桌面端必须登录

Status: accepted
Date: 2026-11-23
Basis: 2026-11-23,CYCL-149;未定的四条由 CYCL-150 调研后定下;同日按负责人的意见改为 RFC 8693 优先。实现拆成两个 epic:CYCL-149 Cycle 支持 SSO 登录,CYCL-164 Itsaplan 内置服务。原先写成 `docs/decisions/0015-sso-login.md`(未提交),按 AGENTS.md(新笔记不再放进 `docs/decisions/`)写到这里，正文未改，只换了小节标题。

## Problem

Cycle 要接入 Itsaplan(CYCL-148:工作区升级为项目工作台,Issues 来自 Itsaplan)。SSO 背后的 provider 和 Itsaplan 等服务是打通的,登录一次以后,访问各服务只是换 token 的问题。

Cycle 现在没有"用户是谁"这一层。决策 0004 讲的是另一件事:app 和 daemon 之间只靠 SSH 和 socket 文件权限,协议里没有 token。

SSO 和兄弟仓库用的是同一套(负责人要求一致):shrimpdot-durable(`.agents/notes/implemented/feature/2026-10-08-company-sso-sign-in.md`、`bug-fix/2026-10-11-company-token-renewed-by-itself.md`)和 cycle_v2(`.agents/notes/2026-11-08-clawdot-account-in-the-daemon.md`、`packages/oidc`、`apps/daemon/src/account/`)。这里取它们的参数和踩过的坑;它们都把登录放在 daemon 里,我们放在桌面端,理由见"为什么不是别的"。

## Decision

- **桌面端必须登录。** 没登录时打开 Cycle 直接进登录页,登录后才能用。不做"不登录也能用本地功能"的模式。
- **只有桌面端强制登录。** daemon、`cycle` CLI、测试和 harness 不验证用户身份。决策 0004 不变:app 和 daemon 之间仍然只靠 SSH 和 socket 文件权限。
- **登录态在桌面端。** 长期凭证(refresh token)存在本机钥匙串,只有桌面端主进程持有;各环境的 daemon 只拿换出来的服务凭证(比如 Itsaplan 的),用于界面上的 Itsaplan 页面和给 agent 的 Itsaplan connector。
- **agent 拿不到 token。** Itsaplan 作为内置 connector,经 daemon 的 MCP 网关接给 agent,和现有 connector 一样(见 [2026-11-19-connectors-behind-a-daemon-gateway](2026-11-19-connectors-behind-a-daemon-gateway.md))。
- **离线宽限期。** 断网或 IdP 不可用时,登录过的人在宽限期内照常能用;只有 Itsaplan 这类在线功能暂时不可用,并说明原因。超过宽限期才回到登录页。
- **token 过期或被吊销不踢人。** 正在跑的会话继续跑,只提示重新登录;在线功能等重新登录后恢复。
- **升级不丢东西。** 已经在用的人升级后第一次打开会进登录页,本地的会话、设置、connector 原样保留。

### SSO 的参数(同 shrimpdot-durable 和 cycle_v2)

- IdP 是 authentik,issuer `https://sso.shrimpdot.ai/application/o/clawdot-team/`,复用公共客户端 `clawdot-team`(没有 client secret)。端点一律从 discovery 读,不写死路径。
- 授权码 + PKCE(S256),校验 `state`(常量时间比较)和 `nonce`;回调由主进程在 `http://127.0.0.1:<随机端口>/callback` 上接,只收一次;scope `openid profile email offline_access`(`offline_access` 才有 refresh token)。shrimpdot-durable 2026-10-08 对真实 authentik 验证过:随机端口的 `127.0.0.1` 被接受,`localhost` 和别的路径被拒。
- authentik 每次续期都**轮换 refresh token**,旧的随即作废,同一个 refresh token 用两次会让整条链失效。所以:全机只有桌面端主进程一个持有者;续期串行(同一时刻只有一个续期在跑,其余等它的结果);每次续期都把新的 refresh token 写回钥匙串;续期结果的 `sub` 必须和原来的相同。**稳定版和开发版各有一份登录**(钥匙串里的条目名不同),不共用,否则两个版本互相作废。
- 续期按需:access token 只在换服务凭证、启动时确认身份时才用,快到期(还剩不到 2 分钟)才续。定时器不可信(电脑睡眠时不走),每次用之前都看一眼时钟。
- 钥匙串:应用从 0.3.16 起用 Developer ID 签名,兄弟仓库"等签名之后再进钥匙串"的前提已经满足。从源码运行(未签名)和测试不碰真实钥匙串:测试用一个替身 IdP(照 shrimpdot-durable 的 `mock-idp.ts`:强制 PKCE、校验回调地址、一次性授权码、轮换 refresh token)和文件存储,由环境变量指向;这个变量只换 issuer,不关掉登录。
- 日志和埋点里永远不出现任何 token;报错文字不带请求内容。

### 1. 服务凭证怎么换:RFC 8693 token exchange,备选是 Itsaplan 铸个人 key

调研结论:

- Itsaplan 和 `clawdot-team` 是同一个 authentik 下的**不同应用**,`clawdot-team` 签的 token 的 audience 不是 Itsaplan。
- 线上 discovery(2026-11-23 读)的 `grant_types_supported` 里还没有 token exchange;负责人说明 authentik 支持,只是没开启,由他开启(CYCL-165,里面写了 Cycle 需要的请求形状和条件)。
- authentik 的"federated provider"(拿一个应用的 JWT 走 `client_credentials` + `client_assertion` 换另一个应用的 token)换出来的是 authentik **按 provider 名和 `sub` 生成的服务账号**,不是这个人,也没有 refresh token(authentik 2026.8 文档),不用。

做法:桌面端主进程用 `clawdot-team` 的 access token 做 RFC 8693 exchange(`subject_token_type` 为 access token,`audience` 为 Itsaplan 的 client_id,scope 带 `offline_access`),换出 audience 是 Itsaplan、`sub` 是同一个人的 access token,**以及一条 Itsaplan 自己的 refresh token**。Itsaplan 的 MCP 和 REST 接受这种 JWT(CYCL-160)。

前提有两条,CYCL-165 里要确认:公共客户端 `clawdot-team` 不带 secret 就能 exchange(桌面应用里存不住 secret);响应里带 refresh token。**任一条做不到就用备选**:Itsaplan 提供铸 key 的端点,收 `clawdot-team` 的 access token,发一个不过期、可吊销的个人 key(cycle_v2 对 llm-portal 的做法),其余流程不变,只是 daemon 不用续期。

以后再接别的服务,同样各换各的;Cycle 这边每个服务是一个凭证来源,形状相同。

### 2. 宽限期:30 天,从最后一次成功联系 IdP 算起

- 续期因为网络、超时、IdP 的 5xx 失败时,仍算登录着;从最后一次成功续期(或登录)起 **30 天**内照常能用,之后回到登录页。
- 30 天和 refresh token 的有效期一样长(cycle_v2 记录的是 30 天的 refresh token;每次续期都换新的,所以有效期是滑动的)。离线超过它,refresh token 本来也用不了了。实现前要在 authentik 上确认 `clawdot-team` 的 refresh token 有效期不短于 30 天。
- 宽限期只管"能不能打开 Cycle"。各环境 daemon 手里的 Itsaplan 凭证由 daemon 自己向 IdP 续期:IdP 挂了时,现有的 access token 在有效期内照常用,过期后 Itsaplan 暂时不可用并说明原因,IdP 恢复后自动续上,不需要桌面端。(用备选的个人 key 时不依赖 IdP。)
- IdP 明确拒绝(`invalid_grant`:refresh token 过期、被吊销或已被用过)才算登录失效:按上面"不踢人"的规则,正在用的窗口只提示重新登录,下次打开才进登录页。

### 3. 远程环境:桌面端为每个环境换一条,单向送给那个 daemon,daemon 自己续期

- 桌面端连上一个环境(本机或 SSH 远程)、且已登录时,如果那个 daemon 说它还没有 Itsaplan 的凭证,主进程做一次 exchange,把换来的 access token 和 refresh token 送给它。**每个环境单独换一次**,所以每个环境各有一条互不相干的 refresh token 链,daemon 是自己那条链唯一的持有者。refresh token 每次续期都轮换,一条链只能有一个持有者;每个环境各换一条,这条规则就不会被违反。
- 走的是 connector 密钥那一条路:**只从主进程到 daemon 一个方向**,daemon 永远不回传,读接口只说"有没有、是谁的"(`sub`、显示名)。凭证由主进程直接送,不经过页面。daemon 把它存在 connector 的 `CredentialVault` 里(0600),只有网关和 daemon 自己访问 Itsaplan 时用。协议上是 `_cycle/account/*`,先写进 `docs/protocol.md` 再实现。
- **daemon 自己续期**(串行,每次写回新的 refresh token),所以桌面端关了、远程 daemon 上的会话还在跑时,Itsaplan connector 照常可用。这是不选"桌面端每小时推一次短期 token"的原因。daemon 拿到的只是 Itsaplan 这一个 audience 的凭证,`clawdot-team` 的 refresh token 仍然只在桌面端。
- **失效时**:Itsaplan 回 401,daemon 先续一次再重试;续期得到 `invalid_grant`,daemon 删掉凭证,向连着的客户端发 `_cycle/account/changed`(带原因);桌面端收到后如果还登录着,就重新 exchange 送过去。同一时刻一个环境只有一次 exchange。防止兜圈子:桌面端自己替换的凭证 10 分钟内又失效,就不再自动换,改为提示"有别的东西在吊销它"(做法同 shrimpdot-durable 的 `renewal-guard`)。桌面端不在时,daemon 只能等下次连上;这时 connector 对 agent 回"需要登录",不让 agent 自己去授权(同 connector 网关回 403 而不是 401 的做法)。
- 在 SSH 线路上送凭证,和 connector 密钥一样受 0004 的保护(SSH 加 socket 权限),不另加加密。

### 4. 退出登录、换账号:清服务凭证,不动本地数据

- **退出登录**:连着的环境由 daemon 吊销自己那条 Itsaplan refresh token 并删除凭证;桌面端向 authentik 的 revocation 端点吊销 `clawdot-team` 的 refresh token,删掉钥匙串里的条目,回到登录页。吊销失败只记日志(不带 token),本地照常退出。当时没连上的环境,下次连上时删掉它的凭证(daemon 报来的 `sub` 和当前登录的不同,或当前没有登录,都删);如果 authentik 能在吊销 `clawdot-team` 的 token 时连带吊销从它换出的 token(CYCL-165 第 8 条),离线环境的凭证当场就失效。authentik 自己在浏览器里的会话不动。
- **换账号**(新登录的 `sub` 和上一个不同):做一遍退出登录要做的清理,再给新账号换凭证;界面上说一句"已切换到 …"。同一个人重新登录,已有的凭证保留。
- **本地的会话、设置、connector 及其凭证不跟着账号走,原样保留。** Cycle 是一台机器一个人用的工具,这些属于这台机器;按账号分开要改存储布局,眼下也没有一台机器多人用的需求。

## Alternatives considered

- **不登录也能用本地功能:** 每个功能都要考虑"没登录时怎么办",Itsaplan、工作区设置这些都要做两套。强制登录以后,产品里可以默认用户已知。
- **daemon 也验证用户身份:** 要改协议和 0004,还会让 CLI、单独跑的 daemon、测试都要登录;而用户身份目前只有桌面端的在线功能需要。
- **IdP 不可用就打不开:** Cycle 大部分时间在跑本地 agent,把它绑在 IdP 的可用性上代价太大。
- **过期就回登录页:** 会打断正在跑的会话,而会话本身并不需要这个 token。
- **像兄弟仓库那样把 SSO 登录放进 daemon:** 它们只有一个 daemon;我们一台桌面端连着几个环境,远程的那台没有浏览器,回环回调也落不到它那里。放进本机 daemon,远程环境还是要靠本机转送,只是多一跳;而 refresh token 只能有一个持有者,桌面端主进程是唯一一个总在、总在人这台机器上的。2026-11-23 负责人确认保持桌面端。
- **authentik 的 federated provider:** 换出来的是服务账号,不是这个人,Itsaplan 认不出是谁。
- **Itsaplan 铸个人 key(备选):** 不需要 authentik 改配置,daemon 也不用续期;但 Itsaplan 要多管一类长期 key,吊销、列出都要自己做,而 exchange 用的是 authentik 现成的吊销和有效期。负责人 2026-11-23 说明 authentik 可以开启 exchange,所以 exchange 优先,铸 key 留作备选。
- **只换 access token、由桌面端定时推给各 daemon:** 桌面端一关,远程会话里的 Itsaplan 一小时后就断了。
- **桌面端再登录一次 Itsaplan 的应用,拿它自己的 refresh token:** 浏览器里已有 authentik 的会话,不用再输密码;但桌面端要多管一条会轮换的 refresh token,而且只能把约一小时的 access token 一次次推给各 daemon,桌面端一关,远程会话里的 Itsaplan 一小时后就断了。
- **把 SSO 的 access token 直接交给 daemon,让各服务都认 `clawdot-team` 的 token:** 等于让每个服务接受任何 `clawdot-team` 客户端签的 token;token 一小时过期,还是要人一直推;Itsaplan 也是另一个应用,audience 对不上。
- **把 `clawdot-team` 的 refresh token 交给 daemon 去续:** 和"只有一个持有者"冲突,几个环境会互相作废;每个环境单独 exchange 出 Itsaplan 自己的链,就没有这个问题。
- **退出登录时把本地会话和 connector 一起清掉或按账号分开:** 2026-11-23 负责人选了原样保留。
- **宽限期 7 天(CYCL-150 的初始建议):** 负责人定了 30 天,和 refresh token 的有效期对齐,离线一周以上回来不必重新登录。

## Consequences

- 桌面端多了钥匙串里的一条登录、一个回环回调服务、一个 exchange 和吊销的流程;daemon 多了一类 vault 条目、一个续期循环和 `_cycle/account/*`。
- 每个环境的 daemon 持有一条 Itsaplan 的 refresh token,在那台机器上以明文(0600)存放。agent 的命令能不能读到它,和现有 connector 凭证一样取决于那台机器上的沙箱,这条限制是现有的,不是新增的;红线"token 不到达 agent"指的是不经过 agent 的配置、环境和 MCP 参数。
- 被吊销的凭证要到下一次被拒才发现,多花一次请求。
- Itsaplan 那部分(CYCL-164)要等 authentik 开启 exchange(CYCL-165)、Itsaplan 接受换出的 token(CYCL-160)才能联调;登录本身(CYCL-149)不依赖它们,先做。
- 未验证:authentik 开启后公共客户端能否 exchange、是否发 refresh token、吊销是否连带;Itsaplan 和 `clawdot-team` 两个 provider 给同一个人的 `sub` 是否相同(取决于 authentik 里各 provider 的 subject 模式),Itsaplan 按 `sub` 还是 email 认人由它自己定;authentik 上 refresh token 的实际有效期;完整的浏览器登录在 cycle-v1 里还没走过。
- 登录、退出、换账号、凭证被自动替换都是用户能感知的操作,实现时按 `docs/analytics.md` 加埋点,只报结果和原因的固定词。
