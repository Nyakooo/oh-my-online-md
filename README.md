<div align="center">

<img src="web/favicon.svg" alt="简记 Logo" width="72" height="72">

# 简记

轻量、自托管的 Markdown 笔记。数据存于本地文件，无需数据库。

[![Build](https://github.com/Nyakooo/oh-my-online-md/actions/workflows/publish.yml/badge.svg)](https://github.com/Nyakooo/oh-my-online-md/actions/workflows/publish.yml)
[![Release](https://img.shields.io/github/v/release/Nyakooo/oh-my-online-md)](https://github.com/Nyakooo/oh-my-online-md/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[使用指南](docs/usage.md) · [部署文档](docs/deployment.md) · [浏览器插件](docs/browser-extension.md) · [更新日志](CHANGELOG.md)

</div>

![简记界面预览](docs/images/promo.png)

## 特性

- **专注书写** — Markdown 编辑与预览，支持 Mermaid 图表、图片粘贴与全局搜索。
- **拖拽整理** — 文件夹与服务器目录对应，支持拖拽移入、移出和排序。
- **密码访问** — 可为服务和文件夹分别设置访问密码。
- **只读分享** — 生成 1–7 天有效的分享链接，支持随时撤销。
- **随处打开** — 适配桌面与手机，支持 Chrome / Edge 插件快捷键唤出。
- **离线笔记** — 浏览器插件无需服务器即可保存本地笔记和图片，支持完整备份导入导出。
- **轻量部署** — Go 单程序，前端资源内置，正文与附件直接存储为文件。

## 快速开始

需要 Docker 与 Docker Compose v2，支持 `amd64` / `arm64`。

```sh
git clone https://github.com/Nyakooo/oh-my-online-md.git
cd oh-my-online-md
cp .env.example .env
```

编辑 `.env`，设置访问密码 `PASSWORD`，再启动服务：

```sh
docker compose pull
docker compose up -d
```

打开 `http://服务器地址:10777`，输入密码即可使用。数据默认保存在 `./data`。

> 未设置 `PASSWORD` 时，任何能访问服务地址的人都可读写笔记。公网部署请使用 HTTPS。

更新服务：

```sh
bash deploy.sh
```

版本配置、反向代理、备份及二进制运行方式见 [部署文档](docs/deployment.md)。

## 浏览器插件

在 Chrome / Edge 中配置服务器地址，按 `Ctrl+Shift+Y`（macOS：`⌘⇧Y`）打开笔记窗口。

插件可独立使用本地笔记，也可连接服务器与网页共用数据。本地和服务器工作空间独立，切换不会自动同步；可手动选择本地笔记连同图片导入服务器。安装与构建方式见 [插件指南](docs/browser-extension.md)。

## 文档与贡献

- [使用指南](docs/usage.md)：编辑、文件夹、图片与分享。
- [部署与维护](docs/deployment.md)：配置、更新、反向代理与数据备份。
- [开发文档](docs/development.md)：源码构建、测试与发布。
- [贡献指南](CONTRIBUTING.md)：报告问题、讨论功能与提交 Pull Request。

欢迎通过 [Issues](https://github.com/Nyakooo/oh-my-online-md/issues) 反馈问题，或提交改进。

## 许可证

[MIT](LICENSE) · [第三方依赖声明](THIRD_PARTY_NOTICES.md)
