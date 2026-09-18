# 测试约定与踩坑（TESTING）

单元测试用 **vitest**，覆盖核心逻辑（`src/main/core/**`）、IPC 校验（`src/main/ipc/**`）与渲染层的纯逻辑（`src/renderer/src/lib/**`、i18n）。**渲染组件（`.tsx`）仍不写单测**（靠真机/`pnpm dev` 与 `scripts/e2e-extensions.cjs` 验证）。

## 运行命令

```bash
pnpm test                 # vitest run，跑全部
pnpm run test:coverage    # 带覆盖率门禁（>70%，不符则退非零）
pnpm vitest run <file>    # 单跑某个文件，快速迭代
pnpm run typecheck        # 另需过的门禁（tsconfig.node + tsconfig.web）
```

覆盖率配置在 `vitest.config.ts`：`provider: v8`，只统计 `src/main/core/**`，整体阈值 `lines/statements/functions ≥70%、branches ≥60%`，**不设 per-file 阈值**（避免单文件红线卡整体）。

## 测试模式（核心必需的三板斧）

### 1. 纯逻辑 / 只读 FS —— 用 `mkdtempSync` 临时目录
core 大量函数是"读真实文件、不联网"。统一做法：

```ts
let root: string
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'pm-xxx-')) })
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => { rmSync(root, { recursive: true, force: true }); mkdirSync(join(root, ...)) })
```
一个文件一个独立 tmp 根，`beforeEach` 清空重建，避免用例间串数据。

### 2. 依赖 settings 的模块 —— 打开临时 sqlite + 设 active dsh
`home`/`manifest`/`combo`/`plugins` 等的目录解析走"当前 active dsh"。让它生效：

```ts
await openDatabase(join(root, 'app.sqlite'))          // 模块级单例，beforeAll 一次
beforeEach(() => saveSettings({ dshes, activeDshId, pluginDir: store() }))  // 关键：重置基线
```
⚠️ **settings 数据库是模块级单例**，一个用例里 `saveSettings({...})` 会污染后续用例。**每个 `beforeEach` 必须把 settings 重置回基线**，否则前一个用例写坏的值（如 active 版本）会泄漏导致后续断言失败——这是最容易踩的坑。

### 3. 带副作用交互 —— mock
- **pnpm**：`vi.mock('./pnpm.ts', async (ia) => ({ ...(await ia()), runPnpm: vi.fn() }))`，保留纯函数（`installSucceeded`），把 `runPnpm` 变可控。
- **插件安装**：`installIntoProfile`/`addPlugin`（会读 store、调 pnpm）同样 mock，返回 `{ ok: true, ... }`。
- **npm 网络**：`vi.stubGlobal('fetch', vi.fn(...))`，`afterEach(() => vi.unstubAllGlobals())`。
- **`spawnSync`（系统 node 探测）**：`vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))`，配 `vi.resetModules()` + 动态 `await import()` 测多分支。

约定：**被测文件保持真实，交互边界用 mock**；HTTP/子进程绝不真跑。

## Windows / 路径 / 内容踩坑清单（都有血泪）

1. **大小写不敏感**：Windows 上 `README.md` 与 `readme.md` 同名，若先建了个 `readme.md` 目录再写 `README.md` 会 `EISDIR`。写文件路径要一致，别大小写混用。
2. **patch YAML 的 row id 不带引号**：`parsePatchRows` 解析 `- id: "a.b"` 得不到 `a.b`；写测试示例用 `- id: a.b`（无引号）。
3. **不要在测试里用全局 `require`**：vitest 是 ESM，`require` 未定义；一律顶部 `import`。
4. **路径写法**：测试/node 代码里用 `join('C:/...')`（正斜杠）可靠；bash 的 `/c/...` 传给 node 会拼成 `C:\c\...` 而读不到——用 `C:/`。
5. **校验 pnpm `node_modules` 不要靠 `ls`**：Windows bash 对 pnpm 的 junction/目录 `ls` 会显示 0 条或失灵，改用 `node` 的 `readdirSync`/`readlinkSync`/`require` 验证。
6. **隔离与单例**：vitest 默认 per-file isolate（`settings` 单例跨文件不会漏）；但**文件内跨用例**会因 `settings`/`db` 单例而漏——靠 `beforeEach` 重置（见上）。
7. **测多分支 helper**（如 `nodeEnvironment(preference)`）用 `vi.resetModules()` + 动态 import 重置模块缓存，再分别给 mock 返回不同值。

## 维护原则
- 覆盖率是门槛不是累赘：gate 设在总量（>70%），个别难测分支（如 `installOfficialDsh` 真装 dsh）允许不覆盖，别为此写脆弱的"假通过"测试。
- 新 core 模块补测试时，优先覆盖"决策/纯函数分支 + 真实 FS 读路径"，交互边界补 mock。

## 端到端验证（真机 IPC）

`scripts/e2e-extensions.cjs` 在**真实 Electron 主进程**里加载已构建的 `out/main/index.js`，通过 `ipcMain._invokeHandlers` 直接调用注册好的 handler（等价于渲染层 `window.api.*` 的调用），断言真实结果。

```bash
pnpm run build
pnpm run e2e          # = electron scripts/e2e-extensions.cjs --no-sandbox，退出码 0 = 全部通过
```

若 `pnpm run` 因 pnpm 的 install 前置检查失败（例如仓库装在非默认 store 目录、或 `electron` 的 build script 被 `ignoredBuiltDependencies` 跳过），绕开 pnpm 直接调用已安装的 electron：

```bash
./node_modules/.bin/electron scripts/e2e-extensions.cjs --no-sandbox
```

⚠️ electron 二进制需要其 postinstall 真的跑过；若 `node_modules/.../electron/dist` 不存在，说明它被跳过了，先补跑 `node node_modules/.pnpm/electron@*/node_modules/electron/install.js`（国内网络可先设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。

适用场景：**写文件的 handler**。单测只能证明"函数返回了对的内容"，端到端才能证明"用户的真实配置文件被正确改动、且能原样还原"。MCP 启停的 E2E 就是先记录文件原文，切换一次，再切回，断言**逐字节一致**。

⚠️ 写这类测试必须遵守两条：
1. **断言"文件未变"而不只是"返回 ok"**：`setRowDisabled` 对不存在的 id 会**追加**新行，若只断言返回成功，会漏掉"往用户配置里塞垃圾行"这一真实缺陷。
2. **测试自己负责还原**：E2E 会真实修改配置文件，必须切换回原状态并断言还原；跑完顺手确认文件行数与关键行仍在（本次就靠这个发现并清理了一次污染）。

### 更强的还原断言：比对文件哈希

"切换前后内容相等"是**自我参照**的——如果读改写本身有损（比如每次都丢掉文件尾部的空行，或每次都删掉一行 `disabled: false`），两次结果仍会相等，测试照样通过。要真正证明"除了目标行没动别的"，应比对**操作前的文件哈希**：

```powershell
$before = (Get-FileHash $f -Algorithm SHA256).Hash
# …跑 E2E…
$after = (Get-FileHash $f -Algorithm SHA256).Hash
if ($before -ne $after) { "FILE CHANGED!（读改写有损）" }
```

本次正是靠这条，才发现 `setRowDisabled(text, id, false)` 会把用户显式写的 `disabled: false` 整行删掉——而原来的"逐字节还原"断言对此完全无感。

### 完成事件不要从"实时列表"里等

下载/安装类会话的实时快照**只含进行中的会话**：会话落终态时先被移出列表，再推送快照，所以快照里永远看不到已完成的会话。任何"等它变成 done"的逻辑都必须挂在专门的完成回调上（本项目是 `downloads.onFinished`），否则回调永远不会触发。这个坑曾导致 DSH 官方安装完成后页面不刷新。

## 验证 dsh 行为：先查机制，再在真实实例上测

### 结论：MCP 启停**不需要重启**，热重载真实生效

已实测（真实运行实例，非人工环境）：往 `cordis.patch.yml` 的 MCP 行写入 `disabled: true`，**约 10 秒内该服务器的整个进程链退出**；还原为启用后**约 12 秒内重新拉起**（新 PID），其余 MCP 不受影响。

机制（dsh 源码 `apps/cli/src/profile-boot.ts:375`）：启动时若 `profile.patchReload === 'live'`（默认值，`profile.ts:171`），会挂 HMR 并调用 `watchUserPatches()`，**同时监视 profile 层与 home 层**——正是 Launcher 写的两个文件。**并非只在下次启动才生效。**

⚠️ **不要用最小自建 profile 验证热重载**：`watchUserPatches` 依赖完整 HMR 链（`@deepseek-ai/cordis-plugin-hmr` + timer + 根 Include）。自建的最小 profile 即使声明 `patchReload: live`，也可能因链路不全而观察不到重载，从而得出**错误的"热重载不生效"结论**。验证这类"运行时行为"必须在**真实 profile + 真实运行实例**上做。

### 判定"某插件是否真的生效"用进程 / marker，不要只看配置文件

"文件写对了"≠"行为变了"。要证明启停有效，应观察**可观测的外部效应**：

- **进程链**：MCP 服务器是子进程，禁用后应退出（`Get-CimInstance Win32_Process` 按 `CommandLine` 匹配）。
- **marker 文件**：让被测进程启动时写一个文件，用"文件是否出现"判定是否被拉起。

只比对 `--dump-config` 的输出只能证明**配置被正确解析**，不能证明**运行时被卸载**——两者要分开断言。

### 在真实环境做破坏性验证前，先备份并明确还原判据

对用户的真实配置文件做验证时：先 `Copy-Item` 备份，**记录操作前的 SHA256**，还原后再比对哈希（必须**字节级一致**）。本次验证即按此执行：改动后还原，SHA256 与原始完全一致。
