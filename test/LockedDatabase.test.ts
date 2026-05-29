import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { sqljsHelpers } from '../src/sqljsHelpers';
import { LockedDatabase } from '../src/LockedDatabase';

let db: Database;
let lockedDb: LockedDatabase;

beforeEach(async () => {
  const sqlJsStatic = await initSqlJs();
  db = new sqlJsStatic.Database();
  lockedDb = new LockedDatabase(db, () => {});
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT);');
});

describe('LockedDatabase', () => {
  it('txn commits on success', () => {
    lockedDb.txn('insert', txnId => {
      lockedDb.run(txnId, "INSERT INTO items VALUES ('1', 'test');");
    });
    const result = sqljsHelpers.query<{ id: string; name: string }>(db, 'SELECT * FROM items');
    expect(result).toEqual([{ id: '1', name: 'test' }]);
  });

  it('txn rolls back on error', () => {
    expect(() => {
      lockedDb.txn('fail', txnId => {
        lockedDb.run(txnId, "INSERT INTO items VALUES ('1', 'test');");
        throw new Error('oops');
      });
    }).toThrow('oops');
    const result = sqljsHelpers.query(db, 'SELECT * FROM items');
    expect(result).toEqual([]);
  });

  it('txnAsync commits on success', async () => {
    await lockedDb.txnAsync('insert', async txnId => {
      lockedDb.run(txnId, "INSERT INTO items VALUES ('1', 'async');");
    });
    const result = sqljsHelpers.query<{ id: string; name: string }>(db, 'SELECT * FROM items');
    expect(result).toEqual([{ id: '1', name: 'async' }]);
  });

  it('txnAsync rolls back on error', async () => {
    await expect(
      lockedDb.txnAsync('fail', async txnId => {
        lockedDb.run(txnId, "INSERT INTO items VALUES ('1', 'test');");
        throw new Error('async oops');
      })
    ).rejects.toThrow('async oops');
    const result = sqljsHelpers.query(db, 'SELECT * FROM items');
    expect(result).toEqual([]);
  });

  it('txnAsync serializes concurrent transactions', async () => {
    const order: number[] = [];
    const p1 = lockedDb.txnAsync('first', async txnId => {
      await new Promise(r => setTimeout(r, 20));
      lockedDb.run(txnId, "INSERT INTO items VALUES ('1', 'first');");
      order.push(1);
    });
    const p2 = lockedDb.txnAsync('second', async txnId => {
      lockedDb.run(txnId, "INSERT INTO items VALUES ('2', 'second');");
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
    const result = sqljsHelpers.query(db, 'SELECT * FROM items ORDER BY id');
    expect(result).toHaveLength(2);
  });
});
