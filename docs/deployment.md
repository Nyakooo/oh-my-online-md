# 部署与维护

## 容器镜像

镜像地址为 `ghcr.io/nyakooo/oh-my-online-md`，支持 `linux/amd64` 与 `linux/arm64`：

- `latest`：默认分支当前发布版本。
- `v1.0.0`：固定版本，适用于需要明确升级时点的部署。

在 `.env` 中设置 `IMAGE_TAG=v1.0.0` 后执行 `docker compose pull` 和 `docker compose up -d`。回退版本使用相同方式切换标签，操作前备份数据目录。

如果需要脱离源码仓库部署，可从 [GitHub Release](https://github.com/Nyakooo/oh-my-online-md/releases) 下载 `compose.yaml`，在其旁边创建 `.env` 与数据目录。使用预构建镜像运行不需要执行 `docker compose build`。

## 一键更新脚本

服务器安装 Docker Engine、Docker Compose v2、Bash、curl 和 flock（Linux 的 util-linux 包）后运行：

```sh
bash /opt/oh-my-online-md/deploy.sh
```

脚本默认使用所在仓库根目录的 `compose.yaml` 和 `.env`，与当前终端目录无关。仅下载 Compose 文件部署时，也可以将 [deploy.sh](../deploy.sh) 单独复制到服务器，并明确指定部署目录：

```sh
bash /usr/local/bin/deploy-online-md.sh --dir /opt/online-md
```

执行用户需要具有 Docker 和部署目录写入权限。脚本不依赖 Node.js、Go 或源码构建环境，不执行 `git pull`；它拉取 `.env` 中 `IMAGE_TAG` 指定的镜像。使用 `latest` 才会跟随最新发布版本。首次启动同样可以使用此脚本，事先配置好 `.env`。

脚本依次执行：

1. 获取部署目录的 `.deploy.lock` 锁，阻止同一目录重复部署；检查 Docker、Compose 和配置有效性，配置检查不输出密码。
2. 执行 `docker compose pull --policy always`。拉取失败立即退出，现有容器继续运行。
3. 执行 `docker compose up -d --no-build --pull never --remove-orphans`，更新容器并清理当前 Compose 项目中已移除服务的旧容器，保留数据挂载。
4. 最多等待 60 秒，检查 `online-md` 容器运行状态（若配置了 healthcheck，还需健康），并请求本机 `/login`，跟随最多 3 次跳转，检查最终返回 HTTP 200。失败时打印容器状态和最近 50 行日志，以非零状态退出，保留镜像供排查。
5. 检查成功后执行 `docker image prune --force`，清理 Docker 守护进程中的全部悬空镜像。清理失败同样返回非零状态，日志会标明失败步骤。

**清理范围是整个 Docker 守护进程的悬空镜像**，包含其他项目的悬空镜像。它不清理卷、数据目录、带标签的旧镜像或构建缓存。若需保留悬空旧镜像用于排查或回退，使用：

```sh
bash deploy.sh --no-prune
```

改变宿主机端口时，可调整检查地址和等待时间：

```sh
HEALTH_URL=http://127.0.0.1:18080/login DEPLOY_TIMEOUT=120 bash deploy.sh
```

HTTP 检查绕过代理环境变量，默认验证本机应用，不验证 Nginx、域名或 TLS。更新会有容器重建的短暂中断。脚本不自动备份或回退数据；重要升级前请按下文备份，升级失败时查看日志并将 `IMAGE_TAG` 改为已发布的旧版本后重新执行。不要删除 `.deploy.lock` 文件来解除运行中的锁，进程退出后锁会自动释放。

## 环境变量

Compose 读取 `.env` 中的 `DATA_DIR`、`PASSWORD` 与 `IMAGE_TAG`。宿主机 `DATA_DIR` 挂载到容器 `/data`，服务固定映射 `10777:10777`。

直接运行二进制时，程序读取 `DATA_DIR`、`PASSWORD` 和 `PORT`；默认分别为 `./data`、空、`10777`。`IMAGE_TAG` 仅供 Compose 选择镜像，不是程序参数。

## Nginx

[完整配置](../deploy/nginx.conf) 用于 Nginx 与 Docker Compose 位于同一宿主机的部署：

```sh
sudo cp deploy/nginx.conf /etc/nginx/conf.d/online-md.conf
```

替换示例域名 `notes.example.com`，保留 `client_max_body_size 232m;`（用于带图片的整篇本地导入；普通笔记 JSON 请求仍由后端限制为 32 MiB）。已有 HTTPS 站点将相应代理配置合并进实际 `listen 443 ssl` 的 `server` 中。

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 如果也运行在容器内，并与应用共享 Docker 网络，上游地址改为 `http://online-md:10777`。前置代理或网关也应允许至少 32 MiB 的单次请求；多层代理中任一层限制过小都可能产生 `413`。

应用提供 HTTP 服务，不自动签发证书。编辑端通过仅需密码的登录页验证，使用 HttpOnly、SameSite Cookie 保持登录状态，HTTPS 下启用 Secure 标记，公网部署需要由代理提供 HTTPS。分享链接只开放对应快照的只读页面和图片，不开放编辑端 API。

## 数据目录

```text
data/
├── <标题>_<UTC 时间戳>/
│   ├── note.md        # Markdown 正文
│   ├── meta.json      # 笔记 ID、标题与更新时间
│   ├── assets/        # 原始图片
│   ├── share.json     # 当前分享信息，按需创建
│   └── shares/        # 分享快照，按需创建
└── 工作项目/           # 用户文件夹，对应服务器实际目录
    ├── .pwd           # 可选，明文访问密码，仅服务器端可读
    └── <标题>_<UTC 时间戳>/
        ├── note.md
        ├── meta.json
        └── assets/
```

修改标题不会重命名已有目录。现有 `note.md` / `meta.json` 数据无需迁移。删除笔记会删除其整个目录及分享快照。

## 备份和恢复

为得到一致的备份，先停止写入或停止服务，再复制整个数据目录：

```sh
docker compose stop
cp -a ./data ./data-backup
docker compose start
```

若使用其他 `DATA_DIR`，替换路径。备份文件名请自行区分，避免覆盖已有备份。

恢复时停止服务，将备份目录作为 `DATA_DIR` 挂载后重新启动。分享的到期时间保存在文件中，不因重启或恢复而顺延。

不要仅备份 `note.md`：图片、元数据和分享快照也属于笔记数据。旧版笔记目录无需手工转换。

## 直接运行

Release 提供 Linux amd64 和 arm64 二进制压缩包。解压后运行：

```sh
DATA_DIR=./data PASSWORD='replace-with-your-password' PORT=10777 ./online-md
```

关闭终端不会替代进程管理；长期运行可按自己的部署方式接入 systemd 或其他进程管理器。


### 仅供本机插件使用

二进制程序可以直接在本机运行，无需 Docker 或独立服务器：

```sh
HOST=127.0.0.1 ./online-md
```

插件服务器地址填写 `http://127.0.0.1:10777`。程序默认在**启动时的工作目录**下创建 `data` 目录，而不是固定使用二进制所在目录；启动日志显示数据目录的绝对路径。可用 `DATA_DIR` 指定其他路径。

`HOST` 控制监听地址，默认空值（监听所有网络接口，保持现有部署兼容）；仅本机使用时设置为 `127.0.0.1`。Docker 容器内需继续监听所有接口。


### 本地笔记导入

本版本后端支持插件选择本地笔记后单向导入。整篇导入请求最多 232 MiB，正文最多 16 MiB、单图最多 10 MiB；使用旧版反向代理配置时，需将 `client_max_body_size` 调整为 `232m`，否则附件较多的笔记可能收到 413。

服务器首次使用导入功能时，会在数据目录创建 `.server-id`，请随数据一起备份和恢复。这是导入目标的持久身份，不是密码或访问凭证。每篇导入笔记目录内的 `.import-digest` 用于识别安全重试，应随笔记保留。中断请求的暂存目录不可见，正常失败会清理，服务重启时会清理遗留的 `.import-数字` 暂存目录。


### 离线同步数据维护

服务器离线同步使用 `/api/sync`、`/api/sync/notes/{id}`、附件子路径及 `/api/sync/structure`，沿用服务器会话验证。反向代理须允许 PUT、DELETE 和 multipart 上传，保留 `If-Match`、`X-Sync-Operation` 请求头。现有 Nginx 示例的 232m 请求上限支持整篇笔记与图片事务。

备份完整 data 目录，包括 `.server-id`、`.sync-receipts` 和任何 `.sync-journal-*`。服务器身份用于防止缓存误连其他实例，回执用于安全重试，事务日志用于启动恢复；不要手工清理这些文件或只恢复部分目录。建议停止进程后备份，恢复时保留原服务器身份。未发布的同步事务在下次启动恢复后再接受请求。
