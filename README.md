# 记一笔

一个强调“几秒钟记完一笔”的本地优先 PWA。记账时总是先写入当前浏览器的 IndexedDB，因此无需账号也能使用，断网不会阻塞保存。部署到 Cloudflare Pages 后，用户可以选择通过 GitHub OAuth 登录，并明确开启 D1 账目同步与 Workers KV 截图同步。

## 功能

- 支出/收入切换与人民币金额输入
- 文字或单张截图凭证，支持选择、拍摄与粘贴
- 当前余额、初始余额、本月收支概览与可选的自然月月末余额底线
- 记录编辑、软删除与 8 秒撤销
- 密码加密的单文件备份与整体恢复
- 可选的 GitHub OAuth 登录及多设备同步，冲突由用户选择保留本机或云端版本
- 手机、平板和桌面响应式界面
- 安装到主屏幕并在首次访问后离线使用

## 数据与隐私

- 金额以人民币“分”的整数形式保存，避免浮点误差。
- 账目、设置和截图先写入当前浏览器的 IndexedDB。未开启同步时，不会上传账本数据。
- 用户登录并确认开启同步后，账目与同步元数据的云副本写入 D1，压缩后的 JPEG 截图云副本写入绑定名为 `ATTACHMENTS` 的 Workers KV；本机数据仍保留。
- Workers KV 是最终一致存储。截图刚上传后，另一设备可能短暂读取不到并需要重试；这不会影响本机 IndexedDB 中的保存与查看。
- 云同步必须通过已认证的启用接口明确开启。删除全部云端数据后，其他已登录设备也不能静默恢复云副本，必须再次明确启用。
- 删除完成后，云端只保留离线设备识别删除所需的最小墓碑；旧同步版本不保留完整账目内容，未引用截图在 24 小时宽限期后回收。
- 登录由 GitHub OAuth 完成，应用不接触或保存 GitHub 密码。生产环境只允许配置的 GitHub User ID 登录，不开放注册。
- 清除网站数据、卸载浏览器或更换设备可能导致未同步的本机数据丢失，请定期导出加密备份。
- 备份密码不会保存，也无法找回。恢复前会展示备份摘要，确认后整体替换本机数据。
- 不同站点来源拥有彼此独立的 IndexedDB。从 GitHub Pages 切换到 Cloudflare Pages 时，可先导出加密备份，再在新站点恢复。

详细说明见 [PRIVACY.md](./PRIVACY.md)。

## 本地开发

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:5173/`。这个命令只启动 Vite，适合开发本机账本；它不会启动 Pages Functions，云同步入口默认关闭。

检查与构建：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

## 本地调试 Cloudflare 同步

完整同步开发需要仓库根目录中的 `wrangler.jsonc` 已配置 `DB` D1 binding 和 `ATTACHMENTS` Workers KV binding。复制 `.dev.vars.example` 为 `.dev.vars`，可使用仅限本机开发的虚构邮箱兼容路径；该文件已被 Git 忽略。

先把迁移应用到 Wrangler 的本地 D1：

```bash
npx wrangler d1 migrations apply DB --local
```

然后启用前端同步入口、构建静态资源，并由 Pages 本地运行时同时提供页面和 Functions：

```powershell
$env:VITE_CLOUD_SYNC_ENABLED = "true"
npm run build
npx wrangler pages dev dist
```

`.dev.vars` 中的 `ENVIRONMENT=development` 与 `LOCAL_AUTH_EMAIL` 只是本地认证兼容路径。生产环境不得设置 `LOCAL_AUTH_EMAIL`，也不得把 `ENVIRONMENT` 设置为 `development`。生产默认使用 GitHub OAuth，修改前端后需要重新构建 `dist`。

### 云同步授权与删除 API

除登录、回调与登出外，云同步接口都需要有效的同源应用会话，并使用 `application/json`：

- `GET /api/login` 启动 GitHub OAuth；GitHub OAuth App 的回调地址必须是部署来源下的 `/api/callback`。`GET /api/callback` 校验一次性 state、完成身份确认并建立应用会话；`GET /api/logout?returnTo=/` 删除当前应用会话并跳回经过校验的同源路径。
- 会话 cookie 设置为 `HttpOnly`、`Secure`、`SameSite=Lax`，前端 JavaScript 无法读取。OAuth state 与会话令牌不会以明文写入 D1，D1 只保存其哈希、有效期及完成认证所需的最小元数据。
- `GET /api/session` 始终可读取当前身份以及 `cloud.syncStatus` 和 `cloud.generation`；状态为 `disabled`、`enabled` 或 `deleting`。`generation` 是服务端单调递增的账号代次，客户端不得自行推测，也不得用后来读取的会话值静默覆盖本机保存的链接代次。
- `POST /api/account/enable` 接收 `{"confirmation":"ENABLE","generation":0}`，其中 `generation` 必须来自刚读取的 Session。成功返回 `200` 与 `{"schemaVersion":1,"syncStatus":"enabled","generation":1}`，这是上传任何账本数据前必须执行的明确授权。
- `/api/sync` 的账本协议当前为 v2，并继续接受 v1 请求。v1 响应不返回月末余额底线；设置 mutation 缺少该字段时保留云端值，v2 只有显式发送整数或 `null` 才会设置或关闭底线。
- `POST /api/sync` 以及附件 `GET/PUT` 必须携带 `X-Jiyibi-Sync-Generation`，值为本机明确连接时保存的非零代次。服务端和本机数据库都会拒绝跨代次读写。
- 附件请求在写入 Workers KV 前会取得当前代次的短期上传租约，并在请求结束时释放。账号删除在活动租约释放前只返回 `202`；请求异常中断时租约最长 15 分钟后过期，随后删除重试会按代次前缀回收可能迟到的对象。
- `DELETE /api/account` 接收 `{"confirmation":"DELETE","generation":1}`，每次最多清理 50 个 D1 跟踪对象或相应账号代次前缀下的 KV 对象。未完成时返回 `202`、`Retry-After: 5` 以及 `complete:false`；调用方应等待指定时间并使用同一代次重复请求。最后一个上传租约释放且完整 KV 扫描为空后，服务端还会等待至少 60 秒传播静默窗口，再次完成全扫描后才返回 `200` 与 `complete:true`。
- 删除响应同时包含本轮的 `deletedObjects` 和 `remainingObjects`；等待活动上传结束时 `deletedObjects` 可以为 0。`remainingObjects` 在 KV 代次前缀扫描阶段是“仍需重试”的信号，不承诺是整个命名空间中的精确剩余总数。KV 暂时失败时返回 `503 cloud_deletion_retry_required`，D1 引用或独立清理任务会保留以供重试；按代次前缀扫描 KV 也会回收没有 D1 指针的并发上传残留。
- enable 和 delete 的确认对象必须恰好包含规定的 `confirmation` 与 `generation` 字段，否则返回 `400`。同步关闭时，`/api/sync` 与附件接口返回 `409 cloud_sync_disabled`；删除进行中返回 `409 account_deletion_in_progress`；请求代次过期时返回 `409 stale_cloud_generation`。
- 收到账号状态或代次变化后，客户端会停止同步、刷新 Session、移除旧代次的本机同步链接，并要求用户重新明确开启；不会把旧设备的在途修改静默上传到新云端账本。
- 删除完成会移除 D1 中的账号映射、账目、设置、同步历史和附件元数据，但不会删除任何设备本机 IndexedDB 中的账本。服务端只保留不含邮箱和账目内容的哈希用户 ID、单调递增的代次及 `disabled` 闸门，防止其他已连接设备自动重建云数据。

## 部署到 Cloudflare Pages

当前生产地址为 <https://jyb.str1ct.top/>。Cloudflare Pages 的 `pages.dev` 地址仍作为底层部署域名保留，但对外访问、PWA 安装和 GitHub OAuth 均使用自定义域名。

### 1. 创建资源

登录 Wrangler，并创建 D1 数据库、Workers KV 命名空间和 Pages 项目：

```bash
npx wrangler login
npx wrangler d1 create jiyibi
npx wrangler kv namespace create ATTACHMENTS
npx wrangler pages project create jiyibi --production-branch main
```

将实际 D1 `database_id` 写入 `d1_databases`，并把命令返回的 KV namespace ID 写入 `kv_namespaces`；binding 名必须分别为 `DB` 和 `ATTACHMENTS`。这套方案无需开通 R2，也不需要为 R2 绑定银行卡。不要提交虚构 ID、令牌或本机 `.dev.vars`。

### 2. 应用生产迁移

首次部署前以及新增迁移后运行：

```bash
npx wrangler d1 migrations apply DB --remote
```

迁移不会由前端构建自动执行。应先确认迁移成功，再发布依赖新表结构的版本。

### 3. 配置 GitHub OAuth

在 GitHub 的 Developer settings 中创建 OAuth App：

- Homepage URL 使用 `https://jyb.str1ct.top/`。
- Authorization callback URL 使用 `https://jyb.str1ct.top/api/callback`，路径必须是 `/api/callback`。
- 将 OAuth App 的 Client ID 配置为 Pages Functions 变量 `GITHUB_CLIENT_ID`。
- 将 Client secret 配置为加密 secret `GITHUB_CLIENT_SECRET`，不得写入仓库或普通构建日志。
- 将唯一允许登录账号的数字 GitHub User ID 配置为 `GITHUB_ALLOWED_USER_ID`。这是 GitHub API 返回的稳定 `id`，不是可修改的用户名；生产环境必须同时配置这三个变量。
- 将 `ENVIRONMENT` 配置为 `production`，不要配置 `LOCAL_AUTH_EMAIL`。
- 使用 GitHub OAuth 时不要再用 Cloudflare Access 保护 `/api/*`，否则公开回调 `/api/callback` 会先被 Access 拦截。旧 Access 认证只作为另一种兼容部署方式保留。

GitHub OAuth 是默认生产登录路径，不依赖 Cloudflare Access。`TEAM_DOMAIN` 与 `POLICY_AUD` 只用于已有 Cloudflare Access 部署的兼容认证，可以不配置；本地开发也可以继续使用 `ENVIRONMENT=development` 与 `LOCAL_AUTH_EMAIL`。GitHub OAuth state 和应用会话哈希保存在 D1，截图仍只进入 `ATTACHMENTS` Workers KV，因此认证方案也不依赖 R2 或银行卡。

### 4. 构建并发布

Cloudflare 生产构建必须设置 `VITE_CLOUD_SYNC_ENABLED=true`，否则应用仍会以纯本机模式运行。使用 Wrangler 直接发布：

```powershell
$env:VITE_CLOUD_SYNC_ENABLED = "true"
npm run build
npx wrangler pages deploy dist --project-name jiyibi
```

当前生产项目应只接受审核后的直接部署，不要让公开仓库的 Pull Request 预览继承生产 D1/KV binding。若之后把 Pages 连接到 Git 仓库，必须先为 Preview 环境创建独立的 D1 与 KV，再使用以下构建设置：

- Build command：`npm run build`
- Build output directory：`dist`
- Environment variable：`VITE_CLOUD_SYNC_ENABLED=true`
- Node.js：22

发布后，从设置页发起 GitHub 登录，确认 `/api/callback` 能建立会话，再开启同步。应同时验证新增/编辑/删除、截图上传、多设备冲突、退出会话、断网本机记账以及重新联网后的补同步。

## GitHub Pages

`.github/workflows/deploy.yml` 会在 `main` 分支更新后以 `VITE_BASE_PATH=/jiyibi/` 构建并发布 GitHub Pages。仓库设置中的 Pages 来源应为 **GitHub Actions**。

GitHub Pages 只提供静态托管，没有本项目所需的 Pages Functions、GitHub OAuth 回调、D1 或 Workers KV bindings，因此该版本不提供登录和在线同步；本机账本、PWA 离线使用和加密备份仍可正常工作。

## 当前边界

当前版本不提供公开注册、账号密码系统、OCR、分类、完整预算与固定支出预测、多账本、银行接口或客户端时间戳自动覆盖冲突。
