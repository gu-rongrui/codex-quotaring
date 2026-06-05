# Codex QuotaRing

中文说明 | [English](README.md)

A Windows tray app for monitoring ChatGPT Codex balance and usage limits.

Codex QuotaRing 是一个非官方 Windows 托盘工具，可以在紧凑面板、托盘图标和可选浮动状态栏中显示 5 小时额度和每周额度。

## 效果预览

![Codex Balance Tray 效果预览](assets/screenshots/combined-preview-a.svg)

## 功能

- 主面板：显示 5 小时余额、每周余额、下次余额恢复时间、最近一次读取余额时间
- Windows 托盘图标：显示 5 小时 usage limit 额度百分比

![托盘图标样式](assets/screenshots/tray-icon-preview.svg)

- 浮动状态栏：常驻桌面显示 5 小时余额
- 浅色 / 深色主题和中文 / 英文界面

![设置页](assets/screenshots/settings-page.svg)

- 手动点击刷新和自动刷新间隔设置
- 低余额通知设置
- 开机自启动选项
- 自定义右键托盘菜单

![右键菜单](assets/screenshots/tray-menu.svg)

## 使用建议规则

主面板会根据 5 小时额度和每周额度显示一句简短使用建议。

| 条件 | 显示内容 |
| --- | --- |
| 每周额度 < 20% | 额度紧张 |
| 5 小时额度 < 15% | 额度紧张 |
| 15% <= 5 小时额度 < 30% | 额度较低 |
| 每周额度 < 40% 且 5 小时额度 >= 30% | 用于关键任务 |
| 30% <= 5 小时额度 < 60% 且 每周额度 >= 40% | 继续使用 |
| 5 小时额度 >= 60% 且 每周额度 >= 40% | 可开启长任务 |

## 重要说明

这是一个非官方工具，不隶属于 OpenAI。

OpenAI 目前没有提供这个 Codex 使用额度页面对应的公开 API。本工具通过读取 ChatGPT Codex 使用页面中的文字内容来显示额度：

```text
https://chatgpt.com/codex/cloud/settings/analytics#usage
```

如果页面结构发生变化，余额读取可能会失败，需要更新解析逻辑。

## 隐私

本工具使用 Electron 浏览器会话，让你可以在本地登录 ChatGPT。登录 Cookie、缓存、偏好设置和应用配置会保存在本地用户数据目录。

请不要提交或分享 `userdata/` 目录。它可能包含浏览器缓存或登录相关数据。

## 开发运行

安装依赖：

```bash
npm install
```

开发模式运行：

```bash
npm start
```

## 构建 Windows 安装包

先安装依赖：

```bash
npm install
```

生成安装包：

```bash
npm run dist
```

安装包会生成在：

```text
dist/
```

## 图标授权

本项目包含 Microsoft Fluent UI System Icons，基于 MIT License 授权。详情见 `NOTICE`。
