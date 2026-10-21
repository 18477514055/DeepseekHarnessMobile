#!/usr/bin/env node
/**
 * 提交前自查：确保**没有任何私密记忆文件**被 git 追踪。
 *
 * ★★★ 为什么需要这个（2026-10-21 真实事故，§86）：
 *
 *   2026-10-19 `ledger_init` 时，我是**照记忆**往 .gitignore 里列路径的，
 *   当时列的是第 1 代的单文件：DECISIONS.md / GOALS.md。
 *   后来记忆结构升到第 2 代，拆成 decisions/ lessons/ goals/ 一卡一文件，
 *   **规则没跟着改** ⇒ 40 个文件真被提交、真被推到 **public** 仓库。
 *   其中 PRINCIPLES.md（用户的根本原则）尤其不该出去。
 *
 *   根因不是"忘了写规则"，是**写完规则没有去核对它到底生效了没有**。
 *   ⇒ 所以这个脚本不检查 .gitignore 写了什么，而是直接问 git
 *     「你到底在追踪哪些文件」—— 那是唯一可信的判据。
 *
 * 用法：node tools/check-private-files.cjs
 *   退出码 0 = 干净；1 = 有泄漏（并列出路径）
 *
 * ★ 建议接到发布流程里：每次 git push 之前跑一次。
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 这些路径形态一律不许进仓库。宁可误报，不可漏报。 */
const FORBIDDEN = [
  // 第 2 代：一卡一文件
  { re: /(^|\/)decisions\//, why: '决策卡（含用户原话与判据）' },
  { re: /(^|\/)lessons\//, why: '经验与教训卡' },
  { re: /(^|\/)goals\//, why: '目标树（含用户原话）' },
  // 第 1 代 / 单文件
  { re: /(^|\/)LEDGER\.md$/, why: '活跃台账' },
  { re: /(^|\/)DECISIONS\.md$/, why: '关键决策（旧单文件）' },
  { re: /(^|\/)GOALS\.md$/, why: '目标树（旧单文件）' },
  { re: /(^|\/)JOURNAL\.md$/, why: '回合流水' },
  { re: /(^|\/)LESSONS\.md$/, why: '经验与教训（旧单文件）' },
  { re: /(^|\/)PRINCIPLES\.md$/, why: '★ 用户的根本原则 —— 只有用户能改，绝不可公开' },
  { re: /(^|\/)\.dsh-ledger\.json$/, why: '台账插件清单（含本机路径）' },
  // 归档 / 分流 / 日志
  { re: /(^|\/)_ledger-archive\//, why: '归档（逐字历史）' },
  { re: /(^|\/)_ledger-log\//, why: '活动日志（含用户原话 L4）' },
  { re: /(^|\/)_stash\//, why: '分流细节' },
  { re: /(^|\/)_handoff\//, why: '交接单' },
];

let files;
try {
  files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
} catch (e) {
  console.error('[check-private] 读不到 git 索引：', e.message);
  process.exit(2);
}

const hits = [];
for (const f of files) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(f)) {
      hits.push({ file: f, why: rule.why });
      break;
    }
  }
}

console.log(`[check-private] 仓库内被追踪的文件：${files.length} 个`);

if (hits.length === 0) {
  console.log('[check-private] ✅ 干净：没有任何私密记忆文件被追踪。');
  process.exit(0);
}

console.error(`[check-private] ❌ 发现 ${hits.length} 个私密文件被 git 追踪：\n`);
for (const h of hits) {
  console.error(`  ${h.file}`);
  console.error(`      ↳ ${h.why}`);
}
console.error(`
修法（二选一）：
  ① 只从当前提交移除（历史仍在）：
       git rm -r --cached <上面的路径>
  ② 连历史一起清（仓库已公开时推荐）：
       git filter-repo --invert-paths \` + <上面的路径> + \`
然后补 .gitignore 并**重跑本脚本**确认。
`);
process.exit(1);
