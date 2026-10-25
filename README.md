# 简记 · Online Markdown Notes

一个轻量、适配手机和电脑的个人 Markdown 笔记。直接编辑 Markdown 源文，不提供预览和附件上传；手动点击保存或按 `Ctrl+S`（macOS 为 `⌘S`）保存。页面支持白天和黑夜主题，默认跟随设备外观。服务使用 Go 编写，页面和 API 由同一个 Docker 容器提供。

## 快速部署

需要 Docker Engine 和 Docker Compose v2。GitHub Actions 会将镜像发布到 GitHub Container Registry（GHCR）；首次发布并将包设为 Public 后，可直接拉取。

```sh
git clone https://github.com/Nyakooo/oh-my-online-md.git
cd oh-my-online-md
cp .env.example .env
```

`.env.example` 提供两个配置项：

```dotenv
DATA_DIR=./data
PASSWORD=
```

`DATA_DIR` 是宿主机上的笔记数据目录，默认是项目当前目录的 `./data`，也可以填写绝对路径。`PASSWORD` 默认留空，即不启用访问密码；设置后，浏览器会通过 Basic Auth 提示输入密码。

镜像已经发布为 Public 后，拉取并启动服务：

```sh
docker compose pull
docker compose up -d
```

如果镜像尚未发布，可在项目目录从源码构建并启动：

```sh
docker compose build
docker compose up -d
```

查看状态和日志：

```sh
docker compose ps
docker compose logs -f
```

服务固定映射宿主机 `10777` 端口到容器 `10777` 端口。

## 笔记存储

首次保存笔记时，会根据标题和保存时间生成文件夹：

```text
data/
└── <标题>_<年月日-时分秒>/
    ├── note.md       # Markdown 正文
    └── meta.json     # 笔记 ID、标题和更新时间
```

标题中的空格会转换为连字符，文件名中的特殊字符会被清理；时间戳使用 UTC。之后修改笔记标题不会改变原目录名。网页删除笔记时会移除整个笔记文件夹。备份时复制整个 `DATA_DIR`；恢复时放回该目录并重启容器即可。

## 功能

- 直接编辑 Markdown 文本，不显示渲染预览。
- 手动保存标题和正文，支持 `Ctrl+S`（macOS 为 `⌘S`）。切换笔记时会提示保存、放弃或取消。
- 新笔记保存时按标题和时间自动创建文件夹；静态资源引用由用户粘贴到 Markdown 正文。
- 白天和黑夜主题，默认跟随系统，也可以手动切换；会记住手动选择。
- 桌面端和移动端均可使用。
- 可配置访问密码；默认不启用登录。
- 不需要数据库、反向代理或 HTTPS。

笔记正文上限为 2 MiB。由于不提供附件上传或预览，Markdown 正文和用户粘贴的资源链接会原样保存。

## 从源码构建

```sh
docker compose build
docker compose up -d
```

也可直接运行（Go 1.23 或更高版本）：

```sh
go mod download
DATA_DIR=./data PORT=10777 go run .
```

## 发布 GHCR 镜像

仓库包含 GitHub Actions 工作流。将仓库推送到 GitHub 后，工作流使用内置的 `GITHUB_TOKEN` 构建和发布容器镜像。确保仓库 **Settings → Actions → General → Workflow permissions** 允许工作流读写 Packages。

推送到默认分支会更新 `latest`；推送 `v` 开头的标签会发布对应版本：

```sh
git tag v1.0.0
git push origin v1.0.0
```

首次发布后，在 GitHub 仓库的 **Packages** 页面打开容器包设置，将可见性改为 **Public**。镜像地址为：

```text
ghcr.io/nyakooo/oh-my-online-md:latest
ghcr.io/nyakooo/oh-my-online-md:v1.0.0
```

公开后，Compose 可以匿名拉取镜像。

## 更新与安全

更新镜像：

```sh
docker compose pull
docker compose up -d
```

笔记数据保存在宿主机 `DATA_DIR`，更新容器不会删除它。定期备份该目录即可。

`PASSWORD` 为空时，任何能够访问该端口的人都可以读写笔记，建议设置密码。项目按需求提供 HTTP，不会自动配置 HTTPS；Basic Auth 不加密传输，请在可信网络中使用，或由部署环境提供安全的网络边界。删除笔记会立即清理目录，请备份重要数据。
