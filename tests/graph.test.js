import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutCommits } from '../public/graph.js';

test('a commit that occupies two lanes frees the extra lane', () => {
  const { rows, laneCount } = layoutCommits([
    { oid: 'c1', parents: ['p'] },
    { oid: 'c2', parents: ['p'] },
    { oid: 'p', parents: [] },
  ]);
  assert.equal(rows.find((row) => row.oid === 'p').lane, 0);
  assert.equal(laneCount, 1);
});
