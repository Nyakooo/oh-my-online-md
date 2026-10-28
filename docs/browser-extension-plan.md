# 浏览器扩展实现方案

日期：2026-10-28。目标浏览器：Chrome / Edge。用户希望手动配置服务器地址，通过快捷键唤出并使用基本完整的笔记功能。本文记录已确认的实现方向。首版已落地，安装和实际边界见 [浏览器扩展](browser-extension.md)。

## 推荐形态

第一版采用 Manifest V3 扩展、本地打包的笔记界面、独立笔记窗口。点击扩展图标或触发快捷键时，创建窗口；窗口已存在则恢复并聚焦，避免重复窗口。界面沿用现有单侧列表、可展开文件夹和完整编辑区，记住窗口大小与位置。

Chrome 的 windows API 支持创建指定 URL、大小和位置的 `popup` 类型窗口。这里指独立浏览器窗口，与工具栏按钮下的小型 action popup 不同。[官方 windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)

默认建议 `Ctrl+Shift+Y`（macOS 对应 `Command+Shift+Y`），并显示实际绑定情况及快捷键设置入口；快捷键可能被浏览器或系统占用，不承诺默认组合在所有机器上均可用。首版为浏览器内快捷键，不默认做系统全局唤出。[官方 commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)

侧边栏可作为后续的查阅模式。它适合与网页并排，但需要为窄宽度重排目录和编辑器，作为第一版会增加一套布局适配。[官方 sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

## 技术栈

| 层次 | 建议 | 原因 |
| --- | --- | --- |
| 扩展平台 | Manifest V3，Chrome / Edge | 对应首版浏览器范围 |
| 扩展入口 | Service Worker + commands / action / windows | 处理唤出和窗口复用 |
| 界面 | 现有 HTML / CSS、模块化 JS；扩展入口使用 TypeScript | 保持已确认的设计，逐步整理现有脚本 |
| 编辑器 | 现有 CodeMirror 6 | 复用 Markdown 编辑能力 |
| 渲染 | 现有 markdown-it、DOMPurify、Mermaid | 保留预览、过滤和图表能力 |
| 构建 | 现有 esbuild，新增 extension 构建入口 | 暂不引入新的 UI 框架和扩展框架 |
| 本地配置 | chrome.storage.local | 保存服务器地址、窗口位置、主题等 |
| 临时状态 | chrome.storage.local + 页面内存 | Token 与窗口位置保存在本地；笔记窗口状态在页面内存中，窗口身份通过 runtime.getContexts 查询 |
| 服务器 | 现有 Go 服务和文件存储 | 保留目录、附件、分享和 .pwd 行为 |
| 验证 | Go 测试 + Playwright 持久化浏览器上下文 | 覆盖真实扩展环境和服务端授权 |

不另建一份长期独立的笔记前端。将网页端与扩展端共用的列表、文件夹、编辑器及请求逻辑拆为模块，分别提供网页入口与扩展入口。

当前 `web/index.html` 的主脚本是内联脚本，并使用相对 `/api/...` 请求。扩展端必须将脚本改为本地模块或打包文件，再注入 API 基础地址和认证适配器。扩展页面默认禁止内联 JavaScript 和远程脚本，不应直接照搬 HTML 或从服务器加载编辑器 JS。[官方 CSP 文档](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)

## 用户流程

1. 首次点击图标或触发快捷键，进入设置页。
2. 输入服务器地址，允许访问此服务器，执行连接与版本检查。
3. 若服务器配置了访问密码，输入现有密码换取客户端会话；不把原始密码长期保存在扩展内。
4. 打开笔记窗口，显示现有文件夹、笔记和编辑器。
5. 再次触发快捷键时聚焦已有窗口，保留当前编辑内容。
6. 切换服务器前处理未保存内容，再清除旧服务器的认证、文件夹解锁和图片缓存。

支持 HTTP / HTTPS 地址，公网部署推荐 HTTPS；HTTP 明文链路的密码和内容不会被扩展自动加密。不在扩展中绕过无效 TLS 证书。地址需要明确校验协议、主机、端口和部署路径；第一版应明确与现有根路径部署约定的兼容范围。

## 网络与权限

在 manifest 中声明 HTTP / HTTPS 的 optional_host_permissions 范围；用户点击连接时只请求所填服务器对应的 origin 权限，取消或切换服务器时提供移除旧授权的入口。浏览器权限的匹配粒度受 match pattern 约束，应用请求仍必须限制到用户选定的完整 base URL。[官方权限说明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

API 请求直接由扩展本地窗口发出，避免把大笔记与图片经 Service Worker 消息通道转发。Worker 仅负责唤出、配置事件与窗口生命周期，不承担长时间常驻连接，也不把重要状态仅放在内存变量里。[官方跨域请求说明](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

首版不需要注入网页、读取浏览历史或读取当前网页内容。以后若增加“选中文字记笔记”，再单独设计对应权限和入口。

## 服务端必须适配的地方

现有 `auth.go` 使用网站 Cookie，并在 `sameOrigin()` 中只接受与服务器同源的 HTTP / HTTPS Origin；`folders.go` 对文件夹写操作也单独执行该检查。因此扩展获得 host permission 不代表能绕过这些服务端校验。

推荐增加独立客户端会话认证：

- 使用现有服务器密码登录换取可过期、可撤销的随机 Token；服务端保存 Token 摘要，后续 API 使用 `Authorization: Bearer ...`。
- 网页端继续使用现有 Cookie 与同源防护。只有经验证的客户端 Token 请求可以走相应客户端鉴权路径，不全局放宽 `sameOrigin()`，不将任意 Origin 视为可信。
- 获取 Token 的接口需单独设计来源与请求格式校验；不能仅因为 Origin 声称来自扩展便发放权限。
- 文件夹解锁绑定到当前客户端会话；密码仍在服务器文件夹内的 `.pwd` 中，不复制 `.pwd` 到扩展，也不长期保存文件夹密码。
- 配置了密码的目录，其列表、搜索、正文、图片、移动和分享仍复用服务端权限检查。
- 增加能力/版本检查，旧服务器返回明确的升级提示。

Chrome 在已授予主机权限时对 Cookie 请求存在特殊处理，但还受 Cookie 设置等条件影响。这里推荐客户端 Token 是为了明确客户端身份和文件夹授权边界，而不是认为扩展一律不能使用 Cookie。[官方存储与 Cookie 说明](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)

图片也要适配：普通 `<img src>` 无法附加 Bearer 请求头，需要经认证 fetch 后生成 Blob URL，或设计等效的受控图片加载方案。切换笔记、重新锁定、退出登录和切换服务器时销毁对应 Blob URL；Token 不放在图片 URL 查询参数里。

## 第一版范围

包括配置服务器、连接测试、登录退出、快捷键唤出、窗口复用、文件夹展开与密码访问、搜索、Markdown 编辑/预览、保存、新建删除、图片粘贴上传、目录拖拽和“移动”、现有分享规则、主题切换。

保持服务器为笔记的权威数据源；首版不做离线全文镜像和离线修改同步。断网/登录过期时保留当前未保存内容并允许重试。受密码保护目录不做持久化全文缓存。

网页和扩展可能同时编辑同一篇笔记，建议增加保存版本校验（例如 If-Match / ETag）。发生冲突时保留本地内容并提示选择，避免无提示覆盖。窗口关闭仍遵循未保存提示；是否增加持久化草稿应单独决定其保存期限和密码目录策略。

## 开发顺序与验收

1. 做本地 MV3 扩展骨架、配置页、快捷键和独立窗口复用，验证 Chrome / Edge 的实际行为。
2. 做服务端客户端会话、文件夹解锁及受控图片读取，覆盖未授权、过期、撤销和跨服务器隔离测试。
3. 从现有页面抽取共享前端模块，接入扩展本地界面，保证网页端继续正常运行。
4. 完整回归编辑、搜索、图片、文件夹、密码、分享，以及 Worker 休眠后重新唤出、窗口关闭后重建、断网恢复和快捷键冲突。
5. 产出可“加载已解压扩展”的构建目录和分发 ZIP；应用商店发布单独处理。

备选的轻量方案是扩展直接在独立窗口打开服务器网站，可大量复用现有登录和界面。但它本质上是快捷入口，扩展自身的界面、离线状态和后续浏览器集成空间较少。本方案优先采用本地扩展界面 + 现有服务器 API，符合后续持续向浏览器扩展发展的目标。
