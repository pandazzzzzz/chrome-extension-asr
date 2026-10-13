# 贡献指南

感谢你考虑为这个项目做出贡献！

## 如何贡献

### 报告 Bug

如果你发现了 bug，请创建一个 Issue 并包含以下信息：

- Bug 的详细描述
- 复现步骤
- 预期行为
- 实际行为
- 截图（如果适用）
- Chrome 版本和操作系统

### 提出新功能

如果你有新功能的想法：

1. 先检查 Issues 中是否已有类似建议
2. 创建一个新的 Issue 描述你的想法
3. 等待维护者的反馈

### 提交代码

1. Fork 这个仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的改动 (`git commit -m 'feat: 添加新功能'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

### 代码规范

- 使用有意义的变量和函数名
- 添加必要的注释
- 保持代码简洁清晰
- 遵循现有的代码风格

### 提交信息规范

完整规范见 **[`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md)**。要点：

格式为 `<type>: <title>`，类型为以下 11 个之一（全小写）：

- `feat:` 新增功能或行为变化
- `fix:` 修复缺陷
- `perf:` 性能优化（不改变外部行为）
- `refactor:` 重构（行为不变）
- `docs:` 文档
- `test:` 测试
- `build:` 构建系统、依赖、打包
- `ci:` CI 配置与脚本
- `chore:` 其它杂项
- `style:` 格式调整（不影响逻辑）
- `revert:` 回滚提交

**长度限制**（title 与 body 分别计算）：

- `title` ≤ **80 字符**（建议 ≤50），非空、祈使语气、不以句号结尾
- `body` ≤ **280 字符**，可选；与 title 之间空一行；说明**为什么**
- body **每行 ≤ 72 字符** —— `git log` 会给 body 缩进 4 格，80 列终端下可用 72

**不使用** scope 括号（`feat(popup): …`）与 `!` 标记（`feat!: …`）——
需要点明范围时写进 title，破坏性变更用 `BREAKING CHANGE:` footer 声明。

```
feat: add region selector to the popup

Region maps to an endpoint through provider metadata, so the API key
cannot silently drift from its region.
```

> 提交前请对照规范末尾的[自检清单](docs/COMMIT_CONVENTION.md#8-提交前自检)。

## 开发流程

1. 克隆仓库
2. 在 Chrome 中加载插件进行测试（扩展本身无构建步骤，`Load unpacked` 即跑）
3. 进行你的修改
4. 测试所有功能
5. 提交 Pull Request

> 可选：`npm ci` 会从 `package-lock.json` 安装唯一 devDependency（`puppeteer-core`）。
> 只有 gitignored 的 `temp/` 本地测试脚本需要它——扩展运行时**不依赖任何 npm 包**，
> 不装也不影响开发与加载。

提交前建议本地跑一遍 CI 会跑的检查：

```
npm test                        # 单元测试（streaming 18 + pack 5 用例，纯 Node）
node scripts/check-manifest.js  # manifest.json 与所引路径校验
npm run pack                    # 打包 extension.zip
```

PR 会触发 GitHub Actions：`CI`（语法/manifest/单测/打包）、`CodeQL`（静态安全分析）、
`Dependency review`（新依赖漏洞检查）。详见 `.github/workflows/`。

## 问题和讨论

如有任何问题，欢迎在 Issues 中提出讨论。

## 行为准则

- 尊重所有贡献者
- 保持友好和专业
- 接受建设性的批评
- 关注对项目最有利的事情

感谢你的贡献！
