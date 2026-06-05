import * as sqlite from 'sql.js';
import { createStore, get, getMany, setMany } from 'idb-keyval';

export interface EncryptedDataItem {
  salt: Uint8Array;
  iv: Uint8Array;
  data: Uint8Array;
}

/**
 * Pluggable compression codec. Supply your own (e.g. lz4-wasm, or the browser's
 * CompressionStream) to compress the database before it is encrypted and stored.
 *
 * The same codec must be supplied on both `save` and `load`. Both methods may be
 * sync or async. If no codec is supplied, data is stored uncompressed.
 */
export interface CompressionCodec {
  compress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decompress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export namespace sqljsPersistence {
  const store = createStore('sqljs-documentstore', 'databases');
  
  export async function save(dbName: string, key: CryptoKey, db: Pick<sqlite.Database, 'export'>, codec?: CompressionCodec): Promise<void> {
    const saltItem = await get<Uint8Array>(`${dbName}-salt`, store);
    const salt = saltItem ? new Uint8Array(saltItem) : crypto.getRandomValues(new Uint8Array(16));

    await _save(dbName, key, salt, db, codec);
  }

  async function _save(dbName: string, key: CryptoKey, salt: Uint8Array, db: Pick<sqlite.Database, 'export'>, codec?: CompressionCodec): Promise<void> {
    const compressed = await compressionHelpers.compress(db.export(), codec);
    const encryptedData = await cryptoHelpers.encrypt(key, salt, compressed);
    await setMany([
      [`${dbName}`, encryptedData.data],
      [`${dbName}-iv`, encryptedData.iv],
      [`${dbName}-salt`, encryptedData.salt]
    ], store)
  }

  export async function load(dbName: string, passPhrase: string, sqlJsStatic: sqlite.SqlJsStatic, codec?: CompressionCodec): Promise<{database: sqlite.Database, key: CryptoKey}> {
    const [encryptedData, iv, salt] = await getMany<Uint8Array>([dbName, `${dbName}-iv`, `${dbName}-salt`], store);
    if (!encryptedData) {
      const newDb = new sqlJsStatic.Database();
      const k = await cryptoHelpers.getKey(passPhrase);
      await _save(dbName, k.key, k.salt, newDb, codec);
      return { key: k.key, database: newDb };
    }

    const k = await cryptoHelpers.getKey(passPhrase, salt);
    const existingData = await cryptoHelpers.decrypt(k.key, iv as BufferSource, encryptedData as BufferSource);
    const rawData = await compressionHelpers.decompress(new Uint8Array(existingData), codec);
    return { key: k.key, database: new sqlJsStatic.Database(rawData) };
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

  export function isTable(db: Pick<sqlite.Database, 'exec'>, table: string): boolean { return db.exec("SELECT count(1) FROM sqlite_master WHERE type='table' AND name=?;", [table])[0]!.values[0][0] as number > 0; }
  export function sanitizeParams(params: any[]): sqlite.SqlValue[] { return params.map(v => v == undefined ? null : v == true ? 1 : v == false ? 0 : v); }
}

export namespace compressionHelpers {
  // Marker prepended to codec-compressed payloads so we can detect them on load.
  // A raw SQLite export always begins with "SQLite format 3\0", so this 4-byte
  // marker can never collide with uncompressed data. Kept stable across versions
  // so previously-stored compressed databases remain readable (with a codec).
  const MAGIC = new Uint8Array([0x4c, 0x5a, 0x34, 0x01]); // "LZ4\x01"

  export async function compress(data: Uint8Array, codec?: CompressionCodec): Promise<Uint8Array> {
    if (!codec) return data; // no codec => store uncompressed
    const compressed = await codec.compress(data);
    const out = new Uint8Array(MAGIC.length + compressed.length);
    out.set(MAGIC, 0);
    out.set(compressed, MAGIC.length);
    return out;
  }

  export async function decompress(data: Uint8Array, codec?: CompressionCodec): Promise<Uint8Array> {
    if (!isCompressed(data)) return data; // payload was stored uncompressed
    if (!codec) throw new Error('This database was stored with a compression codec; supply the matching codec to load it.');
    return await codec.decompress(data.subarray(MAGIC.length));
  }

  function isCompressed(data: Uint8Array): boolean {
    if (data.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) return false;
    return true;
  }
}

export namespace cryptoHelpers {
  export async function getKey(passphrase: string, salt?: Uint8Array): Promise<{key: CryptoKey, salt: Uint8Array}> {
    salt = salt ?? crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    var r = { key: await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), salt: salt};
    return r;
  }

  export async function encrypt(key: CryptoKey, salt: Uint8Array, data: Uint8Array): Promise<EncryptedDataItem> {
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
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