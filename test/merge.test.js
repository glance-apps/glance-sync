import { describe, it, expect } from 'vitest';
import { mergeArrayById, mergeDailyNotes, mergeHabits, mergeHabitLogs, mergeRoutineDefinitions, mergeSyncData, pruneTombstones } from '../src/index.js';

// Helpers for building test fixtures
const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
// Item with default timestampField='updatedAt' (generic form)
const I = (id, label, updatedAt, extra = {}) => ({ id, label, updatedAt, ...extra });
// Task-shaped item (uses lastModified) for mergeSyncData tests
const T = (id, title, lastModified, extra = {}) => ({ id, title, lastModified, ...extra });

// ─── mergeArrayById — §2.3 required cases ────────────────────────────────────

describe('mergeArrayById', () => {
  // Case 1: New item on remote → added to result
  it('adds remote-only item to result and flags localChanged', () => {
    const local = [];
    const remote = [I('a', 'Remote item', ts(5))];
    const { merged, localChanged, remoteChanged } = mergeArrayById(local, remote, {});
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('a');
    expect(localChanged).toBe(true);
    expect(remoteChanged).toBe(false);
  });

  // Case 2: Deleted item (tombstoned) → excluded from result
  it('excludes a local item that has a newer tombstone', () => {
    const local = [I('x', 'Delete me', ts(30))];
    const deleted = { x: ts(5) }; // tombstone is more recent than the item
    const { merged, localChanged } = mergeArrayById(local, [], deleted);
    expect(merged).toHaveLength(0);
    expect(localChanged).toBe(true);
  });

  it('excludes a remote item that has a newer tombstone', () => {
    const remote = [I('x', 'Delete me', ts(30))];
    const deleted = { x: ts(5) }; // tombstone is more recent than the item
    const { merged, remoteChanged } = mergeArrayById([], remote, deleted);
    expect(merged).toHaveLength(0);
    expect(remoteChanged).toBe(true);
  });

  // Case 3: Conflict — remote wins when updatedAt is later
  it('picks remote when remote updatedAt is newer', () => {
    const local  = [I('1', 'Old', ts(20))];
    const remote = [I('1', 'New', ts(2))];
    const { merged, localChanged } = mergeArrayById(local, remote, {});
    expect(merged[0].label).toBe('New');
    expect(localChanged).toBe(true);
  });

  // Case 4: Conflict — local wins when updatedAt is later
  it('picks local when local updatedAt is newer', () => {
    const local  = [I('1', 'Newer local', ts(2))];
    const remote = [I('1', 'Older remote', ts(20))];
    const { merged, remoteChanged } = mergeArrayById(local, remote, {});
    expect(merged[0].label).toBe('Newer local');
    expect(remoteChanged).toBe(true);
  });

  // Case 5: Tombstone beat by later modification → item survives
  it('keeps item when its updatedAt is newer than the tombstone', () => {
    const local = [I('r', 'Resurrected', ts(2))];
    const deleted = { r: ts(20) }; // tombstone is OLDER than the item — item wins
    const { merged } = mergeArrayById(local, [], deleted);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('r');
  });

  // Case 6: Custom idField and timestampField options
  it('merges using a custom idField (uuid) and timestampField (modifiedAt)', () => {
    const local  = [{ uuid: 'aa', name: 'Local',  modifiedAt: ts(10) }];
    const remote = [{ uuid: 'aa', name: 'Remote', modifiedAt: ts(1)  }];
    const { merged } = mergeArrayById(local, remote, {}, null, { idField: 'uuid', timestampField: 'modifiedAt' });
    expect(merged[0].name).toBe('Remote'); // remote is newer
  });

  it('tombstone lookup uses custom idField', () => {
    const local  = [{ uuid: 'bb', name: 'To delete', modifiedAt: ts(30) }];
    const deleted = { bb: ts(5) };
    const { merged } = mergeArrayById(local, [], deleted, null, { idField: 'uuid', timestampField: 'modifiedAt' });
    expect(merged).toHaveLength(0);
  });

  // Additional correctness checks
  it('keeps local-only item and flags remoteChanged', () => {
    const local = [I('z', 'Local only', ts(5))];
    const { merged, localChanged, remoteChanged } = mergeArrayById(local, [], {});
    expect(merged).toHaveLength(1);
    expect(localChanged).toBe(false);
    expect(remoteChanged).toBe(true);
  });

  it('preserves local order and appends remote-only items at end', () => {
    const local  = [I('1', 'A', ts(10)), I('2', 'B', ts(8))];
    const remote = [I('3', 'C', ts(5)), I('1', 'A', ts(10))];
    const { merged } = mergeArrayById(local, remote, {});
    expect(merged.map(i => i.id)).toEqual(['1', '2', '3']);
  });

  it('returns stable empty result for two empty arrays', () => {
    const { merged, localChanged, remoteChanged } = mergeArrayById([], [], {});
    expect(merged).toEqual([]);
    expect(localChanged).toBe(false);
    expect(remoteChanged).toBe(false);
  });

  it('uses default idField=id and timestampField=updatedAt when options omitted', () => {
    const local  = [{ id: '5', updatedAt: ts(10), v: 'local'  }];
    const remote = [{ id: '5', updatedAt: ts(1),  v: 'remote' }];
    const { merged } = mergeArrayById(local, remote, {});
    expect(merged[0].v).toBe('remote');
  });
});

// ─── pruneTombstones — Case 7 ─────────────────────────────────────────────────

describe('pruneTombstones', () => {
  it('removes entries older than the cutoff', () => {
    const cutoff = new Date(Date.now() - 5 * 86400000); // 5 days ago
    const tombstones = {
      old: new Date(Date.now() - 10 * 86400000).toISOString(), // 10 days ago → pruned
      recent: new Date(Date.now() - 2 * 86400000).toISOString(), // 2 days ago → kept
    };
    const pruned = pruneTombstones(tombstones, cutoff);
    expect(pruned).not.toHaveProperty('old');
    expect(pruned).toHaveProperty('recent');
  });

  it('keeps entries exactly at the cutoff boundary', () => {
    const cutoff = new Date('2026-01-01T00:00:00.000Z');
    const tombstones = { edge: '2026-01-01T00:00:00.000Z' };
    expect(pruneTombstones(tombstones, cutoff)).toHaveProperty('edge');
  });

  it('returns all tombstones unchanged when cutoff is null', () => {
    const tombstones = { a: ts(999), b: ts(1) };
    expect(pruneTombstones(tombstones, null)).toEqual(tombstones);
  });

  it('returns empty object when all entries are older than cutoff', () => {
    const cutoff = new Date(); // now
    const tombstones = { x: ts(1) }; // 1 min ago is before "now" strictly? No, ts(1) = 1 min ago which is < now
    // Use a tombstone that is clearly in the past
    const old = { x: new Date(Date.now() - 1000).toISOString() };
    const pruned = pruneTombstones(old, cutoff);
    expect(Object.keys(pruned)).toHaveLength(0);
  });
});

// ─── mergeDailyNotes ──────────────────────────────────────────────────────────

describe('mergeDailyNotes', () => {
  it('keeps local-only note and flags remoteChanged', () => {
    const local  = { '2026-01-01': { text: 'hello', lastModified: ts(10) } };
    const { merged, remoteChanged } = mergeDailyNotes(local, {});
    expect(merged['2026-01-01'].text).toBe('hello');
    expect(remoteChanged).toBe(true);
  });

  it('adds remote-only note and flags localChanged', () => {
    const remote = { '2026-01-02': { text: 'world', lastModified: ts(10) } };
    const { merged, localChanged } = mergeDailyNotes({}, remote);
    expect(merged['2026-01-02'].text).toBe('world');
    expect(localChanged).toBe(true);
  });

  it('picks newer version when both sides have same date', () => {
    const local  = { '2026-01-03': { text: 'old', lastModified: ts(20) } };
    const remote = { '2026-01-03': { text: 'new', lastModified: ts(1)  } };
    const { merged } = mergeDailyNotes(local, remote);
    expect(merged['2026-01-03'].text).toBe('new');
  });

  it('propagates a deletion tombstone (deleted: true) from remote', () => {
    const local  = { '2026-01-04': { text: 'note', lastModified: ts(20) } };
    const remote = { '2026-01-04': { deleted: true, lastModified: ts(1) } };
    const { merged } = mergeDailyNotes(local, remote);
    expect(merged['2026-01-04'].deleted).toBe(true);
  });
});

// ─── mergeHabits ─────────────────────────────────────────────────────────────

describe('mergeHabits', () => {
  it('unions remote-only habits', () => {
    const remote = [{ id: 'h1', name: 'Run', createdAt: ts(10) }];
    const { merged, localChanged } = mergeHabits([], remote, {}, {});
    expect(merged).toHaveLength(1);
    expect(localChanged).toBe(true);
  });

  it('respects tombstones from either side', () => {
    const local  = [{ id: 'h2', name: 'Swim', createdAt: ts(30) }];
    const remote = [{ id: 'h2', name: 'Swim', createdAt: ts(30) }];
    const remoteDeleted = { h2: ts(5) };
    const { merged } = mergeHabits(local, remote, {}, remoteDeleted);
    expect(merged).toHaveLength(0);
  });

  it('propagates merged tombstone union to both sides', () => {
    const localDeleted  = { h3: ts(10) };
    const remoteDeleted = { h4: ts(5) };
    const { mergedDeletedIds } = mergeHabits([], [], localDeleted, remoteDeleted);
    expect(mergedDeletedIds).toHaveProperty('h3');
    expect(mergedDeletedIds).toHaveProperty('h4');
  });
});

// ─── mergeHabitLogs ───────────────────────────────────────────────────────────

describe('mergeHabitLogs', () => {
  it('unions logs from different dates', () => {
    const local  = { '2026-01-01': { h1: 2 } };
    const remote = { '2026-01-02': { h1: 1 } };
    const { merged } = mergeHabitLogs(local, remote);
    expect(merged['2026-01-01']).toBeDefined();
    expect(merged['2026-01-02']).toBeDefined();
  });

  it('uses Math.max for same-day counts when no timestamps present (legacy)', () => {
    const local  = { '2026-01-01': { h1: 3 } };
    const remote = { '2026-01-01': { h1: 5 } };
    const { merged } = mergeHabitLogs(local, remote);
    expect(merged['2026-01-01'].h1).toBe(5);
  });

  it('uses last-writer-wins when timestamps are present', () => {
    const localTs  = { '2026-01-01:h1': ts(10) };
    const remoteTs = { '2026-01-01:h1': ts(2)  }; // remote is newer
    const local  = { '2026-01-01': { h1: 3 } };
    const remote = { '2026-01-01': { h1: 1 } };
    const { merged } = mergeHabitLogs(local, remote, localTs, remoteTs);
    expect(merged['2026-01-01'].h1).toBe(1); // remote wins
  });
});

// ─── mergeRoutineDefinitions ──────────────────────────────────────────────────

describe('mergeRoutineDefinitions', () => {
  it('unions chips from both sides for the same bucket', () => {
    const local  = { mon: [{ id: 'c1', name: 'Morning stretch' }] };
    const remote = { mon: [{ id: 'c1', name: 'Morning stretch' }, { id: 'c2', name: 'Journal' }] };
    const { merged } = mergeRoutineDefinitions(local, remote);
    expect(merged.mon).toHaveLength(2);
  });

  it('suppresses chips that are tombstoned', () => {
    const local  = { tue: [{ id: 'c3', name: 'Yoga' }] };
    const remote = { tue: [] };
    const deleted = { c3: ts(1) }; // tombstoned recently
    const { merged } = mergeRoutineDefinitions(local, remote, deleted);
    expect(merged.tue).toHaveLength(0);
  });

  it('respects resurrection: chip modified after tombstone survives', () => {
    const chip = { id: 'c4', name: 'Revived', lastModified: ts(1) }; // modified 1 min ago
    const local  = { wed: [chip] };
    const remote = { wed: [] };
    const deleted = { c4: ts(10) }; // tombstoned 10 min ago — chip is newer, wins
    const { merged } = mergeRoutineDefinitions(local, remote, deleted);
    expect(merged.wed).toHaveLength(1);
  });

  it('on id collision, the newer remote chip wins (field-level last-write-wins)', () => {
    // Remote stamped an edit (e.g. ownerSyncId) onto an existing chip more recently.
    const local  = { thu: [{ id: 'c5', name: 'Run', lastModified: ts(10) }] };
    const remote = { thu: [{ id: 'c5', name: 'Run', ownerSyncId: 'jason', lastModified: ts(1) }] };
    const { merged, localChanged } = mergeRoutineDefinitions(local, remote);
    expect(merged.thu).toHaveLength(1);
    expect(merged.thu[0].ownerSyncId).toBe('jason');
    expect(localChanged).toBe(true);
  });

  it('on id collision, the newer local chip wins and remote is flagged', () => {
    const local  = { fri: [{ id: 'c6', name: 'Read (renamed)', lastModified: ts(1) }] };
    const remote = { fri: [{ id: 'c6', name: 'Read', lastModified: ts(10) }] };
    const { merged, remoteChanged } = mergeRoutineDefinitions(local, remote);
    expect(merged.fri).toHaveLength(1);
    expect(merged.fri[0].name).toBe('Read (renamed)');
    expect(remoteChanged).toBe(true);
  });
});

// ─── mergeSyncData (integration) ──────────────────────────────────────────────

describe('mergeSyncData', () => {
  const makePayload = (tasks = [], extra = {}) => ({
    tasks,
    unscheduledTasks: [],
    recycleBin: [],
    recurringTasks: [],
    dailyNotes: {},
    habits: [],
    habitLogs: {},
    routineDefinitions: {},
    todayRoutines: [],
    deletedTaskIds: {},
    ...extra,
  });

  it('merges tasks from both sides', () => {
    const local  = makePayload([T('1', 'Local task',  ts(5))]);
    const remote = makePayload([T('2', 'Remote task', ts(5))]);
    const { data } = mergeSyncData(local, remote);
    const ids = data.tasks.map(t => t.id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
  });

  it('respects task tombstones', () => {
    const local  = makePayload([T('del', 'Deleted', ts(30))], { deletedTaskIds: { del: ts(2) } });
    const remote = makePayload([T('del', 'Deleted', ts(30))]);
    const { data } = mergeSyncData(local, remote);
    expect(data.tasks.find(t => t.id === 'del')).toBeUndefined();
  });

  it('prunes tombstones older than retentionDays', () => {
    const oldTs = new Date(Date.now() - 200 * 86400000).toISOString(); // 200 days ago
    const local = makePayload([], { deletedTaskIds: { ancient: oldTs } });
    const { data } = mergeSyncData(local, makePayload(), 90);
    expect(data.deletedTaskIds).not.toHaveProperty('ancient');
  });

  it('picks newer task version on conflict', () => {
    const local  = makePayload([T('c', 'Old title',  ts(20))]);
    const remote = makePayload([T('c', 'New title',  ts(2))]);
    const { data } = mergeSyncData(local, remote);
    expect(data.tasks[0].title).toBe('New title');
  });
});
