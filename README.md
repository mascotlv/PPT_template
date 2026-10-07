# 模板工坊：代码与使用说明

这是一个销售原创 PPTX 模板的商城，包含买家账号、管理员后台、商品、订单、模拟支付、退款、邮件、文件交付和客服聊天。前端和后端独立运行，共用 PostgreSQL 保存业务状态。

**在线前端展示版：<https://mascotlv.github.io/PPT_template/>**。只展示前端与示例商品，不连接数据库，不提供登录、付款和文件交付。部署和更新见 [前端展示版说明](docs/frontend-preview.md)。

**当前本地配置启用真实账号登录，关闭免登录：`DEV_AUTH_BYPASS=false`。邮件使用本地收件箱，不实际发送到公网邮箱。支付仍是模拟支付，不扣真实款。** 原有数据库、管理员资料、商品文件、历史订单和升级备份均保留。

聊天支持微信式左右气泡、头像和昵称。买家在“账号”设置昵称和头像，商家在后台“账号”设置商家昵称和头像；商家昵称旁、消息菜单和会话列表显示实际未读条数，打开会话后清除该会话的未读提示。历史上传中可恢复的文件名乱码也会自动修正显示及下载名。

自动翻译在后台“账号 → 翻译服务”配置，可选 Google Cloud Translation 或 LibreTranslate。Google 需要启用服务的 API Key；LibreTranslate 填写完整 `/translate` 接口地址，并按服务要求填写 API Key。密钥在服务器加密保存，留空保留已保存密钥。每条文字保留原文，下方单独显示译文：收到的文字翻译为当前页面语言，自己发送的文字翻译为对方页面语言；商家默认简体中文，买家切换页面语言后会自动同步。服务未配置或暂时不可用时，翻译框显示提示，不影响聊天发送。翻译服务会接收需要翻译的聊天文字。

也可通过服务器环境变量配置 `GOOGLE_TRANSLATION_KEY`，或 `CHAT_TRANSLATION_URL` 与可选的 `CHAT_TRANSLATION_KEY`；后台保存的配置优先。接口参数依据 [Google Cloud Translation 文档](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate) 和 [LibreTranslate 文档](https://docs.libretranslate.com/api/operations/translate/)。

## 1. 本地启动

需要 Node.js 24；浏览器自动化测试默认使用已经安装的 Chrome。依赖版本固定在 `pnpm-lock.yaml`，通过项目脚本调用 pnpm，不要求把 pnpm 加入 PATH。

在 PowerShell 中运行：

```powershell
Set-Location -LiteralPath 'C:\Users\liwei\Desktop\店铺\网站代码'
node scripts/local-start.mjs
```

首次缺少依赖、构建或配置时，脚本会安装依赖、构建、初始化本地数据库和随机管理员。已有配置时不会重新生成密码或清空数据。启动后保持窗口打开；Ctrl+C 停止本次启动的服务。已在其他窗口运行的数据库不会被顺带停止。

| 地址 | 用途 |
|---|---|
| http://localhost:3000 | 商城；未登录先显示买家登录 |
| http://localhost:3000/account | 买家注册、登录、验证邮箱、重设密码、资料和订单历史 |
| http://localhost:3000/admin | 独立管理员登录和后台 |
| http://localhost:3000/contact | 已验证买家的客服聊天 |
| http://127.0.0.1:4100/api/v1/health/ready | 后端、数据库就绪检查 |

网站统一使用 `http://localhost:3000`。不要在注册和登录中混用 `localhost` 与 `127.0.0.1`，因为 Cookie 和 Origin 校验以站点地址为准。API 4100 和数据库 55432 仅监听本机。

修改代码后，直接运行：

```powershell
node scripts/local-start.mjs --rebuild
```

Windows 下，`--rebuild` 会先强制停止本项目的启动、构建、前后端、本地数据库进程及其子进程，清理启动和构建锁，再重新构建并启动。无需手动 Ctrl+C，数据库文件和账号资料保留。通过项目路径和项目锁识别进程，不会按进程名关闭其他项目。构建脚本会阻止多个前端构建同时运行，也会拒绝在 3000 端口运行时替换页面文件；构建失败时恢复原构建目录。更新后浏览器按 Ctrl+F5。

日常诊断：

```powershell
node scripts/doctor-local.mjs
(Invoke-WebRequest -UseBasicParsing 'http://localhost:3000').StatusCode
Invoke-RestMethod 'http://127.0.0.1:4100/api/v1/health/ready'
```

HTTP 应返回 200，就绪状态应为 `ready`。端口占用时关闭之前的项目启动窗口，再启动；不要直接删除数据库目录或结束所有 Node 进程。

## 2. 本地注册邮箱怎么验证

本地默认配置在私有文件 `backend/.env` 中：

```dotenv
APP_ENV=local
PAYMENT_MODE=mock
STORE_ACCESS_MODE=account
DEV_AUTH_BYPASS=false
ACCOUNT_REQUIRE_SMTP=false
MAIL_TRANSPORT=outbox
```

`outbox` 把邮件保存在数据库中的 MailMessage 表，管理员可在后台查看。**这不验证公网邮箱的真实所有权，只验证本地完整业务流程；没有 SMTP 时不会向 QQ、Gmail 或其他邮箱实际发信。** 本地可用 `buyer-local@example.test`，密码自行设置为 12～128 个字符；示例地址并不是预置账号。

按以下步骤测试：

1. 买家窗口打开 `/account`，选择“注册账号”，填写姓名、国家地区、邮箱、密码并提交。
2. 注册后保持买家窗口打开。此时账户未验证，后端会拒绝购买、商品读取、下载和买家聊天。
3. 另开浏览器或无痕窗口，打开 `/admin`，用下一节的真实管理员账号、密码和动态码登录。
4. 后台左侧点击“邮件”（邮件记录），找到收件人为刚注册邮箱、内容为验证邮箱的邮件。后台列表只展示最近 100 封邮件，测试时请及时查看。
5. 复制邮件中的完整链接，形如 `http://localhost:3000/account#token=...&kind=VERIFY`，粘贴到**原买家窗口**打开。不要把 token 当成管理员的六位动态码。
6. 页面会显示确认验证的表单，点击“确认”。仅打开链接不会消耗验证令牌，邮件预览也不会消耗它；确认按钮以 POST 请求兑换令牌。
7. 验证成功后点击进入商城。若已退出或更换浏览器，使用刚注册的邮箱和密码重新登录。

邮箱验证链接有效期 24 小时，只能成功使用一次。过期后在未验证账户页面点击重新发送。注册邮件异步排队，通常稍等几秒；没有出现时，后台查看“交付任务”，确认 worker 正常运行，失败任务可重试。

密码找回也使用邮件收件箱：在登录页选择重设密码，输入邮箱，去后台复制 `kind=RESET` 的链接，到买家窗口设置新密码。重设链接有效期 15 分钟，一次性使用；重设后该账户原会话和其他重设令牌失效，需要重新登录。为了降低账号探测风险，找回请求始终给出相同的排队提示。

不必修改数据库的 `emailVerifiedAt`，也不要通过开启免登录来替代邮箱验证测试。

## 3. 管理员登录

买家账号不能登录后台。管理员不开放公开注册，初始化时生成随机密码、TOTP 密钥和一次性恢复码。

本机已有管理员资料位于 `.runtime/admin-local.json`；可在自己的编辑器打开。需要快速取得当前登录资料时运行：

```powershell
node scripts/admin-code.mjs
```

该命令在**自己的终端**显示管理员邮箱、密码及当前六位动态码。动态码通常每 30 秒刷新，过期就重新运行。此命令不对外提供 HTTP 接口。请勿公开终端输出或截图。

也可运行 `node scripts/admin-qr.mjs` 生成私有二维码，用验证器导入，或者将 `secret` 手动加入验证器。手机和电脑时间必须准确。`secret`、`otpauth` 用于验证器初始化；网页登录栏填写当前动态码。无法使用验证器时，可使用一个尚未消费的恢复码。

后台审核退款、导出订单、保存店铺设置和彻底删除商品要求最近五分钟内重新输入密码和动态码。页面标注验证状态及有效时间，验证过期后按钮不可用，后端也会拒绝操作。商品文件上传继续使用登录权限和 CSRF 校验。登录错误统一提示凭据无效，不区分账号不存在、密码错误或动态码错误，以减少账号探测。

管理员资料遗失时，先找私有备份，不要重复初始化或覆盖 `.env`。`admin:init` 是受控创建工具，会从标准输入读取资料，不能用公开的默认密码替代已有管理员。

## 4. 功能与实际测试顺序

### 买家端

- 登录 / 注册 / 邮箱验证 / 重设密码；姓名、地区、语言与币种资料；同邮箱购买历史和重复下载。
- 首页和商品列表，分类、搜索、价格排序、最低最高价过滤，筛选写入 URL，刷新后保留。
- 13 种界面语言、29 种币种；切换语言会选择对应默认币种，也可以独立选择币种。阿拉伯语使用 RTL 布局。
- 商品详情与预览、服务端签名报价、条款确认、下单、付款状态查询、下载、全额退款申请与问题反馈。
- 联系页面和浮动客服入口，文字、图片和文件附件，双向实时消息和历史消息分页。

建议完整验收：注册 → 本地收件箱验证 → 登录 → 选商品 → 勾选条款 → 创建订单 → 模拟付款 → 下载 PPTX → 退出重登 → 查看同邮箱历史并再次下载 → 提交问题和退款 → 后台处理 → 确认退款后下载权限撤销。

“测试模式”允许模拟付款；“正常模式”在未接入真实支付适配器时关闭购买。支付宝、微信和 PayPal 目前均未开通，不能实际收款。部署为 `production` 时程序拒绝模拟支付，也不会注册模拟付款接口。

### 管理端

| 模块 | 功能和约束 |
|---|---|
| 概览 | 订单趋势、客户、商品、待退款、反馈、未读消息、任务心跳和存储状态；金额按币种分别统计 |
| 分类 | 新建、编辑、归档、恢复；有历史交易的分类不直接毁掉记录 |
| 商品 / 已删除商品 | 草稿、13 语言资料、CNY 基准价、自动币种价格、上下架、软删除和恢复 |
| 商品文件 | 拖入 / 选择 PPTX，上传进度、自动生成每页预览图、当前文件覆盖；成交的历史版本继续保留 |
| 订单 | 状态和交易记录、补发邮件、导出；服务器校验权限 |
| 退款 | 买家申请原因必填；后台批准 / 拒绝的处理备注可留空或只填一个字；按原付款币种和金额退款；审核需要敏感操作再次验证 |
| 问题反馈 | 待解决、已解决、忽略、全部筛选；回复和状态；管理员私人备忘录 |
| 消息沟通 | 选择买家会话，实时回复、附件与未读提示 |
| 交付任务 | 待执行、运行、完成、失败；失败任务重试；检查 worker 心跳 |
| 付款通知记录 | 签名事件的接收和处理结果；不等同于手动确认收款 |
| 邮件 | 本地捕获 / SMTP 提交、收件人、内容、失败重试；不会声称用户已阅读 |
| 买家 / 数据管理 | 注册资料、地区和年月统计、浏览点击、分币种交易和退款 |
| 汇率 | 参考快照、刷新结果、日期；历史订单不随今日汇率变更 |
| 审计 / 配置 | 受权限保护的操作记录；品牌、通知地址、下载规则和商城模式 |

ADMIN 可管理全部模块；SUPPORT 是客服角色，可处理沟通和客户反馈，不能查看私人备忘录、执行管理员商品管理或查看管理员专属数据。

商品当前文件位于 `购买文件/分类标题/商品标题.pptx`。下载文件名使用**下单时语言的商品标题**，文件内容保持上传原文。修改商品标题、价格、语言或重新上传，不改变已经成交的订单快照。

PPTX 上传完成后，后端用 `pptx-glimpse` 解析幻灯片，再用 Sharp 渲染为 1200 像素宽的 PNG 图片，按页序保存到私有存储。预览成功时原文件和预览图一起提交；预览生成失败时仍保存并按分类归档原文件，返回明确的预览失败提示，可从商品编辑器重新生成。文件保存或事务失败时保留原版本。后台商品列表、编辑器和买家商品详情直接使用这些图片，无需另外上传封面。手动上传预览图仍可追加到当前版本。

此流程在 Node.js 中运行，不依赖 PowerPoint、LibreOffice、桌面会话或外部转换服务。Docker 镜像安装了中文和拉丁字体；自行部署 Linux 时安装 `fonts-dejavu-core`、`fonts-noto-cjk`，并可添加模板所用字体以改善排版。预览是静态图，动画、视频和少数高级效果可能与 PowerPoint 有差异。单个 PPTX 原文件上限 1 GiB，自动预览支持 1～500 页，解压资源上限 2 GiB、生成图片合计上限 256 MiB、转换限时 300 秒；同时最多执行一个转换任务，繁忙时提示稍后重试。

上传显示实际传输百分比，传输完成后显示“正在生成预览图”，最终提示生成页数。下载和订单导出显示接收进度，完整接收后交给浏览器保存并提示成功；服务器未提供总长度时显示不定进度。删除、上下架、恢复、保存、发送等操作在固定提示区显示进行中、成功或失败，错误不会被静默忽略。

汇率由独立任务按 UTC 日期每天更新，对应北京时间 08:00；重新启动后可补执行当天任务。汇率请求失败会重试，历史订单使用成交快照，不按今天的汇率改金额。

购买通知和退款申请通知分别发送给 `.env` 中的 `OWNER_PURCHASE_EMAIL`、`OWNER_REFUND_EMAIL`；outbox 模式只保存，不外发。

## 5. 客服拖动与界面交互

客服按钮只在已验证买家的商城页面显示，后台和专用 `/contact` 页面不重复显示。

- 未拖动时使用原 CSS 固定位置；没有自动漂移、吸边或跟随鼠标。
- 鼠标或触屏按住按钮拖动；移动超过 6 像素才算拖动，轻点仍然打开聊天。
- 松手时不会误开聊天，位置保存在本浏览器 `localStorage` 的 `workshop-chat-position-v1` 中。刷新和跨商城页面仍保留。
- 按钮不会被拖到屏幕之外；缩小窗口会把已保存位置限制到可见范围。
- 聚焦按钮后，方向键每次移动 16 像素，Home 恢复默认位置并清除保存值。
- 关闭聊天后按钮回到之前位置；Escape 关闭聊天并恢复按钮焦点。聊天面板仍使用右下角的独立固定布局。
- 浏览器禁用存储时，本次页面内仍可拖动，只是不跨刷新记忆。

界面统一蓝色主色、渐变、圆角与轻阴影；按钮有悬停 / 按下状态，输入框有明显焦点，提交期间禁用并显示加载文案。客服面板有轻量展开动画，移动端防止横向溢出，附件长文件名不会挤掉输入框。系统启用“减少动态效果”时停用动画和过渡。

页面动画仅改变透明度和变换，不改变业务结果；错误区域用 `role=alert`，状态提示用 `role=status`，客服拖动也支持键盘。

## 6. 精简后的代码结构

整合以业务边界为单位；保留 Next.js 必需的路由入口、Prisma 迁移、框架配置、测试和持久数据。把全部代码塞进一个巨型文件会混淆权限与业务，因此主要业务集中在以下模块。

```text
README.md                         本文：使用、代码、安全、运维与验证
package.json / pnpm-lock.yaml     根命令与固定依赖
frontend/src/
  app/                            Next 路由入口、布局、异常页、统一 globals.css
  components/
    store.tsx                     公共上下文、导航、语言币种、登录门禁、错误呈现
    storefront.tsx                商品目录、详情、结算、订单、找回和政策页面
    account.tsx                   买家账号及邮箱令牌页面
    admin.tsx                     后台入口、导航、商品编辑及管理表格
    operations.tsx                概览和反馈处理界面
    chat.tsx                      买家 / 管理员聊天、附件、浮动按钮与拖动
    auth-scene.tsx                前后台共用的登录视觉结构
  lib/api/index.ts                同源请求、CSRF 同步、导出、上传进度
  locales/                        生成的 13 语言字典和语言币种常量
  proxy.ts                        按请求生成 CSP nonce、安全响应头
backend/src/
  main.ts / worker.ts             API / 独立任务进程入口
  app.ts                          依赖组装、权限和限流中间件、统一错误
  config.ts / db.ts / security.ts 配置校验、数据库客户端、安全基础工具
  modules/auth.ts                 会话、Cookie、CSRF、密码、TOTP、限流、角色
  modules/controllers.ts         基础商城和后台控制器
  modules/shop.service.ts         报价、订单、交易、退款、下载和审计服务
  commerce/accounts.ts            买家注册、验证、登录、重设和资料
  commerce/management.ts          商品、客户、统计和配置管理
  commerce/messaging.ts           会话隔离、消息和附件、SSE 实时流
  commerce/fx.ts                  十进制汇率与整数金额换算
  commerce/content.ts             语言内容访问
  commerce/upgrade.ts             已有业务资料升级
  storage/                       私有存储、上传校验、标题命名、历史文件、容量
  payments/adapters.ts            模拟渠道和未实现真实渠道的拒绝逻辑
  mail/transport.ts              SMTP / 本地收件箱适配
  jobs/runner.ts                 持久任务、重试、交付、邮件、退款、汇率与心跳
  generated/prisma/              Prisma 自动生成；禁止手动编辑
backend/prisma/                  数据结构和有序迁移
packages/contracts/              无机密的共享接口类型
scripts/                         启动、构建、诊断、测试、备份、清理和翻译生成
infra/                           Docker Compose、Dockerfile 对应部署、Caddy 代理
.runtime/                        私有账号、数据库、存储、备份；不是垃圾目录
购买文件/                       当前商品 PPTX
```

原 `catalog.tsx`、`purchase.tsx`、`policy.tsx` 合并到 `storefront.tsx`；原 `appearance.css` 合并到 `globals.css` 并保留覆盖顺序；未使用的旧 `en.ts` / `zh.ts` 删除。历史进度文档与重复说明收敛为本文。临时截图、诊断脚本和日志由清理命令删除；业务审计仍保存在数据库中。

### 前端模块如何协作

`app/layout.tsx` 用 `Store` 包住路由内容。`Store` 请求 `/session`，保存当前买家 / 管理员、CSRF、语言与币种；未验证买家进入商城路由时展示 `Account`。这只是页面入口控制，实际权限由 API 再次校验。

`Account.submit` 按模式请求注册、登录、验证或重设接口。邮箱链接的 token 先从 URL 的 fragment 取出，再移除地址栏中的 fragment；用户主动点击确认才兑换。登录成功会刷新会话并回到允许的站内页面。

`storefront.tsx` 中 `Catalog` 负责筛选和搜索，`Cover` 负责模板封面，`ProductDetail` 展示详情，`Checkout` 使用服务端报价创建订单，`OrderPage` 读取状态、付款和下载，`Recovery` 用邮件找回历史授权，`Policy` 展示政策内容。

`admin.tsx` 选择后台模块并加载 API；`operations.tsx` 处理概览与反馈；`AuthScene` 在买家与后台登录共用视觉结构。`chat.tsx` 的 `Conversation` 负责历史、发送、上传与 SSE 刷新，`ChatLauncher` 负责独立的拖动状态，不写入订单或聊天业务表。

`lib/api/index.ts` 封装同源 `/api/v1` 请求，统一处理错误、Cookie 和 CSRF。提交前刷新会话安全令牌，降低多标签页 Cookie 改变或页面长期闲置后的提交失败。上传使用带进度的请求，不把密码或会话保存到 localStorage。

### 后端模块如何协作

`parseConfig` 用 Zod 校验必需密钥、数据库 URL、SMTP、环境与支付模式；错误只列字段，不打印密钥。`createApp` 建立数据库连接、构造 Auth / ShopService / Messaging，注册控制器与中间件。

HTTP 请求经过安全响应头、请求 ID、IP 限流、会话装载、角色与买家验证、CSRF 校验，然后进入控制器。控制器校验参数和权限，交易服务使用数据库事务和锁更新相关记录。支付通知例外使用原始请求体和 HMAC 签名，不靠浏览器 CSRF。

`worker.ts` 与 API 分开运行。`Runner.tick` 写入心跳、清理过期限流数据、领取持久任务并处理邮件、交付、退款和汇率。停止 worker 会导致邮件停留在队列，不意味着注册接口本身坏了。

`LocalStorage` 限制私有目录内路径，商品文件不可作为普通网站静态资源直接下载。下载请求检查账户、订单、授权、有效期及令牌作用域，退款后撤销权限。

### 数据和状态

数据库包含 Customer、CustomerToken、Admin、Session、Category、Product、Price、FileVersion、Order、OrderItem、Payment、Refund、PaymentEvent、Entitlement、DownloadToken、DownloadLog、RecoveryToken、MailMessage、Job、RateLimit、Audit、Setting、FxSnapshot、AnalyticsEvent、SupportTicket、ChatConversation、ChatMessage、ChatAttachment 等业务模型，以及模拟交易持久记录；具体字段以 `schema.prisma` 的 29 个 model 为准。

| 对象 | 关键行为 |
|---|---|
| Customer / CustomerToken | 密码哈希、邮箱验证时间、语言地区；令牌只存哈希、到期时间和消费状态 |
| Session | 买家 / 管理员分离，令牌哈希、CSRF 哈希、到期和撤销、敏感操作再次验证时间 |
| Order / OrderItem | 订单号、成交金额币种、语言地区、条款、商品与文件版本快照 |
| Payment / PaymentEvent | 原渠道付款、事件去重和签名校验，成功状态不被旧失败通知回退 |
| Refund / Entitlement | 原币种全额退款；批准后暂停下载，成功后撤销，明确失败可恢复 |
| FileVersion | 当前展示文件可更新，成交历史版本不可被直接覆盖 |
| Job / MailMessage | 异步执行和重试；捕获邮件与 SMTP 提交记录分离 |
| SupportTicket / ChatConversation / ChatMessage / ChatAttachment | 客户反馈、私人备忘录、聊天与受权限保护的附件 |

订单状态为 AWAITING_PAYMENT → PAID 或 CLOSED；退款单独记录，不通过删除成功付款记录表示退款。任务为 PENDING → RUNNING → DONE，失败重试或 FAILED。反馈支持 OPEN、RESOLVED、IGNORED。

下单幂等键与数据库唯一约束防止重复点击创建多单；相同键不同内容会拒绝。支付通知按事件去重并锁定交易；批准退款、任务领取及令牌消费也在事务中完成。领取任务使用 `FOR UPDATE SKIP LOCKED`，任务有租约、退避重试及最大尝试次数。

SMTP 提交和数据库提交是两个系统，崩溃边界仍可能产生重复邮件；固定 Message-ID 和持久任务降低重复，但不承诺跨系统严格只发一次。

### 翻译维护

商品和分类只需填写中文。保存时自动生成其他 12 种语言的名称、介绍和可编辑内容、字体、图片、许可说明；修改中文会更新对应译文。URL 和分类 ID 可留空自动生成，前后台必填字段用红色 `*` 标记。自动翻译复用后台“账号 → 翻译服务”的 Google Cloud Translation 或 LibreTranslate 配置，服务需支持全部目标语言。商品和分类文本会发送给该服务。未配置或翻译失败时可以保存草稿和上传文件，上架会重试翻译，全部完成后才能发布。

界面翻译源在 `scripts/locale-source.mjs`、`scripts/operations-locales.mjs`、`scripts/content-locales.mjs`，演示商品翻译在 `scripts/demo-locales.mjs`。修改后运行：

```powershell
node scripts/build-locales.mjs
```

它检查每项 13 种翻译是否完整、重复键，并生成前后端字典、语言币种常量和演示商品内容。不要直接修改生成的 dictionaries.ts，下次生成会覆盖。演示商品翻译是已编写资料，不是运行时机器翻译。生成的前后端字典分别服务各自构建，不包含密钥。

## 7. 已实施的安全措施和边界

| 风险 | 本项目措施 |
|---|---|
| 密码明文泄露 | Argon2id 哈希；注册 / 重设采用 64 MiB 内存、3 次迭代；不返回 passwordHash |
| 账号探测 | 登录统一 `INVALID_CREDENTIALS`；未知账号也执行 Argon2 校验；重设密码统一响应 |
| 暴力尝试 | 数据库原子计数；登录同时限制 IP 与 IP+邮箱；限流返回 429 和 Retry-After |
| CSRF | 精确匹配 PUBLIC_ORIGIN，校验绑定会话的令牌，HttpOnly / SameSite=Strict Cookie |
| 会话固定 | 注册 / 登录旋转买家会话，旧会话撤销；重设密码撤销该账户所有会话 |
| XSS / 点击劫持 | React 文本转义、前端 nonce CSP、禁止 frame/object、Helmet 和安全响应头 |
| 越权 | 后端校验已验证买家、ADMIN / SUPPORT 角色、订单归属与聊天附件所有者 |
| 恶意付款通知 | 原始请求体 HMAC、金额币种与交易身份核验、重放去重、状态约束 |
| 令牌重放 | 邮箱验证、重设、恢复码事务内一次性消费；数据库存令牌哈希 |
| 文件路径穿越 | 私有存储路径约束、文件名规范化、下载授权和安全 Content-Disposition |
| 上传耗尽内存 | 商品原文件、预览及前后台聊天附件均最多 1 GiB；声明长度和 Multer 双层检查，上传 IP 限流 |
| 压缩包 / 图片滥用 | PPTX 部件结构、危险路径 / 脚本 / 宏、压缩比、条目数及 XML 预算检查；商品图片像素预算和转码 |
| 导出表格公式注入 | CSV 单元格转义、危险前缀处理 |
| 管理员敏感操作 | 密码 + TOTP / 一次性恢复码；TOTP 密钥 AES-256-GCM 加密；五分钟再次验证 |

具体限流默认值：API 每 IP 每分钟 600 次；每类登录 IP 每 15 分钟 40 次；每 IP+邮箱每 15 分钟 8 次；注册每 IP 每 15 分钟 5 次；验证邮件每 IP 每小时 3 次；上传每 IP 每分钟 10 次。登录限流桶按买家和管理员区分。429 的 `Retry-After: 60` 是保守重试建议，长窗口尚未结束时再次提交仍会拒绝。限流不会阻塞读写业务数据库的其他用户表。

上传使用内存缓冲，单文件限制和请求频率能降低风险，但不等于流式上传或总并发内存硬隔离。对外部署仍应在代理设置请求体限制、连接数和超时，在宿主机设置内存限制；大规模 DDoS 需要网关 / CDN / WAF。当前 IP 来自实际连接，未随意信任客户端 X-Forwarded-For；经共享反向代理时可能多个用户共用 IP 限流桶，上线时需按代理网络配置受信 IP 识别，并重新验证绕过风险。

附件仅做允许类型、文件名、大小和访问权限检查，**没有病毒扫描服务**。SVG、文档等非安全图片类型按文件下载，不作为内联图片执行。聊天附件发送仍应保持来源可信。敏感业务审计和付款事件是数据库业务记录，不是可随意清除的临时日志。

安全设计参考 [OWASP 认证指南](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) 和 [Express 安全实践](https://expressjs.com/en/advanced/best-practice-security/)。防护不是“绝对防攻击”的承诺，真实支付、邮件外发和外网部署必须分别验收。

## 8. 改为真实邮件发送

在自己的 `backend/.env` 填写邮件服务商给出的资料；不要把真实密码写入 README 或提交到仓库。

```dotenv
DEV_AUTH_BYPASS=false
ACCOUNT_REQUIRE_SMTP=true
MAIL_TRANSPORT=smtp
MAIL_FROM=YOUR_VERIFIED_SENDER@example.com
SMTP_HOST=YOUR_SMTP_HOST
SMTP_PORT=465
SMTP_SECURE=true
SMTP_REQUIRE_TLS=false
SMTP_USER=YOUR_SMTP_USERNAME
SMTP_PASSWORD=YOUR_SMTP_AUTHORIZATION_CODE
```

465 使用直接 TLS；587 / STARTTLS 使用 `SMTP_SECURE=false`、`SMTP_REQUIRE_TLS=true`。账号和授权码必须成对提供，带认证的 SMTP 禁止明文连接。具体主机、发件人和授权码由你的服务商确认，不要照抄占位符。只在本机 outbox 测试时保持 `ACCOUNT_REQUIRE_SMTP=false`。

```powershell
node scripts/check-mail.mjs
```

此命令检查 SMTP 连接和认证，然后重启商城。`SENT` 只表示 SMTP 服务接受，不保证收件、进入主收件箱或已阅读。验证码邮件中的站点地址来自 `PUBLIC_ORIGIN`：本地的 localhost 链接需要在运行项目的电脑打开；对外使用时必须改成实际 HTTPS 域名。

## 9. 配置、数据与清理

### 配置位置

| 文件 / 变量 | 用途 |
|---|---|
| backend/.env | 实际后端配置，以此为当前启动依据 |
| .runtime/admin-local.json | 私有管理员邮箱、密码、TOTP 和恢复码 |
| .runtime/local.json | 首次本机初始化资料；不是新的网页登录口令 |
| .runtime/postgres-local | 本机 PostgreSQL 数据库，不可当缓存删除 |
| .runtime/storage | 成交历史文件、聊天附件、私有预览 |
| 购买文件/ | 当前商品原文件 |
| .runtime/backup-before-* | 已有升级前加密备份 |
| .runtime/file-layout-backup-local.json | 文件迁移备份位置与恢复相关资料 |
| DATABASE_URL | 本机连接默认 127.0.0.1:55432/workshop |
| SESSION_SECRET / MOCK_SIGNING_KEY / ADMIN_ENCRYPTION_KEY | 会话、签名和管理员资料加密；不要轮换后丢掉旧备份密钥 |
| STORAGE_MAX_BYTES | 总应用数据存储预算，默认及最大 400 GiB |

后台“一键删除日志和临时文件”同时清理已停止的 `postgres-workshop_test_*` 测试数据库、对应 `workshop_test_*` 测试文件、测试备份及恢复目录，无需等待七天。运行中的测试会跳过；正式数据库 `postgres-local`、业务存储、账号配置和 `backup-before-*` 备份保留。清理结果显示文件数、临时目录数、释放容量和跳过数量。
| FX_AUTOMATIC_REFRESH | 是否安排自动汇率更新 |

`.env`、`.runtime`、缓存、生成代码和上传文件已在 `.gitignore` 中排除。已删除一次性截图、测试配置、日志、旧诊断探针与无用重复说明；依赖和构建是启动所需产物，不属于业务数据。

清理预览和执行：

```powershell
node scripts/cleanup.mjs
node scripts/cleanup.mjs --apply
```

清理脚本使用项目内白名单，核验真实路径和符号链接，活动测试数据库会跳过；不会直接遍历业务数据库并删除 `.log` 文件。清理项目根目录的临时截图 / `_shot` 脚本、本机顶层临时日志、测试报告及停止的隔离测试数据库；保留最终 `docs/evidence/verification.json` 验证汇总。运行中的商城保留它正在使用的缓存。

本地启动还会检查超过七天的停止测试残留，此后每 24 小时检查一次；自动清理只处理隔离测试数据，日志及其他产物可手动清理。正常启动把输出写到当前终端，不自行累计文本日志。

### 备份恢复

备份使用 AES-256-GCM，需 64 位十六进制 BACKUP_KEY。用自己的密码管理器保存密钥，不将它和加密备份一起公开。

```powershell
$env:BACKUP_KEY = '<你的64位十六进制密钥>'
node scripts/backup.mjs
Remove-Item Env:BACKUP_KEY
```

备份会在 `.runtime/backup-时间戳` 下保存数据库业务表与受支持的私有文件。`.env` 和管理员本机资料需另作受保护备份，恢复后仍需要原 ADMIN_ENCRYPTION_KEY 解密 TOTP 与任务中的令牌。

恢复只允许名称为 `workshop_test_*` 或 `workshop_restore_*` 的已迁移空数据库，不覆盖已有业务库：

```powershell
$env:RESTORE_DATABASE_URL = '<隔离空数据库连接>'
$env:RESTORE_STORAGE_ROOT = '<隔离恢复文件目录绝对路径>'
$env:BACKUP_DIRECTORY = '<加密备份绝对路径>'
$env:BACKUP_KEY = '<原备份密钥>'
node scripts/restore.mjs
Remove-Item Env:BACKUP_KEY
```

先在隔离环境核对数据、原文件摘要、账号和下载，再规划正式切换。不要用 `setup:local` 覆盖恢复所需密钥。

## 10. 开发和自动验证

```powershell
node scripts/pnpm.mjs build
node scripts/pnpm.mjs typecheck
node scripts/pnpm.mjs lint
node scripts/pnpm.mjs test
node scripts/pnpm.mjs test:integration
node scripts/pnpm.mjs test:e2e
```

完整串行执行可用 `node scripts/pnpm.mjs verify`。构建和浏览器测试前停止本地商城；API 集成测试在独立随机端口，浏览器测试使用 3000 / 4100。测试创建独立 PostgreSQL 库与存储，55433 用于集成，55434 用于浏览器；不在本机业务库注册测试账户或创建测试订单。

单元测试覆盖配置、密码与令牌基础、金额精度、路径、CSV、翻译、TLS、通用凭据拒绝和 429。集成测试覆盖权限、CSRF、支付幂等、退款、历史下载、邮箱令牌、SMTP 本地协议、聊天与备份恢复。Playwright 用真实 Chrome 覆盖多语言、移动端、注册验证、下单下载、后台、聊天，以及客服鼠标 / 触屏拖动、刷新记忆、窗口边界与键盘恢复。

浏览器测试可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定 Chrome / Chromium；默认 Windows 路径为 `C:/Program Files/Google/Chrome/Application/chrome.exe`。

本次实际验证汇总保存在 `docs/evidence/verification.json`。常规测试会重新生成截图和详细 JSON 报告，属于临时产物；查看完可运行 cleanup 清理。该汇总只记录已执行结果，不能当成真实 SMTP 交付、真实支付或外网抗压验收。

手动开发可先启动数据库：

```powershell
node scripts/pnpm.mjs db:local
```

然后在另一个终端 `node scripts/pnpm.mjs dev` 启动 API、worker 和 Next 开发服务。后端 dev 使用已编译 dist；修改后端 TS 后需要重新构建并重启。不要同时占用一键启动使用的端口。

## 11. 部署与真实支付边界

`infra/compose.local.yml`、`compose.staging.yml`、`compose.production.yml` 分别使用独立项目、数据库、私有文件、Caddy 与邮件配置。Dockerfile 分别构建前端和后端，worker 作为独立进程使用后端镜像。只发布代理的网站端口，数据库和 API 不直接对公网开放。

有 Docker 引擎后可验证本地容器：

```powershell
node scripts/deployment-env.mjs local
node scripts/container-verify.mjs
```

生成脚本使用 `flag: wx`，不会覆盖已经存在的 `infra/.env.local`。手动运行：

```powershell
docker compose --env-file infra/.env.local -f infra/compose.local.yml build
docker compose --env-file infra/.env.local -f infra/compose.local.yml up -d
docker compose --env-file infra/.env.local -f infra/compose.local.yml ps
```

本地容器入口是 `http://localhost:8080`，Mailpit 在 `http://127.0.0.1:8025`；与本机 outbox 方式不同，是隔离 SMTP 收件服务。首次需受控初始化管理员和演示数据，检查迁移、worker 心跳、账号验证、购买退款下载及容器重建后历史数据。

外网 staging / production 需要真实服务器、域名、DNS、HTTPS 和邮件配置。先设置 `DEPLOY_DOMAIN` 为实际域名再运行 `deployment-env.mjs staging` 或 `production`，编辑对应私有环境文件。生成模板不等于已经完成邮件或支付开通。

上线前备份、固定依赖构建、执行迁移、替换容器，核对 TLS、Secure Cookie、匿名拒绝、角色权限和私有文件隔离。停止用 `stop` 保留持久卷；`down -v` 会删除卷，不用于日常停止。线上应保留有轮转的诊断日志和业务审计，以便故障定位。

真实支付需要在 `payments/adapters.ts` 实现适配器、签名通知、主动查询、退款及退款查询，满足金额币种校验、事件去重、超时、未知结果重查、原渠道退款和重复收款补偿。真实渠道还需要商户凭据、域名回调和沙盒及生产验收；当前不能通过打开配置开关就收款。

当前交付范围为本地代码与自动测试，不包含真实支付、真实公网邮件投递、外网部署或 DDoS 压测。

上传上限统一为 **1 GiB（1,073,741,824 字节）**：商品购买原文件、商家及顾客聊天附件、手动预览图均适用。原文件仍需为有效 PPTX，手动预览图仍需为有效 PNG/JPEG/WebP；图片解码、PPTX 结构及预览页数的校验继续生效。前端会在传输前拒绝超限文件，HTTP 转发允许额外 1 MiB multipart 信息。默认总存储预算为 400 GiB（可配置更低值），统计商品原文件及历史副本、预览图片、聊天附件、数据库及日志；上传时按总占用检查预算；如通过 STORAGE_MAX_BYTES 自定义配额，需保证有足够空间。

包含大图片的 PPTX 生成预览时，内部 SVG 的 base64 图片可能超过 XML 解析器默认的单节点大小限制；预览渲染允许这些大节点，同时保留像素、解压大小、Worker 内存和转换时间限制。原文件按原始字节保存，内嵌音乐不受预览转换影响。

可用 `node scripts/test-real-pptx-upload.mjs "完整文件路径.pptx"` 在隔离数据库中验证实际文件的浏览器上传、全部预览和原文件哈希；源文件只读。运行前停止本项目本地服务，释放 4100 端口；验证结束后重新启动本地服务。结果写入 `docs/evidence/real-pptx-upload.json`。

后台任务页可将全部待处理和失败任务重新排入队列，由现有 worker 执行。设置页的“清理日志和无用文件”处理日志、停止的隔离测试残留、旧测试报告、可丢弃缓存、调试截图和脚本，以及没有数据库引用的旧上传文件；文件与缓存至少保留 24 小时，日志可立即清理。商品原文件及历史版本、当前商品副本、预览图和聊天附件按数据库引用保留；源代码、账号配置和备份保留。正在写入且不能删除的日志清空内容以保持进程句柄有效。清理文件和清空全部业务数据每次需重新输入当前管理员账号、密码和验证码，开发免登录模式也不能绕过。单个回收区商品彻底删除要求最近五分钟内再次验证；存在订单引用的商品不能彻底删除，以保留购买下载。后台反馈使用收件箱与回复面板，可编辑标题、内容、状态和回复，顾客可在原订单页查看回复。

设置页另有“清空全部业务数据”：删除订单、付款退款、顾客账号及登录会话、反馈、聊天及附件、邮件、任务、统计、汇率快照和业务审计。保留全部商品、分类、价格、原文件及历史版本、预览图、当前商品副本、商品定价配置、管理员账号、管理员会话和店铺配置，并留下本次清空审计。此操作每次必须重新校验当前管理员账号、密码和验证码。只暂存与清空业务有关的文件；数据库清空失败时恢复文件，数据库成功后清理暂存文件。可运行 `node scripts/test-admin-maintenance.mjs` 在隔离数据库中验证退款权限、文件清理、业务重置及失败回滚。

商品全部页面自动生成 PNG，前台详情和后台编辑详情显示全部页，后台商品列表最多显示前 6 页。页数从 PPTX 的有序幻灯片列表自动识别，后台只读。商品操作按阶段持久记录到数据库，编辑器「商品跟踪记录」可查看进度、失败阶段、原因及请求编号，服务器重启后记录保留。未配置翻译时只需中文即可上架；接入翻译服务后，会创建持久任务补全现有商品语言。页面不再显示磁盘保存路径，原文件仍按分类归档，分类更改时同步移动，历史订单版本保留。

商品原文件上传、手动预览图上传、文件版本上传及重新生成预览仅要求已登录的商家权限和 CSRF 校验，不要求再次输入密码或验证码。退款审核、订单导出、设置保存和彻底删除商品使用再次验证。验证入口显示在相关操作页；商品、分类、聊天、反馈、概览和数据页不显示该栏目。

“我的账号”按头像、昵称、登录邮箱、新密码排列为四个区域，保存按钮居中。配置邮箱或密码需先完成敏感验证；新密码留空时保留当前密码。修改登录凭据后，其他管理员登录会话注销，当前会话的敏感验证状态重置；动态验证码密钥保留。普通昵称和头像配置中不存放邮箱密码或密码哈希。

“前台配置”可按十三种语言搜索并编辑前台导航、首页、账户、购买、订单、提示、页脚和政策等默认文字；保存当前语言后刷新前台生效，其他语言保持各自配置。“恢复默认”移除对应文字的覆盖值，并在保存后生效。商品、分类等数据内容在对应管理页编辑。前台自定义文字不会覆盖后台界面，保存需要敏感验证。

商品上传默认选择「PPTX + PDF」：同一份 PPT 导出每张幻灯片一页的 PDF，两个文件各支持最大 1 GiB。购买文件仍为原 PPTX，PDF 使用本地打包的 PDFium WebAssembly 逐页渲染为 PNG，不依赖 WPS/PowerPoint，也无需请求第三方转换服务。可切换「仅 PPTX」沿用现有自动转换，或选择「仅替换 PDF 预览」修复已有商品的预览；后台列表显示前 6 页，详情显示全部页。PDF 页数必须与 PPTX 一致。成对上传时 PDF 转换失败仍保存原文件，并在反馈与商品跟踪记录中标明失败原因；单独替换失败保留原有预览。
