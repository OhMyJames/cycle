# 0008 发布:不用打包器,Developer ID 签名加公证,只发 Apple 芯片

状态:已接受(2026-11-18)。方案来自旧 cycle 的同名决策(2026-11-15),在那里跑通过。

## 决定

- **应用**:macOS,只发 Apple 芯片(arm64),不发 Intel。名字 `Cycle`,bundle id `dev.cycle.app`。
- **不用 electron-builder / Forge**:`apps/desktop/scripts/package.ts` 拷贝 Electron 自己的发行版,去掉 `default_app.asar`,把我们的文件放进 `Contents/Resources/app`(没有 asar,Electron 直接读这个文件夹),改 `Info.plist`。Info.plist 的修改是纯文本处理(`scripts/plist.ts`),所以布局可以在 Linux 上构建和测试。
- **应用自带 daemon 和 Claude**:`bin/cycle`(`bun build --compile`,不读 `.env` 和 `bunfig.toml`)和旁边的 `bin/claude`(SDK 的 darwin-arm64 平台包里的二进制)。"This computer"在 Mac 上照常可用。打包后的应用**只用**它们,不回退到 Bun 和源码(用户的 Mac 上没有 Bun),缺了就报出缺什么。以 `build.json` 为"已打包"的标记,不用 `app.isPackaged`(保留 `Contents/MacOS/Electron` 这个名字,它会判错)。
- **签名**:`@electron/osx-sign`(由内到外,hardened runtime,安全时间戳,默认 entitlements)然后 `@electron/notarize`(App Store Connect API key)并 staple。工作流把证书导入临时钥匙串,用完删除。`spctl` 通过才继续。
- **签名前后都检查包里的二进制**:`cycle status`、`claude --version`、用包里的 daemon 跑后端集成测试。因为 hardened runtime 可能让一个未签名时能跑的 Bun 可执行文件起不来,这要在公证花几分钟之前发现。
- **Linux daemon**:单独的发布产物 `cycle-linux-x64.tar.gz` 加 `.sha256`,装在远端机器上(见 docs/daemon.md)。目前只有 x64。
- **发布**:推 `v<version>` 标签才发布;标签必须等于 `apps/desktop/package.json` 的版本。手动运行只上传 artifact,不发布;`sign` 选项默认关,此时只做 ad hoc 签名,不需要任何密钥,第一次在 macOS runner 上就这样跑。
- **密钥**:六个 Actions secret,名字和旧项目一致(`APPLE_CERTIFICATE_P12`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`)。GitHub secret 写入后读不回来,所以要在持有原件的机器上用 `scripts/set-apple-secrets.sh` 写进新仓库;值不进仓库、不进 shell 历史。
- **在负责人自己的 Mac 上打包**(GitHub 的 macOS arm64 机器排队太久):Mac mini 作为自托管 runner 注册在本仓库,标签 `self-hosted, macOS, ARM64`,只有 release 工作流用它。打 tag 时看仓库变量 `RELEASE_RUNNER`(`self-hosted` 就用它),手动运行看 `runner` 选项。签名和 GitHub 的机器一样:从 secret 导入临时钥匙串,只在这个钥匙串里找证书,结束时删掉它并把钥匙串搜索列表恢复原样。不用那台 Mac 登录钥匙串里的证书:后台服务看到的登录钥匙串可能是锁着的,旧仓库这样签名失败过。仓库是公开的,所以外部贡献者的 PR 一律要负责人批准才跑工作流,免得别人的工作流跑到这台 Mac 上。

## 还没有

- 自动更新(清单格式和校验已经有:`src/shared/release.ts`;更新器本身没写)。
- 图标:应用现在是 Electron 的默认图标。
- 从 Finder 启动时 PATH 只有 launchd 的;主进程在 macOS 的打包版里读一次登录 shell 的 PATH(`layout.ts`),已有单元测试,没有在真正的 Mac 上跑过。
- daemon 是脱离的,从应用包里运行。应用被移动或替换后,旧的 daemon 会继续从旧路径运行,直到停止。
- Intel、Windows、linux-arm64。

## 验证到哪一步

- Linux 上:打包出的应用在没有 bun、没有仓库的环境里启动,找到并启动了自己带的 daemon(集成套件 `package`)。
- macOS 上的 Info.plist 编辑、ad hoc 签名、签名、公证:**没有在 macOS 上跑过**,本机是 Linux。第一次运行在 GitHub 的 macOS runner 上。
