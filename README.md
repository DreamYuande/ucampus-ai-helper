# U校园 AI 答题助手

一个用于 U 校园网页端的 Tampermonkey 脚本。它读取当前题目，调用你配置的 OpenAI 兼容 API，并把结果显示在浮窗里。你可以复制答案、手动触发填入，或打开自动答题。课程答案由你核对并手动提交。

## 安装或更新

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 从 [GitHub Releases](https://github.com/DreamYuande/ucampus-ai-helper/releases/latest) 下载发布的 `.user.js` 文件。也可以直接[打开最新版脚本](https://github.com/DreamYuande/ucampus-ai-helper/releases/latest/download/ucampus-ai-helper.user.js)。
3. 如果浏览器打开 Tampermonkey 安装窗口，点击「安装」。如果只下载了文件，打开 Tampermonkey 管理面板，新建脚本并粘贴文件内容，保存即可。已安装旧版的用户可以直接替换原脚本内容，保留原有设置。
4. 打开或刷新 U 校园课程页，从浮窗进入「API 设置」。

## 配置 API

| 选项 | 填写方式 |
| --- | --- |
| API 地址 | 填服务商提供的 OpenAI 兼容 Base URL，例如 `https://api.example.com/v1`。默认地址是 `https://api.deepseek.com`。保留服务商要求的路径前缀，如 `/v1`。 |
| API Key | 填该服务商的 Key。服务商不要求认证时可留空。 |
| 模型 ID | 从「获取列表」返回的结果中选取，或手动填写服务商提供的模型 ID。列表依赖服务商的 `/models` 接口。 |

选好模型后点「保存设置」并返回答题。作答使用服务商的 `/chat/completions` 接口。

## 使用方式

- **手动答题**。点击「获取当前题目答案」，核对结果后点击「填入答案」，或先勾选「取到答案后自动填入」。
- **自动答题**。在「API 设置」勾选「打开课程页后自动答题」，保存后返回答题。当前台课程页稳定显示可识别的题目时，脚本会读取题目、请求模型并尝试填入。同一题在当前标签页内最多自动请求一次，失败后仍可手动重试。默认关闭，启用后可在同一设置页关闭。
- **快捷键**。`Alt+Q` 获取答案，`Alt+F` 填入答案，`Alt+M` 收起或展开浮窗。

目前支持常见选择题、填空题，以及部分 U 校园 PC 课程的分栏翻译、句型改写和拖拽配对。自动答题依赖可识别的题目结构和可填写的控件。拖拽是否生效取决于页面，卡片未按预期移动时可根据面板答案手动调整。

## 常见问题

- **模型列表为空或报 404**。检查 Base URL。能调用 Chat Completions 但没有 `/models` 的服务商可以直接填模型 ID。
- **提示请求失败**。检查服务商权限、API Key、模型名和网络。自定义 API 域名可能需要在 Tampermonkey 中授权。
- **读不到题或填不进去**。先展开「查看发送给模型的题目」，确认识别到的是目标题目。课程布局更新后可能需要适配。反馈时请附脚本版本、浏览器和题型，并移除个人信息和密钥。

## 数据与费用

题目文本会发送到你配置的 API。API Key 由 Tampermonkey 保存在该脚本的本地存储里，脚本会用它向你配置的服务商认证。自定义地址需要脚本的 `@connect *` 权限。自动答题可能产生 API 费用，具体取决于服务商。

## 许可证

[MIT](LICENSE)。版本变更见 [更新日志](CHANGELOG.md)。
