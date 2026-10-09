import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdmin } from '../behavior_pack/scripts/core/admincmd.js';

test('admin words', () => {
  assert.deepEqual(parseAdmin([]), { action: 'status' });
  assert.deepEqual(parseAdmin(['status']), { action: 'status' });
  assert.deepEqual(parseAdmin(['run', 'time', 'set', 'night']), { action: 'console', command: 'time set night' });
  assert.deepEqual(parseAdmin(['chain', 'Saddled', 'horse']), { action: 'chain', name: 'Saddled horse' });
  assert.deepEqual(parseAdmin(['backup', 'before', 'nether']), { action: 'backup', label: 'before nether' });
  assert.deepEqual(parseAdmin(['chains']), { action: 'chains' });
  assert.ok(parseAdmin(['run']).error);
  assert.ok(parseAdmin(['wat']).error);
});
