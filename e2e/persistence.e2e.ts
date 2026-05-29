import { test, expect } from '@playwright/test';

test.describe('sqljsPersistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('save and load round-trips data correctly', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { sqljsPersistence } = (window as any).sqljsLib;
      const dbName = 'test-roundtrip-' + Date.now();
      const passPhrase = 'test-passphrase';

      const mockSqlJs = {
        Database: class {
          data: Uint8Array;
          constructor(data?: Uint8Array) { this.data = data ?? new Uint8Array(0); }
          export() { return this.data; }
        }
      };

      const { key, salt } = await sqljsPersistence.load(dbName, passPhrase, mockSqlJs);

      const testData = new Uint8Array([1, 2, 3, 4, 5, 42, 99, 200]);
      await sqljsPersistence.save(dbName, key, salt, { export: () => testData });

      const { database: loaded } = await sqljsPersistence.load(dbName, passPhrase, mockSqlJs);
      return Array.from(loaded.data);
    });

    expect(result).toEqual([1, 2, 3, 4, 5, 42, 99, 200]);
  });

  test('load returns a new empty database for non-existent db', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { sqljsPersistence } = (window as any).sqljsLib;
      const mockSqlJs = {
        Database: class {
          data: Uint8Array;
          constructor(data?: Uint8Array) { this.data = data ?? new Uint8Array(0); }
          export() { return this.data; }
        }
      };

      const { database } = await sqljsPersistence.load('test-new-' + Date.now(), 'pw', mockSqlJs);
      return database.data.length;
    });

    expect(result).toBe(0);
  });

  test('save overwrites previous data', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { sqljsPersistence } = (window as any).sqljsLib;
      const dbName = 'test-overwrite-' + Date.now();
      const passPhrase = 'pw';
      const mockSqlJs = {
        Database: class {
          data: Uint8Array;
          constructor(data?: Uint8Array) { this.data = data ?? new Uint8Array(0); }
          export() { return this.data; }
        }
      };

      const { key, salt } = await sqljsPersistence.load(dbName, passPhrase, mockSqlJs);

      await sqljsPersistence.save(dbName, key, salt, { export: () => new Uint8Array([10, 20, 30]) });
      await sqljsPersistence.save(dbName, key, salt, { export: () => new Uint8Array([77, 88]) });

      const { database: loaded } = await sqljsPersistence.load(dbName, passPhrase, mockSqlJs);
      return Array.from(loaded.data);
    });

    expect(result).toEqual([77, 88]);
  });

  test('dbExists returns false for non-existent database', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { sqljsPersistence } = (window as any).sqljsLib;
      return sqljsPersistence.dbExists('test-noexist-' + Date.now());
    });

    expect(result).toBe(false);
  });

  test('dbExists returns true after save', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { sqljsPersistence } = (window as any).sqljsLib;
      const dbName = 'test-exists-' + Date.now();
      const mockSqlJs = {
        Database: class {
          data: Uint8Array;
          constructor(data?: Uint8Array) { this.data = data ?? new Uint8Array(0); }
          export() { return this.data; }
        }
      };

      const { key, salt } = await sqljsPersistence.load(dbName, 'pw', mockSqlJs);
      await sqljsPersistence.save(dbName, key, salt, { export: () => new Uint8Array([1, 2, 3]) });

      return sqljsPersistence.dbExists(dbName);
    });

    expect(result).toBe(true);
  });
});
