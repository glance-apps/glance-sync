import { describe, it, expect } from 'vitest';
import { canonicalJson, describeSliceDiff, sliceDiffs, explainSnapshotMerge, mergeSyncData as packageMerge } from '../src/index.js';

// The slice comparison the snapshot-file cycle decides writes and applies with,
// moved from dayGLANCE with its tests. The real-merge cases run over this
// package's mergeSyncData; dayGLANCE's wrapper adds `deviceLocalKeys` to the
// result, so that one is a fake here. The health strip is dayGLANCE's, so it is
// a fake here too.
const mergeSyncData = (local, remote, retentionDays) => packageMerge(local, remote, retentionDays);
const stripHealthSourcedLogs = (payload, habits) => {
  const ids = new Set(habits.filter((h) => typeof h.source === 'string' && h.source.startsWith('health')).map((h) => String(h.id)));
  const habitLogs = {};
  for (const [d, e] of Object.entries(payload.data.habitLogs ?? {})) {
    habitLogs[d] = Object.fromEntries(Object.entries(e).filter(([id]) => !ids.has(String(id))));
  }
  return { ...payload, data: { ...payload.data, habitLogs } };
};

const task = (id, over = {}) => ({
  id, title: `t${id}`, date: '2026-10-05', completed: false, notes: '', subtasks: [],
  lastModified: '2026-10-01T00:00:00.000Z', ...over,
});

describe('canonicalJson', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('describeSliceDiff', () => {
  it('reports nothing for equal content', () => {
    expect(describeSliceDiff('tasks', [task(1), task(2)], [task(2), task(1)].reverse())).toBeNull();
    expect(describeSliceDiff('x', { a: 1 }, { a: 1 })).toBeNull();
    expect(describeSliceDiff('x', undefined, undefined)).toBeNull();
  });

  it('matches id collections by id and names the changed ids', () => {
    const d = describeSliceDiff('tasks', [task(1, { title: 'new' }), task(2), task(3)], [task(1), task(2), task(4)]);
    expect(d.kind).toBe('items');
    expect(d.summary).toBe('tasks: 1 changed (1: title), +1 only in result (3), -1 only on other side (4)');
  });

  it('reports a pure reorder as order, not as items', () => {
    const d = describeSliceDiff('tasks', [task(1), task(2)], [task(2), task(1)]);
    expect(d).toEqual({ key: 'tasks', kind: 'order', summary: 'tasks: order differs' });
  });

  it('does set arithmetic on scalar lists and spots duplicates', () => {
    expect(describeSliceDiff('completedTaskUids', ['a', 'b', 'c'], ['b', 'd']).summary).toBe('completedTaskUids: +2 / -1');
    expect(describeSliceDiff('completedTaskUids', ['a', 'a'], ['a']).kind).toBe('duplicates');
    expect(describeSliceDiff('completedTaskUids', ['a'], ['a'])).toBeNull();
  });

  it('counts differing entries in a map and flags added or dropped slices', () => {
    expect(describeSliceDiff('habitLogs', { d1: 1, d2: 2 }, { d1: 1, d2: 3, d3: 1 }).summary).toBe('habitLogs: 2 of 3 entries differ');
    expect(describeSliceDiff('areas', [{ id: 'a' }], undefined).kind).toBe('added');
    expect(describeSliceDiff('areas', undefined, [{ id: 'a' }]).kind).toBe('dropped');
    expect(describeSliceDiff('syncUrl', 'a', 'b').kind).toBe('value');
  });

  it('ignores the per-merge tombstone fence and treats absent and empty slices alike', () => {
    expect(describeSliceDiff('tombstonePrunedBefore', '2026-08-01T00:00:00.000Z', '2026-08-06T00:00:00.000Z')).toBeNull();
    expect(describeSliceDiff('routineCompletionTimestamps', {}, undefined)).toBeNull();
    // …and inside a map: a day the strip emptied equals a day the file never had.
    expect(describeSliceDiff('habitLogs', { '2026-10-01': {}, '2026-10-02': { water: 1 } }, { '2026-10-02': { water: 1 } })).toBeNull();
    expect(describeSliceDiff('habitLogs', { '2026-10-01': { steps: 1 } }, {})).not.toBeNull();
    expect(describeSliceDiff('areas', [], null)).toBeNull();
  });
});

describe('describeSliceDiff names the fields of a changed row', () => {
  it('lists up to four differing fields per changed id', () => {
    const d = describeSliceDiff('habits', [{ id: 'h', name: 'Steps', lastModified: 'x', lastAutoSync: { a: 1 } }], [{ id: 'h', name: 'Steps', lastModified: 'x', lastAutoSync: { a: 2 } }]);
    expect(d.summary).toBe('habits: 1 changed (h: lastAutoSync)');
    const many = describeSliceDiff('tasks', [{ id: 1, a: 1, b: 1, c: 1, d: 1, e: 1 }], [{ id: 1, a: 2, b: 2, c: 2, d: 2, e: 2 }]);
    expect(many.summary).toBe('tasks: 1 changed (1: a, b, c, d, …)');
  });
});

describe('sliceDiffs', () => {
  it('lists every differing slice, and can ignore slices the first side does not carry', () => {
    const a = { tasks: [task(1)], habitLogs: { d: { h: 1 } } };
    const b = { tasks: [task(1)], habitLogs: { d: { h: 2 } }, weatherZip: '60601' };
    expect(sliceDiffs(a, b).map((d) => d.key)).toEqual(['habitLogs', 'weatherZip']);
    expect(sliceDiffs(a, b, { ignoreDropped: true }).map((d) => d.key)).toEqual(['habitLogs']);
  });

  it('leaves out the keys it is told to', () => {
    const a = { tasks: [task(1)], use24HourClock: true, minimizedSections: { a: 1 } };
    const b = { tasks: [task(1)], use24HourClock: false, minimizedSections: { a: 0 } };
    expect(sliceDiffs(a, b).map((d) => d.key)).toEqual(['minimizedSections', 'use24HourClock']);
    expect(sliceDiffs(a, b, { ignoreKeys: ['use24HourClock', 'minimizedSections'] })).toEqual([]);
  });
});

describe('explainSnapshotMerge with the real merge', () => {
  // A payload as a device that has synced before holds it: run the merge over a
  // minimal payload once so every default slice the merge fills in is present,
  // the way it is in any file this app has already written.
  const settle = (data) => mergeSyncData(data, data, 90).data;
  const base = () => settle({
    tasks: [task(1), task(2)],
    unscheduledTasks: [],
    recycleBin: [],
    completedTaskUids: [],
    habits: [],
    habitLogs: {},
    dailyNotes: {},
  });

  it('an identical file and device raise no flags, show no diffs, and decide nothing', () => {
    const r = explainSnapshotMerge({ local: base(), remote: base(), retentionDays: 90, merge: mergeSyncData });
    expect(r.error).toBeNull();
    expect(r.fileDiffs).toEqual([]);
    expect(r.deviceDiffs).toEqual([]);
    expect(r).toMatchObject({ remoteChanged: false, wouldWrite: false, wouldApply: false, flagWithoutDiff: false });
  });

  it('a local edit newer than the file is a write, named by slice and id', () => {
    const local = base();
    local.tasks[0] = task(1, { title: 'renamed', lastModified: '2026-10-05T01:00:00.000Z' });
    const r = explainSnapshotMerge({ local, remote: base(), retentionDays: 90, merge: mergeSyncData });
    expect(r.remoteChanged).toBe(true);
    expect(r.wouldWrite).toBe(true);
    expect(r.fileDiffs.map((d) => d.summary)).toContain('tasks: 1 changed (1: lastModified, title)');
    expect(r.wouldApply).toBe(false);
  });

  it('a file edit newer than the device is an apply, not a write', () => {
    const remote = base();
    remote.tasks[1] = task(2, { title: 'from file', lastModified: '2026-10-05T01:00:00.000Z' });
    const r = explainSnapshotMerge({ local: base(), remote, retentionDays: 90, merge: mergeSyncData });
    expect(r.localChanged).toBe(true);
    expect(r.wouldApply).toBe(true);
    expect(r.deviceDiffs.map((d) => d.summary)).toContain('tasks: 1 changed (2: lastModified, title)');
    expect(r.wouldWrite).toBe(false);
    // An apply flag WITH a device difference is not a flag without one.
    expect(r).toMatchObject({ writeFlagWithoutDiff: false, applyFlagWithoutDiff: false, flagWithoutDiff: false });
  });

  it('names the flag that fired without a difference: write, apply, or both (the 2026-10-08 Mac report)', () => {
    const b = base();
    const only = (over) => explainSnapshotMerge({ local: b, remote: b, retentionDays: 90, merge: (l) => ({ data: l, ...over }) });
    expect(only({ localChanged: true, remoteChanged: false })).toMatchObject({ writeFlagWithoutDiff: false, applyFlagWithoutDiff: true, flagWithoutDiff: true });
    expect(only({ localChanged: false, remoteChanged: true })).toMatchObject({ writeFlagWithoutDiff: true, applyFlagWithoutDiff: false, flagWithoutDiff: true });
    expect(only({ localChanged: true, remoteChanged: true })).toMatchObject({ writeFlagWithoutDiff: true, applyFlagWithoutDiff: true, flagWithoutDiff: true });
    expect(only({ localChanged: false, remoteChanged: false })).toMatchObject({ writeFlagWithoutDiff: false, applyFlagWithoutDiff: false, flagWithoutDiff: false });
  });

  it('the 2026-10-05 case: health counts the file never carries flag a write that would change nothing', () => {
    // A Mac holding HealthKit-derived counts (arrived through GLANCEvault) and
    // the iCloud file, which the strip keeps free of them. The merge flags a
    // write on every cycle; the stripped outgoing data equals the file.
    const habits = [{ id: 'steps', name: 'Steps', source: 'healthKit', target: 10000 }, { id: 'water', name: 'Water', target: 8 }];
    const local = settle({
      ...base(), habits,
      habitLogs: { '2026-10-01': { steps: 8000, water: 3 }, '2026-10-02': { steps: 9000, water: 2 } },
    });
    const file = settle({
      ...base(), habits,
      habitLogs: { '2026-10-01': { water: 3 }, '2026-10-02': { water: 2 } },
    });
    const strip = (data) => stripHealthSourcedLogs({ data }, data.habits).data;
    // dayGLANCE's merge wrapper keeps the device's counts in its result and
    // flags the file as changed (the counts it lacks); the package merge
    // folds habit logs by timestamp, so the wrapper's answer is faked here.
    const mergeSyncData = (l) => ({ data: l, localChanged: false, remoteChanged: true });

    const r = explainSnapshotMerge({ local, remote: file, retentionDays: 90, merge: mergeSyncData, outgoing: strip });
    expect(r.remoteChanged).toBe(true);           // the merge still says so
    expect(r.fileDiffs).toEqual([]);              // but nothing would change
    expect(r.wouldWrite).toBe(false);
    expect(r.flagWithoutDiff).toBe(true);
    expect(r.writeFlagWithoutDiff).toBe(true);

    // Without the strip the same inputs would be a real write: the guard is the strip-aware comparison.
    const unstripped = explainSnapshotMerge({ local, remote: file, retentionDays: 90, merge: mergeSyncData });
    expect(unstripped.wouldWrite).toBe(true);
    expect(unstripped.fileDiffs.map((d) => d.key)).toContain('habitLogs');
  });

  it('the 2026-10-09 case: device-local keys the merge names are not a write (the iPhone over iCloud)', () => {
    // Each device keeps its own use24HourClock, minimizedSections and
    // obsidianConfig; the file holds whichever device wrote last. The real
    // merge names them (deviceLocalKeys), and they are left out of the file
    // question entirely.
    const local = { ...base(), use24HourClock: true, minimizedSections: { inbox: true }, obsidianConfig: { vault: 'phone' }, obsidianConfigUpdatedAt: '2026-10-09T00:00:00.000Z' };
    const remote = { ...base(), use24HourClock: false, minimizedSections: { inbox: false }, obsidianConfig: { vault: 'mac' }, obsidianConfigUpdatedAt: '2026-10-08T00:00:00.000Z' };
    // An app's merge wrapper names its device-local keys in the result (dayGLANCE does).
    const naming = (l) => ({ data: l, localChanged: false, remoteChanged: true, deviceLocalKeys: ['use24HourClock', 'minimizedSections', 'obsidianConfig', 'obsidianConfigUpdatedAt'] });
    const r = explainSnapshotMerge({ local, remote, retentionDays: 90, merge: naming });
    expect(r.fileDiffs).toEqual([]);
    expect(r.wouldWrite).toBe(false);
    // A merge that does not name them (a stub, an older wrapper) still reports them.
    const plain = explainSnapshotMerge({ local, remote, retentionDays: 90, merge: (l) => ({ data: l, localChanged: false, remoteChanged: true }) });
    expect(plain.fileDiffs.map((d) => d.key)).toEqual(['minimizedSections', 'obsidianConfig', 'obsidianConfigUpdatedAt', 'use24HourClock']);
    expect(plain.wouldWrite).toBe(true);
  });

  it('guard: an order-only difference is reported but does not start a write', () => {
    // The merge keeps each device's own order, so a write would not change
    // the other device's order; two devices ordering todayRoutines
    // differently rewrote the file in turn (2026-10-05).
    const local = { ...base(), todayRoutines: [{ id: 'r1', lastModified: '2026-10-01T00:00:00.000Z' }, { id: 'r2', lastModified: '2026-10-01T00:00:00.000Z' }] };
    const remote = { ...base(), todayRoutines: [...local.todayRoutines].reverse() };
    // A merge that keeps local order and flags the difference as a write.
    const merge = (l) => ({ data: l, localChanged: false, remoteChanged: true });
    const r = explainSnapshotMerge({ local, remote, retentionDays: 90, merge });
    expect(r.fileDiffs.map((d) => d.kind)).toEqual(['order']);
    expect(r.wouldWrite).toBe(false);
    expect(r.flagWithoutDiff).toBe(true);
  });

  it('a flag raised with no difference decides nothing, on both sides', () => {
    const merge = (local) => ({ data: local, localChanged: true, remoteChanged: true });
    const r = explainSnapshotMerge({ local: base(), remote: base(), retentionDays: 90, merge });
    expect(r).toMatchObject({ remoteChanged: true, localChanged: true, wouldWrite: false, wouldApply: false, flagWithoutDiff: true, writeFlagWithoutDiff: true, applyFlagWithoutDiff: true });
  });

  it('slices the merge output does not carry do not count as an apply', () => {
    const local = { ...base(), weatherZip: '60601', multiUserEnabled: true };
    const merge = () => ({ data: base(), localChanged: true, remoteChanged: false });
    const r = explainSnapshotMerge({ local, remote: base(), retentionDays: 90, merge });
    expect(r.deviceDiffs).toEqual([]);
    expect(r.wouldApply).toBe(false);
  });

  it('a merge or an outgoing transform that throws is reported, not thrown', () => {
    expect(explainSnapshotMerge({ local: {}, remote: {}, retentionDays: 90, merge: () => { throw new Error('boom'); } }).error).toBe('boom');
    const r = explainSnapshotMerge({ local: {}, remote: {}, retentionDays: 90, merge: () => ({ data: {} }), outgoing: () => { throw new Error('strip'); } });
    expect(r.error).toBe('strip');
  });
});
