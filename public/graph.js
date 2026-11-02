export function layoutCommits(commits) {
  const rows = commits.map((commit) => ({ ...commit, lane: 0, joins: [] }));
  const indexOf = new Map(rows.map((row, index) => [row.oid, index]));
  const active = [];
  for (const row of rows) {
    let lane = active.indexOf(row.oid);
    if (lane === -1) {
      lane = active.findIndex((value) => value == null);
      if (lane === -1) lane = active.length;
    }
    row.lane = lane;
    for (let i = 0; i < active.length; i += 1) {
      if (active[i] === row.oid) active[i] = null;
    }
    const parents = (row.parents || []).filter((parent) => indexOf.has(parent));
    active[lane] = parents[0] || null;
    for (let i = 1; i < parents.length; i += 1) {
      let parentLane = active.indexOf(parents[i]);
      if (parentLane === -1) {
        parentLane = active.findIndex((value) => value == null);
        if (parentLane === -1) parentLane = active.length;
        active[parentLane] = parents[i];
      }
      row.joins.push(parentLane);
    }
  }
  while (active.length && active[active.length - 1] == null) active.pop();
  return { rows, laneCount: Math.max(1, active.length) };
}
