# Changelog

所有正式版本均使用 Git 标签标记。发布记录与下载资产见 [GitHub Releases](https://github.com/Nyakooo/oh-my-online-md/releases)。

## [v1.2.0] - 2026-10-27

- 将行内自动排版调整为独立的编辑 / 预览页签，补充格式工具栏、Tab 缩进及常用快捷键。
- 新增加载动画、骨架屏和连接失败重试，完善移动端编辑体验。
- 新增 Mermaid 图表渲染与缩放，支持图片拖放和文件选择。
- 支持安全 HTML、图片 / 视频尺寸控制，以及 HTML 图片的附件清理和分享快照。
- 分享页增加白天 / 黑夜切换，保存主题偏好并在未选择时跟随系统。
- 根目录新增服务器部署脚本，支持镜像更新、服务检查、防重复运行与悬空镜像清理。

## [v1.1.0] - 2026-10-25

- 新增全局搜索，检索已保存笔记的标题和正文，展示匹配高亮与正文片段。
- 支持中文、不区分大小写的文字匹配、快捷键及移动端搜索。

## [v1.0.2] - 2026-10-25

- 为编辑页、密码登录页和只读分享页补充统一的站点图标，提供 SVG 与 ICO 格式。

## [v1.0.1] - 2026-10-25

- 将浏览器 Basic Auth 弹窗替换为仅需密码的登录页，无需用户名。
- 使用 HttpOnly、SameSite Cookie 保持登录状态，HTTPS 下启用 Secure 标记。
- 修改访问密码后，原有登录状态失效；分享链接继续支持免登录只读访问。

## [v1.0.0] - 2026-10-25

首次正式发布。

- 行内 Markdown 编辑，支持自动排版、撤销与中文输入。
- 手动保存与真实修改状态识别，未修改时保持对号。
- 图片粘贴与延迟上传，保存后清理被移除引用的附件。
- 限时只读分享、独立图片快照、重新生成与提前取消。
- 日间模式与黑白灰夜间模式，适配桌面和移动端。
- Go 单程序、本地文件存储、可选访问密码及 Nginx 部署示例。
- GHCR amd64 / arm64 镜像、Linux 二进制与开源开发文档。

[v1.0.0]: https://github.com/Nyakooo/oh-my-online-md/releases/tag/v1.0.0

[v1.0.1]: https://github.com/Nyakooo/oh-my-online-md/releases/tag/v1.0.1

[v1.0.2]: https://github.com/Nyakooo/oh-my-online-md/releases/tag/v1.0.2

[v1.1.0]: https://github.com/Nyakooo/oh-my-online-md/releases/tag/v1.1.0

[v1.2.0]: https://github.com/Nyakooo/oh-my-online-md/releases/tag/v1.2.0
