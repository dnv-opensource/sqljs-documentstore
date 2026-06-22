import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { LockedDatabase, ILockedDatabase } from './LockedDatabase';
import { TypedDocumentStore } from './TypedDocumentStore';

interface CustomerData {
  id: string;
  name: string;
  orders: unknown[];
}

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQL = await initSqlJs();
});

function createLockedDatabase(): ILockedDatabase {
  const database: Database = new SQL.Database();
  return new LockedDatabase(database, () => {/* no-op flush for tests */});
}

describe('TypedDocumentStore', () => {
  it('constructs with default (empty) indexedFields', () => {
    const lockedDb = createLockedDatabase();
    const store = new TypedDocumentStore(() => lockedDb, 'CustomerData', <CustomerData>{});

    expect(store).toBeInstanceOf(TypedDocumentStore);
    expect(store.tableName).toBe('CustomerData');
    expect(store.indexedFields).toEqual({});
  });

  it('constructs with indexedFields and exposes the indexed columns', () => {
    const lockedDb = createLockedDatabase();
    const store = new TypedDocumentStore(() => lockedDb, 'CustomerData', <CustomerData>{}, {
      name: x => x.name,
      orderCount: x => x.orders?.length,
    });

    expect(store.indexedFields).toHaveProperty('name');
    expect(store.indexedFields).toHaveProperty('orderCount');
  });

  it('init, set and get a document round-trips through sql.js', async () => {
    const lockedDb = createLockedDatabase();
    const store = new TypedDocumentStore(() => lockedDb, 'CustomerData', <CustomerData>{}, {
      name: x => x.name,
      orderCount: x => x.orders?.length,
    });

    await store.init();

    const customer: CustomerData = { id: 'c1', name: 'Alice', orders: [1, 2, 3] };
    await lockedDb.txnAsync('insert customer', async txnId => store.set(txnId, customer));

    const fetched = await store.get('c1');
    expect(fetched).toEqual(customer);
    expect(await store.count()).toBe(1);
  });

  it('queries by an indexed column', async () => {
    const lockedDb = createLockedDatabase();
    const store = new TypedDocumentStore(() => lockedDb, 'CustomerData', <CustomerData>{}, {
      name: x => x.name,
    });

    await store.init();
    await lockedDb.txnAsync('seed', async txnId => store.setMany(txnId, [
      { id: 'c1', name: 'Alice', orders: [] },
      { id: 'c2', name: 'Bob', orders: [] },
    ]));

    const results = await store.query(x => `where ${x.name} = ?`, ['Bob']);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('c2');
  });

  it('should have an empty TIndex type if none supplied in constructor, and query should reflect this', async () => {
    const lockedDb = createLockedDatabase();
    const store = new TypedDocumentStore(() => lockedDb, 'CustomerData', <CustomerData>{});

    if (false) { //typechecking only
        //@ts-expect-error
        store.query(x => x.type, []); //'type' field not available, should be an error
    }

    type WhereSqlParam = Parameters<Parameters<typeof store.query>[0]>[0];
    expectTypeOf<WhereSqlParam>().toEqualTypeOf<Record<never, string>>();
    // toEqualTypeOf is permissive around the empty object type, so also assert the
    // keys collapse to `never` and the wide Record<string, string> form is rejected.
    expectTypeOf<keyof WhereSqlParam>().toEqualTypeOf<never>();
    expectTypeOf<WhereSqlParam>().not.toEqualTypeOf<Record<string, string>>();
  });
});
