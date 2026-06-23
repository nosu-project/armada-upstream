import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NostrEvent } from '@nostrify/nostrify';

import { NIndexedDBStore } from './NIndexedDBStore';

// Each test gets a fresh, uniquely-named database so there's no cross-test
// state. fake-indexeddb (loaded in src/test/setup.ts) provides the IndexedDB
// implementation under jsdom.

let store: NIndexedDBStore;
let counter = 0;
const openedDbNames: string[] = [];

async function freshStore(): Promise<NIndexedDBStore> {
  const name = `test-events-${Date.now()}-${counter++}`;
  openedDbNames.push(name);
  return NIndexedDBStore.open({ name });
}

beforeEach(async () => {
  openedDbNames.length = 0;
  store = await freshStore();
});

afterEach(async () => {
  for (const name of openedDbNames) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
});

const PK1 = 'a'.repeat(64);
const PK2 = 'b'.repeat(64);

/** Build a minimal valid-shaped event. */
function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const id = overrides.id ?? `${'0'.repeat(63)}${(counter++ % 16).toString(16)}`;
  return {
    id,
    pubkey: PK1,
    created_at: 1000,
    kind: 1,
    tags: [],
    content: '',
    sig: 'f'.repeat(128),
    ...overrides,
  };
}

/** Insert events and return once they've been flushed. */
async function add(...events: NostrEvent[]): Promise<void> {
  await Promise.all(events.map((e) => store.event(e)));
}

describe('NIndexedDBStore', () => {
  describe('ids filter', () => {
    it('returns events by exact id', async () => {
      const a = makeEvent({ id: '1'.repeat(64) });
      const b = makeEvent({ id: '2'.repeat(64) });
      await add(a, b);

      const result = await store.query([{ ids: [a.id] }]);
      expect(result.map((e) => e.id)).toEqual([a.id]);
    });

    it('returns nothing for an empty ids array', async () => {
      await add(makeEvent({ id: '1'.repeat(64) }));
      expect(await store.query([{ ids: [] }])).toEqual([]);
    });
  });

  describe('tag filter (the chat-persistence path)', () => {
    it('returns events by single-letter tag value', async () => {
      const inGroup = makeEvent({
        id: '1'.repeat(64),
        kind: 9,
        tags: [['h', 'group-a']],
      });
      const otherGroup = makeEvent({
        id: '2'.repeat(64),
        kind: 9,
        tags: [['h', 'group-b']],
      });
      await add(inGroup, otherGroup);

      const result = await store.query([{ kinds: [9], '#h': ['group-a'] }]);
      expect(result.map((e) => e.id)).toEqual([inGroup.id]);
    });

    it('matches any of several tag values', async () => {
      const a = makeEvent({ id: '1'.repeat(64), kind: 3300, tags: [['z', 'zzz1']] });
      const b = makeEvent({ id: '2'.repeat(64), kind: 3300, tags: [['z', 'zzz2']] });
      const c = makeEvent({ id: '3'.repeat(64), kind: 3300, tags: [['z', 'zzz3']] });
      await add(a, b, c);

      const result = await store.query([{ kinds: [3300], '#z': ['zzz1', 'zzz3'] }]);
      expect(result.map((e) => e.id).sort()).toEqual([a.id, c.id].sort());
    });

    it('returns nothing for a tag value never stored', async () => {
      await add(makeEvent({ id: '1'.repeat(64), kind: 9, tags: [['h', 'group-a']] }));
      expect(await store.query([{ kinds: [9], '#h': ['nope'] }])).toEqual([]);
    });

    it('returns DM events by #p tag', async () => {
      const dm = makeEvent({
        id: '1'.repeat(64),
        kind: 4,
        pubkey: PK2,
        tags: [['p', PK1]],
      });
      await add(dm);

      const result = await store.query([{ kinds: [4], '#p': [PK1] }]);
      expect(result.map((e) => e.id)).toEqual([dm.id]);
    });
  });

  describe('authors / kinds / time', () => {
    it('filters by author and kind', async () => {
      const mine = makeEvent({ id: '1'.repeat(64), pubkey: PK1, kind: 9 });
      const theirs = makeEvent({ id: '2'.repeat(64), pubkey: PK2, kind: 9 });
      await add(mine, theirs);

      const result = await store.query([{ kinds: [9], authors: [PK1] }]);
      expect(result.map((e) => e.id)).toEqual([mine.id]);
    });

    it('respects since/until and sorts newest-first', async () => {
      const old = makeEvent({ id: '1'.repeat(64), kind: 9, created_at: 100 });
      const mid = makeEvent({ id: '2'.repeat(64), kind: 9, created_at: 200 });
      const recent = makeEvent({ id: '3'.repeat(64), kind: 9, created_at: 300 });
      await add(old, mid, recent);

      const result = await store.query([{ kinds: [9], since: 150, until: 300 }]);
      expect(result.map((e) => e.created_at)).toEqual([300, 200]);
    });

    it('respects limit', async () => {
      await add(
        makeEvent({ id: '1'.repeat(64), kind: 9, created_at: 100 }),
        makeEvent({ id: '2'.repeat(64), kind: 9, created_at: 200 }),
        makeEvent({ id: '3'.repeat(64), kind: 9, created_at: 300 }),
      );
      const result = await store.query([{ kinds: [9], limit: 2 }]);
      expect(result.map((e) => e.created_at)).toEqual([300, 200]);
    });
  });

  describe('replaceable supersession', () => {
    it('keeps only the newest version of a replaceable event', async () => {
      const oldProfile = makeEvent({ id: '1'.repeat(64), kind: 0, created_at: 100 });
      const newProfile = makeEvent({ id: '2'.repeat(64), kind: 0, created_at: 200 });
      await add(oldProfile);
      await add(newProfile);

      const result = await store.query([{ kinds: [0], authors: [PK1] }]);
      expect(result.map((e) => e.id)).toEqual([newProfile.id]);
    });
  });

  describe('NIP-09 deletion', () => {
    it('removes an event the author deleted', async () => {
      const note = makeEvent({ id: '1'.repeat(64), pubkey: PK1, kind: 1 });
      await add(note);

      const del = makeEvent({
        id: '2'.repeat(64),
        pubkey: PK1,
        kind: 5,
        created_at: 2000,
        tags: [['e', note.id]],
      });
      await add(del);

      expect(await store.query([{ ids: [note.id] }])).toEqual([]);
    });

    it('does not let a non-author delete an event', async () => {
      const note = makeEvent({ id: '1'.repeat(64), pubkey: PK1, kind: 1 });
      await add(note);

      const del = makeEvent({
        id: '2'.repeat(64),
        pubkey: PK2, // someone else
        kind: 5,
        created_at: 2000,
        tags: [['e', note.id]],
      });
      await add(del);

      expect((await store.query([{ ids: [note.id] }])).map((e) => e.id)).toEqual([note.id]);
    });
  });

  describe('ephemeral', () => {
    it('never stores ephemeral events', async () => {
      const typing = makeEvent({ id: '1'.repeat(64), kind: 20000 });
      await add(typing);
      expect(await store.query([{ ids: [typing.id] }])).toEqual([]);
    });
  });
});
