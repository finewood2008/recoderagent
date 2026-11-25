# 会议录音智能体

从 Google Antigravity 的会议录音原型演进而来。这是独立的 WANX 应用工程，使用记忆盒子提供的 Electron 运行时、Host SDK 和安装协议。更新本应用可以单独发布应用 ZIP。

## 安装

连接盒子后，在支持会议录音启动入口的客户端通过「配件 → 会议 AI 定向麦克风 → 打开会议录音智能体」启动。首次打开时选择 `dist/meeting-recorder-0.1.0.zip` 安装包。

会议原音和报告保存在该应用的本机数据目录。盒端转写和报告能力取决于所连接的盒子。使用云端总结前需要本场确认。定稿后可归档到盒子空间。历史记忆联查和自动采集需要独立应用可用的本机记忆接口。原配件记录仍可从原有来源链接查看。

导入音频和超限音频转换依赖 FFprobe、FFmpeg。应用在 macOS 上查找 Homebrew 的标准安装位置，也支持环境变量 `FFPROBE_BIN` 和 `FFMPEG_BIN`。

## 本机开发

使用 Node.js 22 或更新版本运行 `npm test`。本机录音界面可以用 Electron 直接加载本目录，盒端能力通过记忆盒子启动后可用。

生成记忆盒子安装包前，将 WANX App Kit 生成的 `centaurai-wanx-host-sdk-0.3.0.tgz` 放到 `vendor/`，然后运行 `npm ci` 和 `npm run package`。宿主在启动时提供应用会话，由 Host SDK 在主进程接收。
