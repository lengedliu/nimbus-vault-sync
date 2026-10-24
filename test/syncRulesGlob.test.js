const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 独立 DATA_DIR：每个测试文件以子进程运行，互不干扰真实 data/
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-test-glob-'));

const syncRules = require('../src/syncRules');

// 项 4 回归（glob 转换缺陷）：
//  - 中段 globstar 规则（a 后接 **/b.md、Archive 后接 **/drafts/*）必须可匹配——
//    占位符管线避免展开出的 (?:.*/)? 里的问号被 ? 替换改写成 .；
//  - notes.* 必须匹配 notes.md——移除 (?<!\.) lookbehind 后，转义点号后的
//    裸 * 也按 [^/]* 展开（旧实现退化成 ^notes\.*$，只匹配 "notes" 加任意个点）；
//  - ? 不跨路径分隔符（与插件端语义一致）；
//  - 默认规则（头部 **/ 前缀分支）不受影响。

const V = 'glob-vault';

async function withPatterns(patterns, fn) {
  await syncRules.saveRules(V, { ignorePatterns: patterns });
  try {
    return await fn();
  } finally {
    await syncRules.removeRulesForVault(V);
  }
}

test('中段 **/ 规则可匹配（占位符管线）', async () => {
  await withPatterns(['a/**/b.md', 'Archive/**/drafts/*', 'x/**/y/**/z.md', '**/deep/**/leaf.md'], () => {
    assert.equal(syncRules.isPathIgnored(V, 'a/b/b.md'), true, 'globstar 至少穿一层（a/**/b）');
    assert.equal(syncRules.isPathIgnored(V, 'a/x/y/b.md'), true, 'globstar 穿多层');
    assert.equal(syncRules.isPathIgnored(V, 'a/other/x.md'), false, '不同后缀不匹配');
    assert.equal(syncRules.isPathIgnored(V, 'Archive/2024/drafts/n1.md'), true);
    assert.equal(syncRules.isPathIgnored(V, 'Archive/drafts/n1.md'), true);
    assert.equal(syncRules.isPathIgnored(V, 'Archive/2024/notes/n1.md'), false);
    assert.equal(syncRules.isPathIgnored(V, 'x/p/y/q/z.md'), true, '多重中段 globstar');
    assert.equal(syncRules.isPathIgnored(V, 'p/q/r/deep/s/leaf.md'), true, '头部 **/ + 多重中段 globstar');
    assert.equal(syncRules.isPathIgnored(V, 'deep/leaf.md'), true, 'globstar 允许零层');
    assert.equal(syncRules.isPathIgnored(V, 'p/leaf.md'), false);
  });
});

test('notes.* 匹配 notes.md 等扩展名（点号后的裸 * 正确展开）', async () => {
  await withPatterns(['notes.*'], () => {
    assert.equal(syncRules.isPathIgnored(V, 'notes.md'), true);
    assert.equal(syncRules.isPathIgnored(V, 'notes.txt'), true);
    assert.equal(syncRules.isPathIgnored(V, 'a/other.md'), false, '裸 * 不跨目录');
    assert.equal(syncRules.isPathIgnored(V, 'direct.md'), false);
  });
});

test('? 不跨路径分隔符（双端语义统一）', async () => {
  await withPatterns(['notes?.md', 'a?c/x.md'], () => {
    assert.equal(syncRules.isPathIgnored(V, 'notes1.md'), true);
    assert.equal(syncRules.isPathIgnored(V, 'notes/.md'), false, '? 不得匹配 /');
  });
});

test('default 规则命中：.obsidian/cache/** 与 **/*.tmp 等不回归', async () => {
  await withPatterns(syncRules.DEFAULT_RULES.ignorePatterns, () => {
    assert.equal(syncRules.isPathIgnored(V, '.obsidian/cache/a/styles.css'), true);
    assert.equal(syncRules.isPathIgnored(V, 'somewhere/file.tmp'), true, '头部 **/*.tmp');
    assert.equal(syncRules.isPathIgnored(V, 'notes.txt'), false, '默认规则不拦截普通笔记');
  });
});

test('尾部 ** 规则（目录整 subtree）', async () => {
  await withPatterns(['tmp/**'], () => {
    assert.equal(syncRules.isPathIgnored(V, 'tmp/inner/n.txt'), true);
    assert.equal(syncRules.isPathIgnored(V, 'tmp2/x.md'), false);
  });
});
