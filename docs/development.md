# 开发与验证

## 项目结构

```text
main.go                  笔记、图片接口与文件存储
share.go                 分享快照、有效期与只读访问
web/index.html           网页与扩展共享的界面结构
web/app.js               保存、主题、分享与编辑交互
web/folders.js           文件夹列表、拖拽与访问密码交互
folder_access.go         窗口级目录授权与闲置超时
sidebar_order.go         服务器持久排序
web/folder-session.js    目录锁定与内存草稿恢复
web/note-assets.js       网页与扩展的受控图片加载
client_auth.go           扩展客户端会话与授权
extension/               Manifest V3、配置和窗口入口
scripts/build-extension.mjs  扩展构建与ZIP打包
web/editor.js            基于 CodeMirror 的行内 Markdown 编辑器
web/editor.bundle.js     随程序嵌入的前端构建产物
web/share.html           只读分享页面
scripts/                 编辑器构建与浏览器测试入口
tests/                   浏览器回归测试
```

## 后端

需要 Go 1.23 或更高版本：

```sh
go test -race ./...
go vet ./...
DATA_DIR=./data PORT=10777 go run .
```

测试覆盖 Markdown 渲染、图片读写与大小边界、保存后的附件清理、分享访问控制、有效期、撤销、替换和快照隔离。测试使用独立临时目录，不依赖真实笔记数据。

## 前端

使用 Node.js 24 与 pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
pnpm build
```

`web/editor.js` 使用 CodeMirror 管理文档、光标、中文输入和撤销历史，使用 Markdown 渲染装饰显示非活动行。不要直接修改 CodeMirror 管理的编辑 DOM。

构建会生成 `web/editor.bundle.js` 与 `web/editor.LICENSE.txt`。修改源码或依赖时，应一并提交这两个文件。前端在运行时不从外部 CDN 加载依赖。

## 浏览器测试

安装 Chromium 后运行统一入口：

```sh
pnpm exec playwright install chromium
bash scripts/test-browser.sh
```

脚本先检查并构建扩展，然后为每个测试创建独立的临时服务器、动态端口、数据与浏览器配置。也可 `pnpm test:extension` 仅验证扩展。安装和权限边界见 [浏览器扩展](browser-extension.md)。

- `tests/editor.cjs`：行内编辑、自动排版、中文输入法、撤销、图片粘贴、保存、附件清理、失败重试和移动端布局。
- `tests/save-state.cjs`：未修改时的对号、真实变更判断、恢复原文及避免重复保存。
- `tests/search.cjs`：标题与正文检索、中文与大小写、匹配高亮、特殊符号、无结果、快捷键、未保存内容保护和移动端搜索。
- `tests/share.cjs`：匿名只读访问、分享快照、有效期、替换、取消、图片和黑白灰夜间配色。
- `tests/folders.cjs`：目录、拖拽、密码、重命名、移动与未保存保护。
- `tests/folder-policy.cjs`：根笔记与目录排序、持久化、窗口锁定、闲置及草稿图片恢复。
- `tests/extension.cjs`：真实 MV3 环境、客户端登录、图片、窗口复用、后台恢复、服务器切换和并发保存。

测试会写入数据，请勿将 `TEST_URL` 或 `TEST_DATA_DIR` 指向真实部署。分享测试会修改测试分享的到期时间，以验证过期行为，不需要等待实际天数。

## 发布

采用 `vMAJOR.MINOR.PATCH` 标签，发布前完成：

1. 更新 `CHANGELOG.md` 与 `docs/releases/<标签>.md`。
2. 运行后端、浏览器测试与前端构建，确认没有未提交的构建差异。
3. 提交并推送默认分支，为同一提交创建附注标签后推送。

例如：

```sh
git tag -a v1.0.0 -m 'Release v1.0.0'
git push origin master v1.0.0
```

GitHub Actions 会先验证项目，再发布 GHCR 多架构镜像。标签构建成功后创建 GitHub Release，附带 Linux 二进制、校验和、Compose 配置、Nginx 示例与宣传图。发布结果应同时检查 Actions、Release 资产及 GHCR 标签。

GHCR 包应允许匿名拉取。若首次发布的包为 Private，维护者需要在 GitHub Packages 的包设置中调整可见性。
