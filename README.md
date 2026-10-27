# dsh-opencode-go-usage

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的输入框下方常驻显示 **OpenCode Go** 账号额度（滚动 5 小时 / 本周 / 本月）。

用 Harness 里已经配置好的 `OPENCODE_GO_API_KEY` 查询：key 只在 Host 进程内使用，不会进入浏览器。

![演示](docs/demo.png)

## 功能

- 输入框下方一行：`Go · 5h 0% · 周 5% · 月 34%`
- 当前会话 provider 是 `opencode-go` 时自动显示、自动刷新
- 使用其他 provider 时默认收起为一个小 `Go` 标签，**不展示也不请求**；点开后才请求，收起后停止请求；每个 provider 的选择单独记住
- 每 2 分钟轮询一次；点 `↻` 或数值立即刷新（绕过 Host 60 秒缓存）
- 刷新反馈：请求中显示 `刷新中…` 且图标旋转；成功显示 `✓ 已刷新`；失败保留旧值并显示原因；上次更新时间在 `↻` 的悬浮提示里
- 额度 ≥80% 变警告色、≥95% 变错误色；悬浮每个窗口可看重置倒计时

## 环境

- DeepSeek Harness `0.2.1-rc.3`（桌面版）验证通过
- 无第三方运行时依赖

## 安装

```powershell
dsh plugin --profile <profile> add "file:D:\desk\projects\dsh-opencode-go-usage"
```

也可以在 Harness 里安装本地包目录，然后重启 Harness（或刷新页面）。

前提：Harness 里已经配置 `opencode-go` provider 的 key（环境变量名 `OPENCODE_GO_API_KEY`）。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里给该行加 `config:`：

```yaml
- id: opencode-go-usage
  config:
    cacheMs: 60000      # Host 额度缓存（毫秒）
    timeoutMs: 20000    # 上游请求超时（毫秒）
    provider:
      apiKeyRef: OPENCODE_GO_API_KEY
      usageUrl: https://opencode.ai/zen/go/v1/usage
```

阈值与轮询间隔在 `client.js` 顶部：`POLL_MS`、`WARN_PERCENT`、`CRITICAL_PERCENT`。

## 数据来源与安全

- 数据来源：`GET https://opencode.ai/zen/go/v1/usage`（Bearer 鉴权），返回 `usage.rolling / weekly / monthly` 的百分比与重置时间。
- key 只存在于 Host 进程内存：每次请求实时从 `ctx.credentials` 解析，不落盘、不打日志、不进 HTTP 响应。
- 浏览器只访问本机同源路由 `GET /dsh-opencode-go-usage/api/usage`，经过 Harness 的 Host/Origin 与浏览器会话校验；上游 URL 固定，浏览器只能传 `refresh=1`。
- 上游请求有 20 秒超时、64 KB 响应上限与结构校验，不解析 HTML。

## 文件结构

```text
index.js          Host：凭据解析 / 路由 / 上游请求 / 缓存 / 错误归类
client.js         Client：composer dock 行、provider 跟随、偏好记忆
cordis.patch.yml  bundle 挂载
locale/           插件列表里的标题与描述
icon.svg
```

## 已知差异

本插件显示的百分比来自 OpenCode 公开接口 `/zen/go/v1/usage`。该接口只返回整数百分比，
与官网控制台按实际消费金额显示的数值可能相差 1% 左右，原因暂未查明；
两者不一致时，请以 OpenCode 官网和实际使用限制为准。

## 说明

个人自用插件，非官方项目；OpenCode 接口或 Harness 版本变化可能导致失效。
