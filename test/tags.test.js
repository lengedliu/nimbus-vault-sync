const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/storage');
const vaults = require('../src/vaults');
const users = require('../src/users');

test('Tags: getVaultTags 能够正确提取 Markdown 笔记中的 frontmatter 与正文行内标签', async () => {
  const user = await users.createUser('tag_tester_' + Date.now(), 'pass1234');
  const vault = await vaults.create(user.id, 'Tag Test Vault');
  const vaultId = vault.id;

  const note1 = `---
tags: [architecture, backend, obsidian]
---
# Note 1
This is a note with #work and #project/2026 tags.
Also another #work mention.
`;

  const note2 = `# Note 2
Simple note with #idea and #work.
And some code #fff hex which should NOT be a tag.
`;

  storage.writeFile(vaultId, 'folder/note1.md', Buffer.from(note1, 'utf8'));
  storage.writeFile(vaultId, 'note2.md', Buffer.from(note2, 'utf8'));

  const tags = storage.getVaultTags(vaultId);
  assert.ok(Array.isArray(tags));

  const tagMap = new Map(tags.map((t) => [t.tag, t]));

  // Verify tags and counts
  assert.strictEqual(tagMap.get('work')?.count, 2);
  assert.strictEqual(tagMap.get('architecture')?.count, 1);
  assert.strictEqual(tagMap.get('backend')?.count, 1);
  assert.strictEqual(tagMap.get('project/2026')?.count, 1);
  assert.strictEqual(tagMap.get('idea')?.count, 1);

  // Clean up
  storage.deleteVaultDirectory(vaultId);
});
