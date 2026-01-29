#!/usr/bin/env node
/**
 * Quick test for moltbot-memory-sqlite
 */

import { SqliteMemoryPlugin } from './dist/index.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/moltbot-memory-test.db';

async function test() {
  // Cleanup
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

  console.log('🧪 Testing moltbot-memory-sqlite\n');

  const memory = new SqliteMemoryPlugin({ dbPath: TEST_DB });
  await memory.init();

  // Test store
  console.log('1. Store memories...');
  memory.store({ text: 'User prefers dark mode', category: 'preference', importance: 0.9 });
  memory.store({ text: 'User lives in Switzerland', category: 'fact', importance: 0.8 });
  memory.store({ text: 'Decided to use TypeScript for the project', category: 'decision', importance: 0.7 });
  memory.store({ text: 'ok', category: 'conversation' }); // noise
  memory.store({ text: 'Meeting with Andre about Betty launch', category: 'conversation', importance: 0.85 });
  console.log('   ✅ Stored 5 memories\n');

  // Test stats
  console.log('2. Stats...');
  const stats = memory.stats();
  console.log(`   Total: ${stats.total}`);
  console.log(`   By category:`, stats.byCategory);
  console.log('   ✅ Stats working\n');

  // Test recall with query
  console.log('3. Recall "dark mode"...');
  const darkMode = memory.recall({ query: 'dark mode' });
  console.log(`   Found: ${darkMode.length} memories`);
  darkMode.forEach(m => console.log(`   - [${m.category}] ${m.text}`));
  console.log('   ✅ Recall working\n');

  // Test recall with category filter
  console.log('4. Recall preferences only...');
  const prefs = memory.recall({ query: '', category: 'preference', limit: 10 });
  console.log(`   Found: ${prefs.length} preferences`);
  prefs.forEach(m => console.log(`   - ${m.text}`));
  console.log('   ✅ Category filter working\n');

  // Test noise filtering
  console.log('5. Noise filtering...');
  const withNoise = memory.recall({ query: 'ok', filterNoise: false });
  const withoutNoise = memory.recall({ query: 'ok', filterNoise: true });
  console.log(`   Without filter: ${withNoise.length} results`);
  console.log(`   With filter: ${withoutNoise.length} results`);
  console.log('   ✅ Noise filtering working\n');

  // Test forget
  console.log('6. Forget by query...');
  const forgotten = memory.forget({ query: 'Switzerland' });
  console.log(`   Deleted: ${forgotten.deleted} memories`);
  const afterForget = memory.stats();
  console.log(`   Total now: ${afterForget.total}`);
  console.log('   ✅ Forget working\n');

  // Cleanup
  memory.close();
  unlinkSync(TEST_DB);

  console.log('═══════════════════════════════════');
  console.log('✅ All tests passed!');
  console.log('═══════════════════════════════════');
}

test().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
