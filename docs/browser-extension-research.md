# 浏览器扩展技术核实

核实日期：2026-10-28。范围：手动配置自托管笔记服务器、快捷键唤出、尽量完整的笔记体验。以下“事实”来自浏览器官方文档；“建议”是针对本项目的实现判断。未修改生产代码。

## 已核实的事实

- **快捷键**：MV3 在 manifest 的 `commands` 中声明命令，由 `commands.onCommand` 处理。最多提供四个默认快捷键，用户可在 `chrome://extensions/shortcuts` 调整；默认只在浏览器聚焦时生效。`global` 命令另有平台和组合键限制，不能把浏览器内快捷键直接描述成系统全局快捷键。`_execute_action` 是特殊命令，不触发普通 `onCommand`。[Chrome Commands](https://developer.chrome.com/docs/extensions/reference/api/commands)
- **侧栏**：Chrome Side Panel API 从 Chrome 114 起可用，`sidePanel.open()` 从 Chrome 116 起可用，必须由用户操作触发；官方明确列出键盘快捷键。需要 `sidePanel` 权限。面板入口是扩展包内相对路径，可配置为跨标签使用的全局侧栏。[Chrome sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- **Popup 不适合持续编辑**：点击弹窗以外位置就自动关闭，无法阻止；可由快捷键或工具栏打开。因此不建议把它作为完整笔记编辑器的唯一容器。[Chrome Popup](https://developer.chrome.com/docs/extensions/develop/ui/add-popup)
- **动态服务器权限可行**：对于安装时未知的 HTTPS 域名，先在 `optional_host_permissions` 声明 `https://*/*`，再在用户点击连接时通过 `permissions.request({origins: [...]})` 请求实际服务器。请求必须由用户手势触发。HTTP 地址需要相应 HTTP 声明；宽泛的可选声明不等于安装时获得所有站点访问权。[Chrome Permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- **跨域 API 请求**：获得对应 host permission 后，扩展页面或 service worker 可以直接 `fetch` 远程服务器；content script 请求仍受所在网页的同源规则影响。路径部分不缩小 host permission 的授权范围。浏览器网络权限不替代服务器的身份认证。[Chrome Network Requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- **代码要打包**：扩展页面默认 CSP 为 `script-src 'self'; object-src 'self'`。JS/WASM 依赖应随扩展发布，不能靠 CDN 脚本或 fetch 后执行远程脚本来更新扩展逻辑；获取笔记 JSON、Markdown、图片是不同于远程执行代码的行为。[Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)、[Chrome Remote Hosted Code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- **远程 iframe 不是一概禁止**：商店政策对隔离于扩展 API 的 iframe / sandbox 场景有例外，但仍要求可审查完整功能、遵守数据和隐私政策，不能保证一个远程网页壳自动符合上架要求。[Chrome Web Store MV3 Requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- **iframe 有服务器限制**：远程网站的 `X-Frame-Options` 和 CSP `frame-ancestors` 可阻止嵌入；扩展不能仅凭 host permission 使服务器的嵌入策略失效。跨域 iframe 内页面和扩展页也不能直接互读 DOM。[MDN X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options)、[MDN frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
- **后台不是常驻进程**：Chrome service worker 通常空闲 30 秒后终止，事件可将其唤醒；全局变量会丢失。不要依赖它持有唯一草稿、唯一登录状态或持续轮询任务。[Chrome Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- **浏览器差异**：Edge 官方支持 `chrome.sidePanel`。Firefox 使用 `sidebar_action` / `sidebarAction`，与 Chrome API 不兼容，需要单独入口适配和验证。[Microsoft Edge Sidebar](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar)、[Mozilla sidebarAction](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction)

## 两条实现路线的判断

| 路线 | 收益 | 主要代价 | 项目建议 |
| --- | --- | --- | --- |
| 扩展包内 UI + 远程服务器 API | 快捷键、侧栏、配置、缓存和错误提示可控；不依赖站点可嵌入；代码可独立审核 | 要抽离现有界面与 API 层；处理认证、附件地址和并发保存 | 正式产品推荐 |
| 本地侧栏壳 + iframe 嵌入服务器网页 | 复用现有网页快，服务器更新界面即可生效 | 受 iframe 响应头、布局、登录 Cookie 行为、跨域通信及审核影响；服务器网页故障即整个笔记 UI 故障 | 可作为短期可行性验证，不作为默认长期架构 |

以上比较是工程推断。iframe 路线必须实测当前服务器响应头、当前浏览器登录与嵌入表现，不能仅靠文档认定能用。

## 针对本项目的建议

1. 第一版面向 Chrome / Edge，使用 Manifest V3。快捷键打开或聚焦独立笔记窗口，Side Panel 作为后续查阅模式。不要以 action popup 承载主界面。
2. 设置页保存完整 API base URL，明确支持的部署路径，反向代理子路径需验证现有服务端路由后再承诺；权限授权按域名请求，实际 API 请求保留用户配置的路径。优先 HTTPS，开发或内网 HTTP 单独声明并测试。测试连接要区分地址错误、无权限、网络 / 证书错误、登录失效和服务器版本不兼容。
3. 前端及编辑器代码本地打包；尽量复用项目现有技术栈和 Markdown 编辑器，不为扩展先引入一套重型框架。框架选择应结合现有仓库，本文不承诺未经核实的依赖版本。
4. API 层集中处理服务器地址、认证、超时、附件 URL；笔记窗口负责编辑交互，worker 负责快捷键和浏览器事件。配置用 `chrome.storage.local`，未保存状态按服务器和笔记 ID 隔离；持久化草稿的期限及密码目录策略另行确定；密码文件夹解锁信息不要同步到云端。
5. `.pwd` 保留在服务器端；插件只能调用解锁接口，不应读取或下载 `.pwd`。服务器必须继续对正文、搜索、附件和移动等操作进行密码访问校验，不能只锁定列表 UI。
6. “基本完整”建议定义为：笔记 / 文件夹列表、搜索、阅读 / 编辑、手动保存与未保存提示、新建 / 重命名 / 删除、附件展示 / 上传、文件夹解锁 / 重新锁定、移动整理。网页选区摘录、右键收集、复杂离线同步与冲突合并可后置（在线共享同一服务器数据沿用现有能力）。
7. 并发编辑应至少有版本号或 ETag 冲突检测；请求失败不清空草稿；首版保留当前未保存内容并允许网络恢复后重试，持久化草稿、离线写入队列与多端自动合并应另立范围。

## 落地前应验证

- 快捷键冲突、Side Panel 的用户手势打开、浏览器重启恢复。
- 任意域名、HTTP / HTTPS、非标准端口、反向代理子路径、权限撤销。
- 当前后端认证是否依赖网页 Cookie / CSRF；跨扩展来源时的行为。可优先评估独立可撤销的 API Token，避免要求用户再次输入管理员密码。
- Markdown 图片相对地址、受保护附件、编辑器是否加载远程脚本 / worker。
- 文件夹锁定后的搜索、图片缓存、草稿和界面历史是否泄露正文。
- 侧栏与网页同时改同一篇笔记时的冲突提示。

## 首版界面选择补充：独立笔记窗口

用户已确认 Chrome / Edge，可将首版主界面调整为独立笔记窗口。`chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('app.html') })` 创建的是浏览器窗口，不是工具栏的 action popup。Windows API 支持创建窗口、通过 `windows.update(id, { focused: true })` 聚焦现有窗口，以及监听窗口关闭。两种 popup 名称相似但生命周期不同；前文“失焦自动关闭”指 action popup。[Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows)、[Chrome Action Popup](https://developer.chrome.com/docs/extensions/develop/ui/add-popup)

**针对本项目建议**：首版 `commands → 查找现有笔记窗口 → 聚焦；不存在则 windows.create`，窗口内提供原文件夹列表和完整编辑区域。复用窗口 ID 时应处理关闭、浏览器重启和失效 ID；不能依赖 worker 内存中的 ID 永久有效。采用同一份本地 UI + 服务器 API，后续按需要增加 Side Panel。直接把服务器 URL 放进独立窗口是更薄的备选方案，能快速沿用网站，但扩展的独立体验、版本控制、缓存与错误恢复能力较弱。

**服务器验证边界**：host permissions 仅解决浏览器对扩展跨域请求的权限，不会绕过后端 `sameOrigin` / CSRF / 认证检查。如果现有后端拒绝扩展 Origin，必须在服务端设计显式的扩展认证通道（例如带独立 API Token 的接口并保留鉴权），不能通过删除所有来源校验来适配。具体接口行为以仓库审查为准。
