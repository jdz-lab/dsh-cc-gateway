# dsh-cc-gateway

> 把 [cc-lens](https://github.com/jdz-lab/cc-lens) 的 Claude Code 客户端指纹注入搬进 DeepSeek Harness（DSH）宿主进程，让 `dsh-llm-pi-ai` 的模型路由**直连**校验 Claude Code 指纹的公司内网网关 —— 不再需要单独启动本地代理进程。

> **发布说明**：本仓库为公开副本，示例中的网关地址（`gw.example.com`）均为占位符，`upstreams` 请换成你自己的内网网关地址。指纹常量来自对真实 Claude Code 流量的抓包分析，见 [cc-lens](https://github.com/jdz-lab/cc-lens) 项目。

## 这是什么

不少内网网关（new-api / one-api 及其衍生）按 5 项客户端特征联合判定请求是否来自 Claude Code，缺一不可（结论来自 cc-lens 对真实 Claude Code 流量的抓包分析）：

| # | 位置 | 注入内容 |
|---|------|---------|
| 1 | 请求头 `User-Agent` | `claude-cli/2.1.294 (external, sdk-cli)` |
| 2 | 请求头 `x-app` | `cli` |
| 3 | 请求头 `anthropic-beta` | 追加 `claude-code-20250219`（不覆盖已有值） |
| 4 | 请求体 `system[0]` | `x-anthropic-billing-header: ...` 计费标识块 |
| 5 | 请求体 `metadata.user_id` | 含 device_id / session_id 的 JSON 字符串 |

之前：`DSH → cc-lens (127.0.0.1:8787) → 内网网关`，cc-lens 进程必须一直挂着。
现在：`DSH → 内网网关`，指纹在 DSH 宿主进程内注入。

## 工作原理

本插件**不实现任何协议**。模型请求仍由 `dsh-llm-pi-ai` 路由（`api: anthropic-messages`）发出；本插件在宿主进程里给全局 `fetch` 装一个**作用域受限的改写器**：

- 只对 `upstreams` 配置的源（`scheme://host[:port]`）生效，其余请求原样放行；
- 命中的所有请求补/改头 1–3（`GET /v1/models` 模型发现同样受益）；
- `POST */v1/messages` 再补体 4–5；非法 JSON 原样转发，让上游报错；
- 改写器内部任何异常都按原样放行，不影响其他流量；
- 停用 / 重载时恢复原始 `fetch`，重复安装不叠层。

LLM 请求链路里没有别处替换过全局 fetch（`dsh-llm-pi-ai` 未向 pi-ai 传自定义 fetch，Anthropic SDK 的 `getDefaultFetch()` 直接读全局），所以模型请求与模型发现都会经过改写器。

## 配置

bundle patch（`cordis.patch.yml`）默认条目：

```yaml
- insert:
    - id: cc-gateway
      name: dsh-cc-gateway
      config:
        upstreams:
          - https://gw.example.com
```

在本 profile 的 `cordis.patch.yml` 里用同名条目可整体覆盖 `config`（patch 语义是整行替换，不是合并）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `upstreams` | （必填） | 要注入指纹的源，字符串或字符串数组；带非默认端口时端口必须写全 |
| `claudeVersion` | `2.1.294` | UA 与计费块里的 Claude Code 版本号 |
| `entrypoint` | `sdk-cli` | UA 后缀与 `cc_entrypoint` |
| `betaTag` | `claude-code-20250219` | 追加到 `anthropic-beta` 的标签 |
| `deviceId` | cc-lens 同款常量 | `metadata.user_id` 里的 device_id |
| `accountUuid` | `""` | `metadata.user_id` 里的 account_uuid |

网关升级检测方式后，优先改 `lib/index.js` 顶部的 `DEFAULTS` 常量（与 cc-lens 的维护方式一致）。

## 配套的路由改动

`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 的 `claude-cli` 路由需要直连网关：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      claude-cli:
        displayName: 公司专用
        apiKeyEnv: CLAUDE_CLI_API_KEY
        api: anthropic-messages
        baseURL: https://gw.example.com        # 不再是 http://127.0.0.1:8787
        models:
          - id: claude-opus-5-5
            name: claude-opus-5-5
```

改完可以停掉本地代理进程了。

## 安装 / 卸载

零依赖、无构建脚本。安装（本地路径）：

```
plugin_manager install_bundle <插件目录>
```

或用 CLI：`dsh plugin install <插件目录> --profile desktop`。

以 link 方式安装：插件目录就是插件的唯一实体，**请放在长期位置**（也可以直接放进 profile 目录内，随 profile 一起备份迁移）。卸载用 Web 插件页或 `dsh plugin remove`。替换插件代码后需重启 DSH 进程才加载新 JS 模块。

## 本地自测

零依赖，Node ≥ 18：

```bash
node test/run.mjs
```

覆盖：五项指纹注入、`anthropic-beta` 合并、模型发现只改头、非法 JSON 透传、未命中源不受影响、Request 对象风格调用、恢复与重复安装幂等。

## 与 cc-lens 的差异

- 只做指纹注入，不做 OpenAI 兼容桥（`/v1/chat/completions` 转换）—— DSH 里 `dsh-llm-pi-ai` 直接说 Anthropic 协议，用不上；
- 没有观测面板 —— DSH 自带 Token 用量统计；需要时可以再给插件注册 webServer 路由；
- 请求不落盘、不做应用识别。

## 免责声明

同 cc-lens：仅供个人在已付费/已授权的平台上自用与学习，请遵守所在平台的服务条款。
