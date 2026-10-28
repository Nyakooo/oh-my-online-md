# 浏览器商店上架素材

用于 Chrome Web Store 和 Microsoft Edge Add-ons 的首发草稿。最终提交审核/发布前必须由维护者核对确认。

- `listing.en-US.md`：Edge 默认英语商店页说明，明确应用界面为简体中文。
- `listing.zh-CN.md`：名称、简介、详情、权限用途、数据说明与审核步骤。
- `chrome/`：Chrome 商店图标、宣传图和实际插件截图。
- `edge/`：Edge 商店图标、宣传图和实际插件截图；`en-US/` 为英文宣传文案版本。
- `source/`：生成宣传布局的源文件与截图来源说明。
- `../privacy.md`：公开隐私说明。

## 图像规格

| 素材 | Chrome | Edge |
| --- | --- | --- |
| 商店图标 | 128×128 PNG，方形图形保留透明留白 | 300×300 PNG，按后台要求 |
| 小宣传图 | 440×280 PNG | 440×280 PNG |
| 横幅宣传图 | 1400×560 PNG | 1400×560 PNG |
| 功能截图 | 1280×800 PNG，最多 5 张 | 1280×800 PNG，最多 6 张 |

两边允许的尺寸有交集，仍按平台目录分别保留；截图采用允许的较大规格。宣传图排版自适应画布，不将大图直接拉伸为小图。截图均来自隔离的示例数据，不包含生产地址、真实密码、Token 或私人笔记。

规格依据（核对日期 2026-10-28）：[Chrome 官方图像规范](https://developer.chrome.com/docs/webstore/images)、[Edge 官方发布文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。提交时仍需核对后台即时校验。
