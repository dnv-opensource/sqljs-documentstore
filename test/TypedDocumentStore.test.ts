import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { LockedDatabase } from '../src/LockedDatabase';
import { TypedDocumentStore } from '../src/TypedDocumentStore';

interface TestDoc {
  id: string;
  name: string;
  age: number;
}

let db: Database;
let lockedDb: LockedDatabase;
let store: TypedDocumentStore<TestDoc, { name: (x: TestDoc) => string }>;

beforeEach(async () => {
  const sqlJsStatic = await initSqlJs();
  db = new sqlJsStatic.Database();
  lockedDb = new LockedDatabase(db, () => {});
  store = new TypedDocumentStore<TestDoc, { name: (x: TestDoc) => string }>(
    () => lockedDb,
    'TestDocs',
    {} as TestDoc,
    { name: x => x.name }
  );
  await store.init();
});

describe('TypedDocumentStore', () => {
  it('set and get a document', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
    });
    const doc = await store.get('1');
    expect(doc).toEqual({ id: '1', name: 'Alice', age: 30 });
  });

  it('tryGet returns undefined for missing', async () => {
    const doc = await store.tryGet('nope');
    expect(doc).toBeUndefined();
  });

  it('getAll returns all documents', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
      await store.set(txnId, { id: '2', name: 'Bob', age: 25 });
    });
    const all = await store.getAll();
    expect(all).toHaveLength(2);
  });

  it('query by indexed column', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
      await store.set(txnId, { id: '2', name: 'Bob', age: 25 });
    });
    const results = await store.query(x => `where ${x.name} = ?`, ['Bob']);
    expect(results).toEqual([{ id: '2', name: 'Bob', age: 25 }]);
  });

  it('update modifies existing document', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
    });
    await lockedDb.txnAsync('update', async txnId => {
      await store.update(txnId, '1', doc => { doc.name = 'Alice Updated'; });
    });
    const doc = await store.get('1');
    expect(doc.name).toBe('Alice Updated');
  });

  it('remove deletes a document', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
    });
    await lockedDb.txnAsync('remove', async txnId => {
      await store.remove(txnId, '1');
    });
    const doc = await store.tryGet('1');
    expect(doc).toBeUndefined();
  });

  it('count returns correct number', async () => {
    await lockedDb.txnAsync('set', async txnId => {
      await store.set(txnId, { id: '1', name: 'Alice', age: 30 });
      await store.set(txnId, { id: '2', name: 'Bob', age: 25 });
    });
    expect(await store.count()).toBe(2);
  });
});
