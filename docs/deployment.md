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

替换示例域名 `notes.example.com`，保留 `client_max_body_size 32m;`。已有 HTTPS 站点将相应代理配置合并进实际 `listen 443 ssl` 的 `server` 中。

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Nginx 如果也运行在容器内，并与应用共享 Docker 网络，上游地址改为 `http://online-md:10777`。前置代理或网关也应允许至少 32 MiB 的单次请求；多层代理中任一层限制过小都可能产生 `413`。

应用提供 HTTP 服务，不自动签发证书。编辑端通过仅需密码的登录页验证，使用 HttpOnly、SameSite Cookie 保持登录状态，HTTPS 下启用 Secure 标记，公网部署需要由代理提供 HTTPS。分享链接只开放对应快照的只读页面和图片，不开放编辑端 API。

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
