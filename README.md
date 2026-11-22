# U校园 AI 答题助手

一个用于 U 校园网页端的 Tampermonkey 脚本。它读取当前题目，调用你配置的 OpenAI 兼容 API，并把结果显示在浮窗里。你可以复制答案、手动触发填入，或打开自动答题。课程答案由你核对并手动提交。

## 安装或更新

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 从 [GitHub Releases](https://github.com/DreamYuande/ucampus-ai-helper/releases/latest) 下载发布的 `.user.js` 文件。也可以直接[打开最新版脚本](https://github.com/DreamYuande/ucampus-ai-helper/releases/latest/download/ucampus-ai-helper.user.js)。
3. 如果浏览器打开 Tampermonkey 安装窗口，点击「安装」。如果只下载了文件，打开 Tampermonkey 管理面板，新建脚本并粘贴文件内容，保存即可。已安装旧版的用户可以直接替换原脚本内容，保留原有设置。
4. 打开 [U 校园课程页面](https://ucontent.unipus.cn/)，进入具体课程并打开题目页，再从浮窗进入「API 设置」。

从 v2.4.1 起，Tampermonkey 可通过脚本内置的 GitHub Releases 地址检查更新。如果旧版没有收到更新提示，访问上面的安装链接，或在原脚本编辑器中替换内容。

## 配置 API

| 选项 | 填写方式 |
| --- | --- |
| 服务商 | 默认选择「DeepSeek 官方」，自动使用 `https://api.deepseek.com`；使用中转站或其他兼容服务时选择「自定义 API」。 |
| API 地址 | 仅自定义模式显示。填服务商提供的 OpenAI 兼容 Base URL，例如 `https://api.example.com/v1`。 |
| API Key | 填所选服务商的 Key。DeepSeek 官方必填；自定义服务不要求认证时可留空。 |
| 模型 ID | 输入 Key 后可从自动获取的模型列表中选择，也可以点击「获取列表」或直接填写模型 ID。列表依赖服务商的 `/models` 接口。 |

选好模型后点「保存设置」，脚本会返回题目页并开始识别。作答使用服务商的 `/chat/completions` 接口。

## 使用方式

- **自动读题**。保存有效的 API 配置后，无需切换模式。当前台课程页显示可识别的题目时，脚本会读题并请求模型；空白答题框会尝试自动填入，已有作答不会被覆盖。同一题在当前标签页最多自动请求一次，重新保存 API 配置后会重新识别。
- **重新搜题**。点击「重新搜题」会重新识别并发起新的模型请求，不复用缓存。你可以核对结果后点击「填入」或「复制」。提交仍由你手动完成。
- **浮窗位置**。首次显示在浏览器右下角，可拖动标题栏；收起后，悬浮球仍在右下角。

目前支持常见选择题、填空题，以及部分 U 校园 PC 课程的分栏翻译、句型改写和拖拽配对。自动答题依赖可识别的题目结构和可填写的控件。拖拽是否生效取决于页面，卡片未按预期移动时可根据面板答案手动调整。

## 常见问题

- **模型列表为空或报 404**。检查 Base URL。能调用 Chat Completions 但没有 `/models` 的服务商可以直接填模型 ID。
- **提示请求失败**。检查服务商权限、API Key、模型名和网络。自定义 API 域名可能需要在 Tampermonkey 中授权。
- **读不到题或填不进去**。先展开「查看题目原文」，确认识别到的是目标题目。课程布局更新后可能需要适配。反馈时请附脚本版本、浏览器和题型，并移除个人信息和密钥。

## 数据与费用

题目文本会发送到你配置的 API。API Key 由 Tampermonkey 保存在该脚本的本地存储里，脚本会用它向你配置的服务商认证。自定义地址需要脚本的 `@connect *` 权限。自动答题可能产生 API 费用，具体取决于服务商。

## 许可证

[MIT](LICENSE)。版本变更见 [更新日志](CHANGELOG.md)。
