import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getWorkerCode(): string {
  const generated = fs.readFileSync(path.join(__dirname, '../src/persistenceWorker.generated.ts'), 'utf8');
  const match = generated.match(/export const WORKER_CODE = (.*);$/ms);
  if (!match) throw new Error('Could not extract WORKER_CODE');
  return JSON.parse(match[1]);
}

function createWorkerHelper(workerCode: string) {
  return `
    window.__worker = (() => {
      const blob = new Blob([${JSON.stringify(workerCode)}], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      let messageId = 0;
      const pending = new Map();

      worker.onmessage = (e) => {
        const { id, success, error, ...rest } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (success) p.resolve(rest);
        else p.reject(new Error(error || 'Unknown worker error'));
      };

      return {
        post(msg, transfer = []) {
          return new Promise((resolve, reject) => {
            const id = messageId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ ...msg, id }, transfer);
          });
        }
      };
    })();
  `;
}

test.describe('sqljsPersistence', () => {
  let workerCode: string;

  test.beforeAll(() => {
    workerCode = getWorkerCode();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(createWorkerHelper(workerCode));
  });

  test('save and load round-trips data correctly', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__worker;
      const dbName = 'test-roundtrip-' + Date.now();
      const passPhrase = 'test-passphrase';

      // Load creates a new db and returns a key
      const loadResult = await w.post({ type: 'load', dbName, passPhrase });
      if (!loadResult.isNew) throw new Error('Expected isNew to be true');

      // Save some data
      const testData = new Uint8Array([1, 2, 3, 4, 5, 42, 99, 200]);
      await w.post(
        { type: 'save', dbName, key: loadResult.key, salt: loadResult.salt, rawData: testData },
        [testData.buffer]
      );

      // Load it back
      const loaded = await w.post({ type: 'load', dbName, passPhrase });
      return {
        isNew: loaded.isNew,
        data: Array.from(new Uint8Array(loaded.rawData)),
      };
    });

    expect(result.isNew).toBe(false);
    expect(result.data).toEqual([1, 2, 3, 4, 5, 42, 99, 200]);
  });

  test('load returns isNew for non-existent database', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__worker;
      const dbName = 'test-new-' + Date.now();
      const loadResult = await w.post({ type: 'load', dbName, passPhrase: 'pw' });
      return { isNew: loadResult.isNew };
    });

    expect(result.isNew).toBe(true);
  });

  test('save overwrites previous data', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__worker;
      const dbName = 'test-overwrite-' + Date.now();
      const passPhrase = 'pw';

      const { key, salt } = await w.post({ type: 'load', dbName, passPhrase });

      // Save first version
      const data1 = new Uint8Array([10, 20, 30]);
      await w.post({ type: 'save', dbName, key, salt, rawData: data1 });

      // Save second version
      const data2 = new Uint8Array([77, 88]);
      await w.post({ type: 'save', dbName, key, salt, rawData: data2 });

      // Load should return second version
      const loaded = await w.post({ type: 'load', dbName, passPhrase });
      return Array.from(new Uint8Array(loaded.rawData));
    });

    expect(result).toEqual([77, 88]);
  });

  test('dbExists returns false for non-existent database', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__worker;
      const dbName = 'test-noexist-' + Date.now();
      const res = await w.post({ type: 'exists', dbName });
      return res.exists;
    });

    expect(result).toBe(false);
  });

  test('dbExists returns true after save', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const w = (window as any).__worker;
      const dbName = 'test-exists-' + Date.now();
      const passPhrase = 'pw';

      const { key, salt } = await w.post({ type: 'load', dbName, passPhrase });
      const data = new Uint8Array([1, 2, 3]);
      await w.post({ type: 'save', dbName, key, salt, rawData: data }, [data.buffer]);

      const res = await w.post({ type: 'exists', dbName });
      return res.exists;
    });

    expect(result).toBe(true);
  });
});
