import sqlite from 'sql.js';
import { createStore, get, getMany, setMany } from 'idb-keyval';

export interface EncryptedDataItem {
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

export namespace sqljsPersistence {
  const store = createStore('sqljs-documentstore', 'databases');
  
  export async function save(dbName: string, key: CryptoKey, db: Pick<sqlite.Database, 'export'>): Promise<void> {
    const saltItem = await get<Uint8Array>(`${dbName}-salt`, store);
    const salt = saltItem ? new Uint8Array(saltItem) : crypto.getRandomValues(new Uint8Array(16));

    await _save(dbName, key, salt, db);
  }

  async function _save(dbName: string, key: CryptoKey, salt: Uint8Array, db: Pick<sqlite.Database, 'export'>): Promise<void> {
    const encryptedData = await cryptoHelpers.encrypt(key, salt, db.export());
    await setMany([
      [`${dbName}`, encryptedData.data],
      [`${dbName}-iv`, encryptedData.iv],
      [`${dbName}-salt`, encryptedData.salt]
    ], store)
  }

  export async function load(dbName: string, passPhrase: string, sqlJsStatic: sqlite.SqlJsStatic): Promise<{database: sqlite.Database, key: CryptoKey}> {
    const [encryptedData, iv, salt] = await getMany<Uint8Array>([dbName, `${dbName}-iv`, `${dbName}-salt`], store);
    if (!encryptedData) {
      const newDb = new sqlJsStatic.Database();
      const k = await cryptoHelpers.getKey(passPhrase);
      await _save(dbName, k.key, k.salt, newDb);
      return { key: k.key, database: newDb };
    }

    const k = await cryptoHelpers.getKey(passPhrase, salt);
    const existingData = await cryptoHelpers.decrypt(k.key, iv, encryptedData);
    return { key: k.key, database: new sqlJsStatic.Database(new Uint8Array(existingData)) };
  }
}

export namespace sqljsHelpers {
  export function query<T>(db: Pick<sqlite.Database, 'exec'>, sql: string, params: any[] = []): T[] {
    const allResults = exec(db, sql, params); //expect only one result set, if there are multiple, just take the last one
    const result = allResults[allResults.length - 1];

    if (result === undefined || result.values.length == 0) return [];

    const { columns, values } = result;
    return <T[]>values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
  }

  export function exec(db: Pick<sqlite.Database, 'exec'>, sql: string, params: any[] = []): sqlite.QueryExecResult[] { return db.exec(sql, sanitizeParams(params)); }
  export function run(db: Pick<sqlite.Database, 'run'>, sql: string, params: any[] = []): void { db.run(sql, sanitizeParams(params)); }

  export function isTable(db: Pick<sqlite.Database, 'exec'>, table: string): boolean { return db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?;", [table]).values!.length > 0; }
  export function sanitizeParams(params: any[]): sqlite.SqlValue[] { return params.map(v => v == undefined ? null : v == true ? 1 : v == false ? 0 : v); }
}

export namespace cryptoHelpers {
  export async function getKey(passphrase: string, salt?: Uint8Array): Promise<{key: CryptoKey, salt: Uint8Array}> {
    salt = salt ?? crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    var r = { key: await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), salt: salt};
    return r;
  }

  export async function encrypt(key: CryptoKey, salt: Uint8Array, data: Uint8Array): Promise<EncryptedDataItem> {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {salt: salt, iv: iv, data: new Uint8Array(encrypted)};
  }

  export async function decrypt(key: CryptoKey, iv: BufferSource, encryptedData: BufferSource): Promise<ArrayBuffer> {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, encryptedData);
    return data;
  }
}

export namespace flushHelpers {
  export function createAsyncFlushQueue(saveFn: () => Promise<void>) {
    let isRunning = false;
    let queued = false;

    const run = () => {
      if (isRunning) {
        queued = true;
        return;
      }

      isRunning = true;
      saveFn().finally(() => {
        isRunning = false;
        if (queued) {
          queued = false;
          run();
        }
      });
    };

    return run;
  }
}