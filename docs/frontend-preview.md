# 前端展示版（GitHub Pages）

展示地址：https://mascotlv.github.io/PPT_template/

此版本复用现有前端页面，展示首页、示例商品、分类、搜索、价格排序、商品详情、全部五页示例预览、十三种语言、币种选择和政策页面。价格及币种换算为固定展示数据，不用于交易。无需运行后端、数据库或云服务器。

页面始终标明「前端展示版」。账号和管理员登录界面可查看，但登录、注册、付款、文件上传下载及消息发送不可用，也不会向服务器提交输入的信息。本地真实商品、账号、订单和购买文件没有上传。

## 更新网站

`.github/workflows/pages.yml` 在推送 main 时安装锁定依赖并构建前端展示版，再发布到 GitHub Pages。仓库 Settings → Pages → Build and deployment 的 Source 设为 GitHub Actions。

构建脚本 `scripts/build-preview.mjs` 在 `.cache/pages-preview` 生成隔离副本，替换副本中的 API 为本地展示数据并导出 HTML、CSS、JS、SVG。原前后端源码、本地构建、数据库与私有配置保持独立。示例文字取自 `backend/src/commerce/demo.ts`，没有连接数据库。

本地构建：

```powershell
$env:PAGES_BASE_PATH='/PPT_template'
node scripts/build-preview.mjs
```

可部署静态文件位于 `.cache/pages-preview/frontend/out`；可上传到任何静态托管平台。其他平台使用根路径时，不设置 `PAGES_BASE_PATH`。不要双击 HTML 来检验页面，应使用 HTTP 静态服务器。

GitHub Pages 的发布目录由 Actions 自动上传，不能将 frontend 源代码直接选为发布目录。仓库公开仅表示代码可查看；本地私有配置和商品文件仍由 `.gitignore` 排除。
