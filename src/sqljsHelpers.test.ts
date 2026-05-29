import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import { sqljsHelpers } from './sqljsHelpers';

let db: Database;

beforeEach(async () => {
  const sqlJsStatic = await initSqlJs();
  db = new sqlJsStatic.Database();
});

describe('sqljsHelpers', () => {
  it('query returns empty array for no results', () => {
    db.exec('CREATE TABLE test (id TEXT, value TEXT);');
    const result = sqljsHelpers.query(db, 'SELECT * FROM test');
    expect(result).toEqual([]);
  });

  it('query returns mapped rows', () => {
    db.exec('CREATE TABLE test (id TEXT, value INTEGER);');
    db.exec("INSERT INTO test VALUES ('a', 1), ('b', 2);");
    const result = sqljsHelpers.query<{ id: string; value: number }>(db, 'SELECT * FROM test');
    expect(result).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
  });

  it('query handles params', () => {
    db.exec('CREATE TABLE test (id TEXT, value INTEGER);');
    db.exec("INSERT INTO test VALUES ('a', 1), ('b', 2);");
    const result = sqljsHelpers.query<{ id: string; value: number }>(db, 'SELECT * FROM test WHERE value > ?', [1]);
    expect(result).toEqual([{ id: 'b', value: 2 }]);
  });

  it('sanitizeParams converts booleans and undefined', () => {
    expect(sqljsHelpers.sanitizeParams([true, false, undefined, null, 'hello', 42]))
      .toEqual([1, 0, null, null, 'hello', 42]);
  });

  it('isTable returns true/false correctly', () => {
    expect(sqljsHelpers.isTable(db, 'narp')).toBe(false);
    db.exec('CREATE TABLE yarp (id TEXT);');
    expect(sqljsHelpers.isTable(db, 'yarp')).toBe(true);
  });
});
