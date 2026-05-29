import * as IDB from 'idb-keyval';

const MAGIC = 'SQLDS';
const VERSION = 1;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + 1 + IV_LENGTH + SALT_LENGTH;

async function getKey(passphrase: string, salt?: Uint8Array): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  salt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, salt };
}

async function encrypt(key: CryptoKey, salt: Uint8Array, data: Uint8Array): Promise<{ salt: Uint8Array; iv: Uint8Array; data: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
  return { salt, iv, data: new Uint8Array(encrypted) };
}

async function decrypt(key: CryptoKey, iv: Uint8Array, encryptedData: Uint8Array): Promise<ArrayBuffer> {
  return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, encryptedData as BufferSource);
}

async function getFileHandle(dbName: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(`${dbName}.db`, { create: true });
}

/** Migrate from legacy IndexedDB storage (3 keys: dbName, dbName-iv, dbName-salt) to OPFS. */
async function migrateFromIndexedDb(dbName: string, passPhrase: string): Promise<LoadResult | null> {
  const store = IDB.createStore('sqljs-documentstore', 'databases');

  const [encryptedData, iv, salt] = await IDB.getMany<Uint8Array>([dbName, `${dbName}-iv`, `${dbName}-salt`], store);
  if (!encryptedData || !iv || !salt) return null;

  const k = await getKey(passPhrase, new Uint8Array(salt));
  const decrypted = await decrypt(k.key, new Uint8Array(iv), new Uint8Array(encryptedData));
  const rawData = new Uint8Array(decrypted);

  await handleSave(dbName, k.key, rawData);
  await IDB.delMany([dbName, `${dbName}-iv`, `${dbName}-salt`], store);

  return { rawData, key: k.key, salt: k.salt, isNew: false };
}

async function handleSave(dbName: string, key: CryptoKey, rawData: Uint8Array): Promise<void> {
  const handle = await getFileHandle(dbName);
  const accessHandle = await handle.createSyncAccessHandle();
  try {
    let salt: Uint8Array;
    if (accessHandle.getSize() >= HEADER_LENGTH) {
      const existingHeader = new Uint8Array(HEADER_LENGTH);
      accessHandle.read(existingHeader, { at: 0 });
      salt = existingHeader.slice(MAGIC.length + 1 + IV_LENGTH, HEADER_LENGTH);
    } else {
      salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    }

    const encrypted = await encrypt(key, salt, rawData);

    const header = new Uint8Array(HEADER_LENGTH);
    const encoder = new TextEncoder();
    header.set(encoder.encode(MAGIC), 0);
    header[MAGIC.length] = VERSION;
    header.set(encrypted.iv, MAGIC.length + 1);
    header.set(salt, MAGIC.length + 1 + IV_LENGTH);

    accessHandle.truncate(0);
    accessHandle.write(header, { at: 0 });
    accessHandle.write(encrypted.data, { at: HEADER_LENGTH });
    accessHandle.flush();
  } finally {
    accessHandle.close();
  }
}

interface LoadResult {
  rawData: Uint8Array;
  key: CryptoKey;
  salt: Uint8Array;
  isNew: boolean;
}

async function handleLoad(dbName: string, passPhrase: string): Promise<LoadResult> {
  // Attempt migration from legacy IndexedDB format
  const migrated = await migrateFromIndexedDb(dbName, passPhrase);
  if (migrated) return migrated;

  const handle = await getFileHandle(dbName);
  const accessHandle = await handle.createSyncAccessHandle();
  try {
    const size = accessHandle.getSize();
    if (size < HEADER_LENGTH) {
      accessHandle.close();
      const k = await getKey(passPhrase);
      return { rawData: new Uint8Array(0), key: k.key, salt: k.salt, isNew: true };
    }

    const raw = new Uint8Array(size);
    accessHandle.read(raw, { at: 0 });

    const magic = new TextDecoder().decode(raw.slice(0, MAGIC.length));
    if (magic !== MAGIC) throw new Error('Invalid database file: bad magic string');

    const version = raw[MAGIC.length];
    if (version !== VERSION) throw new Error(`Unsupported database file version: ${version}`);

    const iv = raw.slice(MAGIC.length + 1, MAGIC.length + 1 + IV_LENGTH);
    const salt = raw.slice(MAGIC.length + 1 + IV_LENGTH, HEADER_LENGTH);
    const encryptedData = raw.slice(HEADER_LENGTH);

    const k = await getKey(passPhrase, salt);
    const decrypted = await decrypt(k.key, iv, encryptedData);
    return { rawData: new Uint8Array(decrypted), key: k.key, salt: k.salt, isNew: false };
  } finally {
    accessHandle.close();
  }
}

type SaveMessage = { type: 'save'; id: number; dbName: string; key: CryptoKey; rawData: Uint8Array };
type LoadMessage = { type: 'load'; id: number; dbName: string; passPhrase: string };
type WorkerMessage = SaveMessage | LoadMessage;

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id } = e.data;
  try {
    if (type === 'save') {
      const { dbName, key, rawData } = e.data;
      await handleSave(dbName, key, rawData);
      (self as unknown as Worker).postMessage({ id, success: true });
    } else if (type === 'load') {
      const { dbName, passPhrase } = e.data;
      const result = await handleLoad(dbName, passPhrase);
      (self as unknown as Worker).postMessage(
        { id, success: true, rawData: result.rawData, key: result.key, salt: result.salt, isNew: result.isNew },
        [result.rawData.buffer] as any
      );
    }
  } catch (error: any) {
    (self as unknown as Worker).postMessage({ id, success: false, error: error.message });
  }
};
