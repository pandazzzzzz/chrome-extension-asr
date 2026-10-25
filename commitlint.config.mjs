/**
 * commitlint 配置 —— 把 docs/COMMIT_CONVENTION.md 变成可执行的校验。
 *
 * 为什么需要它：规范此前只存在于文档与某台机器的全局钩子里，fresh clone / CI
 * 都拿不到约束。本文件让规则随仓库分发（配 .husky/ 的 commit-msg 钩子 + CI 校验）。
 *
 * 与 config-conventional 的**三处刻意偏离**，每处都对应规范里的明文条款：
 *
 * 1. `subject-max-length` 而非 `header-max-length`
 *    commitlint 的 header = **整行**（含 `type: ` 前缀）；而规范的 title 定义是
 *    「`type: ` 之后的部分」（见 §4 表格）。若用 header-max-length: 80，
 *    实际允许的 title 只有 80 − len('type: ') 个字符，与文档不符。
 *
 * 2. `subject-case` 关闭
 *    config-conventional 禁止 sentence-case，会拒绝 `feat: Chrome extension support`。
 *    规范 §7 明确允许专有名词开头。语气（祈使）无法自动检测，交给 review。
 *
 * 3. `subject-exclamation-mark` 开启
 *    规范 §2 不使用 `!` 标记（破坏性变更用 `BREAKING CHANGE:` footer）。
 *
 * 另外：`defaultIgnores` 保持开启（commitlint 默认）—— 它自动跳过 git 生成的消息
 * （`Merge …` / `Revert …` / `fixup!` / `squash!` / 版本号），这正是本地全局钩子
 * 缺失的能力（此能力来自 commitlint 自身的 defaultIgnores 行为，非本文件配置）。
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 类型白名单：与规范 §3 的 11 个完全一致（config-conventional 默认也是这 11 个，显式写出以防上游变动）
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'],
    ],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],

    // title（= subject）长度：规范 §4「从 `type: ` 之后到行尾，≤80」
    'subject-empty': [2, 'never'],
    'subject-max-length': [2, 'always', 80],
    'subject-full-stop': [2, 'never', '.'],
    'subject-case': [0], // 关闭：规范允许专有名词开头（见文件头第 2 点）
    'subject-exclamation-mark': [2, 'never'], // 规范 §2：不使用 `!`

    // body：规范 §4「≤280 字符，且每行 ≤72」
    'body-max-length': [2, 'always', 280],
    'body-max-line-length': [2, 'always', 72],
    'body-leading-blank': [2, 'always'],

    // footer：规范 §6
    'footer-leading-blank': [2, 'always'],

    // 不使用 scope 括号（规范 §2）—— 设空数组等于「不允许任何 scope」
    'scope-empty': [2, 'always'],
  },
};
