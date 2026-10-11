# FuckOuCHN（AI 维护二改版）

> 国开自动刷课程序 - 基于 Node.js、Electron 和 Playwright

一款自动化刷课工具，支持视频播放、自动答题、并发处理等功能。

## 📌 关于本二改版（重要说明）

- 本项目**转载/二改自原作者 [NekoMirra](https://github.com/NekoMirra) 的仓库 [NekoMirra/FuckOuCHN](https://github.com/NekoMirra/FuckOuCHN)**，原作者仓库长期未维护更新。
- 原版已停止维护，本仓库由 **AI 辅助维护更新**：修复已知 Bug、适配国开平台的接口变动，并按使用需求增加新功能。
- 本项目沿用原仓库的 [MIT License](LICENSE)，感谢原作者的贡献。
- 新增/修复内容见文末「二改版改动清单」。

## ✨ 功能特性

- 🎬 **视频自动播放** - 支持倍速播放（最高 16 倍速）
- 📝 **AI 自动答题** - 支持单选、多选、判断、简答等题型
- 🚀 **并发刷课** - 多窗口并行处理，效率翻倍
- 📊 **进度面板** - 实时显示刷课进度
- 📈 **平台真实完成度** - 每 60 秒从国开服务器拉取各课程完成百分比，平台算完才算完
- 📏 **最短耗时优先** - 自动按"剩余活动量"升序安排课程，内容最少的课最先刷完
- 🛡️ **风控检测** - 自动检测账号封禁状态
- 📄 **PDF 自动浏览** - 自动滚动资料页面

## 📋 二改版改动清单（相对原版）

1. **修复视频进度上报 404**：`activities-read` 接口改为 `POST /course/activities-read/{activityId}` 并携带 `{start, end}` 观看秒数。原版旧路径返回 404，平台不记录进度，导致每次重启都从头刷。
2. **修复登录后卡死**：登录成功判定改为 URL 前缀匹配，兼容国开 `?locale=en` 英文环境跳转（原版精确匹配会永远等待）。
3. **新增平台真实完成度面板**：进度面板每 60 秒轮询国开 `my-completeness` 接口，显示每门课「已完成/总数 + 百分比」，数据来自平台服务器而非本地计数。
4. **课程组最短耗时优先排序**：启动时统计各课程剩余未完成活动量，剩余最少的课最先整体刷完。
5. **运行时长统计**：进度面板实时显示「本次运行 / 今日累计」时长，今日累计跨重启持久化（`.runtime-stats.json`）。
6. **系统托盘与关闭最小化**：程序常驻右下角托盘；关闭窗口默认最小化到托盘继续后台刷课，托盘菜单可切换该开关、恢复窗口或退出。进度面板默认不再置顶（`_UI_TOPMOST=0`）。
6. **会话失效防护**：登录后校验会话有效性；课程列表为空时明确报错并重试，不再静默退出。
7. **修复考试模块崩溃**："边学边练"等小测验无 `subjects` 数据时跳过该考试，不再让整个课程组崩溃（`flatMap of undefined`）。
8. **错误处理增强**：主流程异常全部落日志（含二次执行失败原因），退出不再无声无息。
9. **应用菜单汉化**：文件/编辑/视图/窗口/帮助。
10. **强制中文环境**：Chromium 以 `zh-CN` 启动，避免国开站点跳转英文页面影响自动化。
11. **打包修复**：隔离 `@noble/hashes` 版本冲突，`electron-builder --win portable` 可正常产出单文件 exe。

## 📦 快速开始



### 从源码运行

#### 1. 环境准备

- 安装 [Node.js](https://nodejs.org/zh-cn) (v18+)
- 安装 [Yarn](https://yarnpkg.com/)

```bash
npm install -g yarn --registry=https://registry.npmmirror.com
```

#### 2. 克隆项目

```bash
git clone https://github.com/YOUR_NAME/FuckOuCHN.git  # 换成本仓库地址
cd FuckOuCHN
```

#### 3. 配置账号

```bash
# 复制配置模板
cp .env.template .env

# 编辑 .env 文件，填写你的账号和密码
```

#### 4. 安装依赖

```bash
yarn config set registry https://registry.npmmirror.com
yarn install
```

#### 5. 启动程序

```bash
yarn start:electron
```

## ⚙️ 配置说明

编辑 `.env` 文件进行配置：

### 必填配置

```properties
_ACCOUNT="你的账号"
_PASSWORD="你的密码"
```

### 功能开关

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `_ENABLE_VIDEO` | 视频刷课开关（1=开启，0=关闭） | 1 |
| `_ENABLE_EXAM` | 自动答题开关（1=开启，0=关闭） | 1 |
| `_PLAY_RATE` | 视频播放倍速 | 8 |
| `_TOTAL_POINTS` | 考试及格分数，达到后自动结束 | 60 |

### AI 答题配置

```properties
_API="https://api.openai.com/v1"  # API 接口地址
_KEY="your-api-key"                # API 密钥
_MODEL="gpt-4o-mini"               # 模型名称
_Qps=1                             # 每秒请求数
```

### 并发配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `_CONCURRENCY` | 并发窗口数（0=自动，1-6=固定） | 1 |
| `_SHOW_WORKERS` | 显示所有窗口（0=只显示主窗口） | 0 |
| `_UI_TOPMOST` | 进度面板置顶 | 1 |

### 课程选择

```properties
# 选择特定课程组
_GROUP_INDEX=0          # 0=全部，1-N=指定序号
_GROUP_TITLE=英语       # 按标题模糊匹配

# 执行策略
_LOWEST_N=10            # 只处理进度最低的 N 个课程
_NON_INTERACTIVE=1      # 非交互模式
```

完整配置请参考 [.env.template](.env.template)

## ⚠️ 注意事项

1. **人机验证** - 登录时可能需要手动完成验证
2. **避免操作** - 程序运行时请勿操作浏览器窗口
3. **风控提示** - 如果账号被检测到异常，会自动暂停并提示
4. **合理使用** - 建议设置合理的并发数和倍速，避免触发风控

## 🔨 开发相关

### 本地开发

```bash
# 编译 TypeScript
yarn build

# 启动程序
yarn start:electron
```

### 打包发布

```bash
# 设置 Electron 镜像（可选）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 打包
yarn build:electron
```

### 代码格式化

```bash
npx prettier --write ./src ./core/src
```

## 📄 License

[MIT](LICENSE)

## 🙏 致谢

本项目基于 [ImsTech](https://github.com/2468785842/ImsTech) 二次开发
