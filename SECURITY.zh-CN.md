[English](SECURITY.md) | **简体中文**

# 安全策略

## 报告漏洞

对于安全漏洞，请**不要公开提交 issue**。

请通过 GitHub Security Advisories（仓库 Security 标签页中的 “Report a vulnerability”）私下报告，或发送邮件至 **security@octoryn.com**。报告中请包含漏洞描述、复现步骤和影响范围。我们会力争在几个工作日内予以确认。

## 范围说明

Octopus Scout 会抓取并渲染任意 URL，因此有几处区域在设计上就与安全密切相关：

- **SSRF 防护 (SSRF protection)** —— 出站的 fetch/render 会经过一个 URL 守卫 (guard) 把关，它会拒绝非 `http(s)` 协议以及解析到私有 / 回环 (loopback) / 链路本地 (link-local) / 元数据 (metadata) 地址的主机，并对每一跳重定向（直连、走代理、浏览器路径）重新校验。如发现任何绕过，请上报。
- **内容限制 (content limits)** —— 响应会受大小上限约束，并按 content-type 过滤。
- **认证 (auth)** —— `OCTORYN_SCOUT_AUTH_MODE` + API key 用于保护涉及改动以及治理 (governance)/管理 (admin) 的端点。在未配置任何 key 时，认证处于关闭状态（仅适用于受信任的本地使用场景）；切勿将未经认证的实例公开暴露。
- **运维方责任 (operator responsibility)** —— 代理 (proxy) 的使用以及 CAPTCHA 求解器接缝 (seam)（`docs/CAPTCHA.md`）均由运维方自行提供；你需自行负责合法使用它们，并遵守目标站点的服务条款。

## 受支持的版本

本项目尚处于 1.0 之前阶段；仅最新版本会获得修复。
