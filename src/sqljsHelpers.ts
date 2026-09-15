import * as sqlite from 'sql.js';
import { createStore, get, getMany, setMany } from 'idb-keyval';
import { LockedDatabase } from './LockedDatabase';

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

export interface SqlJsPersistenceLoadOptions {
  /** Optional codec used to compress data before encryption and decompress it after decryption. */
  codec?: CompressionCodec;

  /**
   * Supplies the database passphrase only when a new database must be created,
   * or when a legacy database has no persisted CryptoKey yet.
   * The provider is not called when the persisted key can decrypt the database.
   */
  getPassPhrase?: () => string | Promise<string>;
}

export namespace sqljsPersistence {
  const store = createStore('sqljs-documentstore', 'databases');
  const stateByDatabase = new Map<string, { key: CryptoKey, salt: Uint8Array }>();

  async function getSalt(dbName: string): Promise<Uint8Array | undefined> {
    const salt = await get<Uint8Array>(`${dbName}-salt`, store);
    return salt ? new Uint8Array(salt) : undefined;
  }
  
  /**
   * Encrypts and persists the current database using the key established by load.
   * Call load before save when initializing a new JavaScript context.
   */
  export async function save(dbName: string, db: Pick<sqlite.Database, 'export'>, codec?: CompressionCodec): Promise<void> {
    let state = stateByDatabase.get(dbName);
    if (!state) {
      const key = await get<CryptoKey>(`${dbName}-key`, store);
      const salt = await getSalt(dbName);
      if (!key || !salt) throw new Error(`database '${dbName}' has not been loaded`);
      state = { key, salt };
      stateByDatabase.set(dbName, state);
    }

    await _save(dbName, state.key, state.salt, db, codec);
  }

  async function _save(dbName: string, key: CryptoKey, salt: Uint8Array, db: Pick<sqlite.Database, 'export'>, codec?: CompressionCodec): Promise<void> {
    const compressed = await compressionHelpers.compress(db.export(), codec);
    const encryptedData = await cryptoHelpers.encrypt(key, salt, compressed);
    await setMany([
      [`${dbName}`, encryptedData.data],
      [`${dbName}-iv`, encryptedData.iv],
      [`${dbName}-salt`, encryptedData.salt],
      [`${dbName}-key`, key]
    ], store)
  }

  async function persistKey(dbName: string, key: CryptoKey, salt: Uint8Array): Promise<void> {
    await setMany([[`${dbName}-key`, key]], store);
    stateByDatabase.set(dbName, { key, salt });
  }

  /**
   * Loads an existing database or creates one when it does not exist.
   *
   * The passphrase provider is requested lazily for first-time creation or
   * legacy migration. It can be omitted when a persisted CryptoKey exists.
   */
  export async function load(dbName: string, sqlJsStatic: sqlite.SqlJsStatic, options: SqlJsPersistenceLoadOptions = {}): Promise<{database: sqlite.Database, created: boolean, migrated: boolean}> {
    const [encryptedData, iv, persistedSalt] = await getMany<any>([dbName, `${dbName}-iv`, `${dbName}-salt`], store);
    const cachedState = stateByDatabase.get(dbName);
    const persistedKey = cachedState?.key ?? await get<CryptoKey>(`${dbName}-key`, store);

    if (!encryptedData) {
      if (!options.getPassPhrase) throw new Error(`database '${dbName}' does not exist and no passphrase provider was provided`);

      const newDb = new sqlJsStatic.Database();
      const derivedKey = await cryptoHelpers.getKey(await options.getPassPhrase());
  await _save(dbName, derivedKey.key, derivedKey.salt, newDb, options.codec);
      stateByDatabase.set(dbName, derivedKey);
      return { database: newDb, created: true, migrated: false };
    }

    if (!persistedSalt) throw new Error(`database '${dbName}' is missing its salt`);

    let key = persistedKey;
    let migrated = false;
    let existingData: ArrayBuffer;
    try {
      if (!key) throw new Error('persisted CryptoKey is missing');
      existingData = await cryptoHelpers.decrypt(key, iv as BufferSource, encryptedData as BufferSource);
    } catch (error) {
      if (!options.getPassPhrase) throw error;

      const derivedKey = await cryptoHelpers.getKey(await options.getPassPhrase(), persistedSalt);
      existingData = await cryptoHelpers.decrypt(derivedKey.key, iv as BufferSource, encryptedData as BufferSource);
      key = derivedKey.key;
      migrated = !persistedKey;
      await persistKey(dbName, key, persistedSalt);
    }

    if (!stateByDatabase.has(dbName)) stateByDatabase.set(dbName, { key: key!, salt: persistedSalt });
    const rawData = await compressionHelpers.decompress(new Uint8Array(existingData), options.codec);
    return { database: new sqlJsStatic.Database(rawData), created: false, migrated };
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
    const _saveFn = saveFn;
    saveFn = async () => LockedDatabase.sharedLock.acquire('txn_lock', async () => await _saveFn()); //force flush to wait for any active transaction - avoiding bugs from e.g. sql.js db.export causes active transaction to be cleared

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