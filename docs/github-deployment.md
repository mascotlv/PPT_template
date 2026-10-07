# GitHub 上传与网站上线

本次只部署可浏览的前端展示版，使用 GitHub Pages，无需服务器。构建、发布和更新方式见 [前端展示版说明](frontend-preview.md)。

以下为完整商城部署的参考说明：完整项目包含 Next.js、Node.js API、后台 worker、PostgreSQL 和持久文件存储，GitHub Pages 无法运行完整业务功能。

## 上传代码

建议创建空的私有 GitHub 仓库。环境变量、数据库、管理员初始化资料、商品文件及本地缓存已通过 `.gitignore` 排除。商品文件与数据库需要单独备份和迁移，上传代码不会自动迁移本地商品、账号和订单。

本地仓库初始化并提交后，在项目目录执行，替换为实际仓库地址：

```powershell
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

使用 Git 的浏览器登录完成授权；不要把访问令牌或密码写进远程地址或代码。

## 完整网站上线

现有 `infra/compose.production.yml` 提供数据库、迁移、API、worker、前端与 Caddy HTTPS 入口。可使用支持 Docker Compose 和持久卷的 Linux 云服务器，将域名解析到服务器，并开放 80/443 端口。

在服务器安装 Git、Node.js 24 和 Docker Compose，然后克隆仓库、生成独立环境变量：

```sh
git clone https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
cd YOUR_REPOSITORY
DEPLOY_DOMAIN=shop.your-domain.com node scripts/deployment-env.mjs production
```

生成的 `infra/.env.production` 包含随机密钥，应仅保存在服务器。后续启动使用同一份配置，不要重新生成或覆盖已有密钥。

正式上线前需要完成邮件配置：当前生产 Compose 将 SMTP 指向内网 Mailpit（测试收件箱），不会向顾客邮箱实际投递验证邮件。需将 backend 和 worker 的 `SMTP_HOST`、`SMTP_PORT` 改为读取生产环境变量，并在私有环境文件中填写真实的 `MAIL_FROM`、SMTP 主机、端口、用户名、密码及 TLS 配置。完成后启动：

```sh
docker compose --env-file infra/.env.production -f infra/compose.production.yml up -d --build
docker compose --env-file infra/.env.production -f infra/compose.production.yml ps
```

通过受保护的标准输入运行容器内 `node dist/admin-init.js` 创建线上管理员，将生成的 `/app/.runtime/admin-setup.json` 妥善保存并导入验证器；本地管理员不会自动迁移。检查 HTTPS、邮箱验证、后台登录、上传、下载和 worker 后，网站链接为配置的 `https://shop.your-domain.com`。

真实支付适配器尚未实现，生产模式禁止模拟支付，网站上线不代表可以真实收款。已有本地业务数据的迁移需要单独执行备份恢复与核验。日常停止或更新不要使用 `docker compose down -v`，它会删除持久卷。

如选择带自动域名的托管平台，仍需配置全部后端服务、PostgreSQL、持久磁盘、环境变量与迁移任务，不能只部署 frontend。实际访问地址在账号连接及部署完成后才能确定。
