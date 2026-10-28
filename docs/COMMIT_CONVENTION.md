# Git Commit 提交信息规范

> 本仓库的提交信息格式规范。所有提交到 `main` 的 commit 都必须遵守。
>
> 参考：[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) ·
> [git-commit(1)](https://git-scm.com/docs/git-commit#_discussion)（commit 信息结构）

---

## 1. 快速参考

```
<type>: <title>

<body>
```

| 要素 | 规则 |
|---|---|
| `<type>` | §3 白名单之一，**全小写** |
| 分隔符 | 冒号 + **一个半角空格**（`: `） |
| `<title>` | **≤ 80 字符**，非空，不以句号结尾 |
| `<body>` | 可选；**≤ 280 字符**且**每行 ≤ 72 字符**；title 后**空一行**再写 |
| 计数方式 | title 与 body **分别计算**，互不占用额度 |

**一行示例**

```
feat: add region selector to the popup
```

**带 body 示例**

```
feat: add region selector to the popup

Region maps to an endpoint through provider metadata, so the API key
cannot silently drift from its region.
```

---

## 2. 完整格式

```
<type>: <title>

<body>

<footer>
```

| 部分 | 必填 | 规则 |
|---|---|---|
| `type` | ✅ | §3 白名单，全小写 |
| `title` | ✅ | ≤ 80 字符；描述**做了什么**；祈使语气；不以句号结尾 |
| 空行 | 有 body 时 ✅ | title 与 body 之间**恰好一个空行** |
| `body` | — | ≤ 280 字符；说明**为什么**这么做（动机、取舍、影响） |
| `footer` | — | 关联信息，如 `Refs: #12`、`Closes: #1`（见 §6） |

**多段 body**：body 内部可以空行分段。**每个段落**都计入 280 字符总额度
（即 body 总长 ≤ 280，而不是每段 280）。

**关于 scope**：本仓库**不使用** `feat(popup): …` 这类 scope 括号。
需要点明影响范围时，把范围写进 title：

```
✅ feat: add region selector to the popup
❌ feat(popup): add region selector
```

**关于破坏性变更**：本仓库**不使用** `!` 标记（`feat!: …`）。
破坏性变更请在 body 中说明，并在 footer 用 `BREAKING CHANGE:` 起头：

```
feat: drop the legacy batch transcription API

Batch transcription is removed; streaming replaces it for all cases.

BREAKING CHANGE: providers no longer expose transcribe().
```

---

## 3. 类型白名单

只使用以下 11 个类型，**全小写**：

| 类型 | 用于 | 示例 |
|---|---|---|
| `feat` | 新增功能、面向用户的行为变化 | `feat: add keyboard shortcuts` |
| `fix` | 修复缺陷 | `fix: keep tab recording state` |
| `perf` | 性能优化（**不改变外部行为**） | `perf: halve the streaming frame latency` |
| `refactor` | 重构：行为不变，结构改变 | `refactor: deduplicate the timestamp helper` |
| `docs` | 文档（含注释、README、本规范） | `docs: clarify the length rule` |
| `test` | 新增或修改测试 | `test: cover the frame size boundary` |
| `build` | 构建系统、依赖、打包产物 | `build: bump puppeteer-core` |
| `ci` | CI 配置与脚本（`.github/workflows/`） | `ci: cache npm between runs` |
| `chore` | 其它不影响源码的杂项 | `chore: ignore agent skill installs` |
| `style` | 格式调整，不影响逻辑 | `style: reindent popup.css` |
| `revert` | 回滚此前的提交 | `revert: undo the direct push` |

### 类型选择原则

**先判断改动是否影响运行时行为**：

| 改动性质 | 用 |
|---|---|
| 新增功能 / 行为变化 | `feat` |
| 修缺陷 | `fix` |
| 性能更好、行为不变 | `perf` |
| 结构更清晰、行为不变 | `refactor` |
| 只有格式变化 | `style` |

**再按「改的是哪一层」区分非代码类改动**：

| 改动对象 | 用 |
|---|---|
| 文档 / 注释 / 本规范 | `docs` |
| 测试代码 | `test` |
| `package.json`、依赖版本、打包脚本 | `build` |
| `.github/workflows/`、CI 脚本 | `ci` |
| 仓库配置（`.gitignore`、编辑器配置等） | `chore` |
| 撤销某个已有提交 | `revert` |

**容易混的几组**：

- `perf` vs `refactor` —— 前者**以性能为目的**（且不改行为），后者以结构为目的。若一次改动同时做了两件事，拆开提交。
- `build` vs `chore` —— 凡涉及 `package.json` / 依赖 / 打包，用 `build`；仓库配置等其它杂项用 `chore`。
- `ci` vs `build` —— CI 配置本身用 `ci`；CI 里用到的构建脚本仍属 `build`。
- `revert` —— 用 `git revert` 生成时，title 写清回滚了什么；body 里用 `This reverts commit <SHA>.` 注明来源。
- 一次提交只做一件事。类型混用时**拆成多个提交**。

> **为什么是这 11 个**：`feat` 与 `fix` 由 [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
> 强制（对应语义化版本的 MINOR / PATCH），其余为团队自定。本仓库的这组取自
> commitlint 的 `config-conventional`（在 Angular 约定的基础上补入 `chore` / `style` / `revert`）。
> 选型依据是**本仓库历史中实际发生过的归类困难**：此前 `chore` 承担了构建、CI、性能、回滚四类语义，
> 混杂度超过一半；补入 `build` / `ci` / `perf` / `revert` 后，`chore` 只留真正的杂项。

---

## 4. 长度限制

| 部分 | 上限 | 计算方式 |
|---|---|---|
| `title` | **80 字符** | 从 `type: ` 之后到行尾；不含 type 前缀 |
| `body` | **280 字符** | body 全文；含内部分段空行 |
| body 每行 | **72 字符** | 见下方「body 换行」 |

title 与 body **分别计算**，互不挤占。

### body 换行

body 的**每一行**不超过 **72 字符**，长句手动换行。

**为什么是 72**：`git log` 默认按 80 列显示，而它会**给 body 额外缩进 4 个空格**
（标题不受影响）。因此 body 在 80 列终端里的可用宽度是 72；超出就会折行或被截断，
破坏可读性。72 也是 Kubernetes 与 Chromium 的取值（Linux 用 75，理由相同）。

```
fix: keep tab recording state across popup lifetimes

State lived only in the popup's module scope, so closing the popup
reset the buttons while audio kept recording. It now lives in the
service worker, keyed to the offscreen document's existence.
```

**换行是语义换行，不是硬折行**：在句子或从句的边界断开，不要把一个词组从中间劈开。
代码标识符、URL、文件路径**不要**为凑宽度而拆开 —— 让该行略超 72 比拆断标识符更好。

> 这一条是**约定**（靠 review 把关），不做自动校验：它与 280 字符的总额度是两个维度
> —— 前者管「单行可读性」，后者管「body 别变成变更日志」。极端情况下 body 可以既满足
> 280 总长、又只有 3–4 行（因为每行 72）。

### 为什么不按类型细分

统一上限，不因类型而异。理由：

1. **限制的目的与类型无关** —— title 限长的理由是 `git log --oneline`、GitHub 提交列表的
   可读性；这个理由对 `feat` 和 `docs` 完全一样。
2. **一个数字好记** —— 按类型给出多套数字，必然有人记错，最终等于没有规范。
3. **业界惯例一致** —— Conventional Commits 未按类型区分长度；
   git 官方文档也只给单一建议值。

### 实践建议

- title 尽量控制在 **50 字符内**：git 官方建议「no more than 50 characters」，
  80 是硬上限而非目标。多数标题 30–50 字符即可说清。
- 字符数按 **Unicode 字符**计（一个汉字算 1 个），不是字节数。
- 需要长篇说明时，**不要**塞进 body —— 写进 PR 描述或代码注释。
  body 的定位是「为什么」，不是「完整变更日志」。

### 超限了怎么办

按此顺序处理：

1. **精简措辞** —— 大多数超限是冗余造成的（删掉「in order to」「the」等）。
2. **移到 body** —— title 超限时，把细节挪到 body（body 有独立额度）。
3. **移到 PR 描述** —— body 也放不下时，commit 里只留一句动机，细节放 PR。
4. **拆分提交** —— 一个提交讲不清两件事时，说明它本就该拆开。

---

## 5. 示例

### ✅ 符合规范

```
feat: add region selector to the popup
fix: keep tab recording state across popup lifetimes
perf: halve the streaming frame latency
refactor: deduplicate the timestamp helper
docs: clarify the title and body length rules
test: cover the frame size boundary
build: bump puppeteer-core
ci: cache npm between workflow runs
chore: ignore agent skill installs
style: normalize indentation in the options page
revert: undo the direct push of the frame latency change
```

带 body：

```
fix: keep tab recording state across popup lifetimes

State lived only in the popup's module scope, so closing the popup
reset the buttons while audio kept recording. It now lives in the
service worker, keyed to the offscreen document's existence.
```

### ❌ 不符合规范

| 提交信息 | 问题 |
|---|---|
| `feat(popup): add region selector` | 不使用 scope 括号（§2） |
| `feat!: drop the legacy API` | 不使用 `!`；改用 `BREAKING CHANGE:` footer（§2） |
| `Feat: add region selector` | type 必须全小写（§3） |
| `feat:add region selector` | 冒号后缺空格（§1） |
| `feat: ` | title 为空 |
| `add region selector` | 缺 `<type>: ` 前缀 |
| `feat: add region selector.` | title 以句号结尾（§7） |
| `feat: added the region selector` | 用祈使语气 `add`，不用 `added`（§7） |
| `wip: start the region selector` | `wip` 不在白名单（§3） |
| `update: tweak the popup` | `update` 不在白名单（§3） |
| title 超过 80 字符 | 超限（§4） |
| body 超过 280 字符 | 超限（§4） |

---

## 6. Footer（关联信息）

footer 放在 body 之后，**空一行**，每行一条，格式 `Token: value`：

| Token | 用途 | 示例 |
|---|---|---|
| `Refs` | 关联但不关闭 | `Refs: #12` |
| `Closes` | 合并后自动关闭 | `Closes: #1` |
| `Fixes` | 同上（修 bug 场景） | `Fixes: #7` |
| `BREAKING CHANGE` | 声明破坏性变更（必须大写） | `BREAKING CHANGE: providers no longer expose transcribe().` |
| `Co-authored-by` | 共同作者 | `Co-authored-by: Name <mail@example.com>` |

多个 issue 用逗号分隔：`Refs: #12, #15`。

> footer **不计入** body 的 280 字符额度。

---

## 7. 写作约定

以下由 code review 把关（规范要求，但无自动校验）：

| 约定 | 说明 |
|---|---|
| **祈使语气** | `add` / `fix` / `remove`，不用 `added` / `fixes` / `removing`。读作「应用此提交将…」 |
| **title 不以句号结尾** | `feat: add region selector`，不是 `…selector.` |
| **title 首字母小写** | 紧跟 `type: ` 之后不大写（专有名词如 `Chrome`、`DashScope` 除外） |
| **body 讲「为什么」** | diff 已说明「做了什么」；body 解释动机、取舍、副作用 |
| **body 用完整句子** | 便于日后 `git log` 阅读；不要写成关键词堆叠 |
| **body 每行 ≤72 字符** | 见 §4「body 换行」；`git log` 会给 body 缩进 4 格，80 列终端下可用 72 |
| **一行一件事** | 见 §3「类型选择原则」 |
| **不写无信息量的 title** | `fix: bug`、`feat: update` 无价值，需说明具体对象 |
| **不引用本地路径** | 不要写 `temp/…`、`C:\…`；这些对他人无意义 |

---

## 8. 提交前自检

- [ ] `<type>` 在 §3 白名单内，且全小写
- [ ] 冒号后有且仅有一个半角空格
- [ ] title 非空、≤ 80 字符、祈使语气、不以句号结尾
- [ ] 有 body 时，title 与 body 之间恰好一个空行
- [ ] body ≤ 280 字符（含内部分段空行），且**每行 ≤ 72 字符**
- [ ] 未使用 scope 括号与 `!`
- [ ] 破坏性变更已用 `BREAKING CHANGE:` footer 声明
- [ ] 关联的 issue 已写入 footer（`Refs:` / `Closes:`）

### 自动校验

本规范**已可执行**，不靠自觉：

| 位置 | 机制 |
|---|---|
| 本地提交 | `.husky/commit-msg` → 跑 `commitlint --edit`，不合规直接拒绝提交 |
| CI（PR） | 校验该 PR 新增的提交**与 PR 标题**（squash 合并时标题会成为 commit subject） |
| CI（push） | 校验本次推送新增的完整提交；GitHub 自动生成的 squash 正文仅豁免长度限制，subject 仍完整校验 |

规则配置在 [`commitlint.config.mjs`](../commitlint.config.mjs)，与本文档逐条对应。

```sh
npm install              # 装依赖时会自动装上钩子（husky 的 prepare 脚本）
npm run lint:commit      # 手动检查当前分支相对 origin/main 的提交
```

**例外**：`Merge …`、`Revert …`、`fixup!`、`squash!` 与纯版本号消息由 commitlint 默认跳过
（`defaultIgnores`），因为它们是 git 生成的，不适用本规范。

GitHub 的 squash 合并会把 PR 内每个提交的 body 聚合成一个新的 commit body。聚合结果可能
超过 280 字符，即使每个源提交单独都合规；在 PR CI 中这些源提交已经逐条完整校验。因此
push CI 对可识别的 GitHub squash commit 只校验 subject，跳过聚合 body 的长度限制。
本地创建或直接 push 的普通提交仍执行完整 body 校验。

> 校验范围只覆盖 `feat`/`fix`/… 这类**格式**要求。§7 的写作约定（祈使语气、body 讲「为什么」）
> 无法自动检测，仍由 code review 把关。

---

## 9. 常见问题

**Q：提交信息能用中文吗？**
可以。本仓库的提交信息历史上以英文为主，但中文同样合规 —— 关键是格式正确、语义清晰。
同一仓库内建议保持一致。

**Q：title 里能带数字、版本号、代码标识符吗？**
可以，且鼓励具体：`fix: correct the 16 kHz resample ratio`。
注意反引号（`` ` ``）在 commit 信息中不渲染，不要用它做强调。

**Q：body 换行要手动敲吗？有工具吗？**
是，手动换行。规范不强制工具，但多数编辑器可设置「硬换行 72 列」，
`git config core.editor` 指向的编辑器通常也支持（如 Vim 的 `:set textwidth=72`）。
提交前看一眼 `git log -1` 的输出即可发现折行问题。

**Q：一次提交改了多个文件，怎么定类型？**
看**主要意图**，不是文件数量。例如新增功能顺带调了格式 → `feat`（格式调整是附带的）。
若两件事都重要，拆成两个提交。

**Q：`WIP` 或临时提交怎么写？**
本仓库不鼓励在共享分支上保留临时提交。本地可用任意信息，
**推送前**用 `git rebase -i` 整理为符合规范的提交。

**Q：merge 或 squash 提交需要遵守吗？**
GitHub 的 PR 合并提交（`Merge pull request #N from …`）由平台生成，属于例外。
squash 提交的 subject 仍需合规；自动聚合的 body 只豁免长度限制，源提交已在 PR CI
中完整校验。本地手动创建的 merge 提交同样不要求符合本规范。

**Q：如何修改已提交的信息？**
最近一次：`git commit --amend`。
更早的：`git rebase -i <commit>` 后用 `reword`。
**注意**：已推送的提交改写会改变哈希，共享分支上需谨慎（必要时 `--force-with-lease`）。

---

## 10. 相关文档

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — 贡献流程与提交前缀速查
- [`AGENTS.md`](../AGENTS.md) — 面向 AI 编码代理的仓库约定
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) — 本规范的上游约定
- [`commitlint.config.mjs`](../commitlint.config.mjs) — 本规范的可执行版本（含与上游默认配置的偏离说明）
