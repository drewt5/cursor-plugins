import assert from 'node:assert/strict';
import test from 'node:test';

test('controlled hosted CI failure evidence probe', () => {
  assert.fail('PSTACK_CONTROLLED_FAILURE: verify the PR gate and diagnostic artifact');
});
