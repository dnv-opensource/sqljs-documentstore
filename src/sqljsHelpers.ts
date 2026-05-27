import * as sqlite from 'sql.js';
import { WORKER_CODE } from './persistenceWorker.generated';

export namespace sqljsPersistence {
  let worker: Worker | null = null;
  let messageId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>();

  function getWorker(): Worker {
    if (!worker) {
      const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = (e) => {
        const { id, success, error, ...rest } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (success) p.resolve(rest);
        else p.reject(new Error(error));
      };
    }
    return worker;
  }

  function postMessage(msg: any, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = messageId++;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ ...msg, id }, transfer);
    });
  }

  export async function save(dbName: string, key: CryptoKey, db: Pick<sqlite.Database, 'export'>): Promise<void> {
    const rawData = db.export();
    await postMessage({ type: 'save', dbName, key, rawData }, [rawData.buffer]);
  }

  export async function load(dbName: string, passPhrase: string, sqlJsStatic: sqlite.SqlJsStatic): Promise<{database: sqlite.Database, key: CryptoKey}> {
    const result = await postMessage({ type: 'load', dbName, passPhrase });
    if (result.isNew) {
      const newDb = new sqlJsStatic.Database();
      // Save the new empty database through the worker
      const rawData = newDb.export();
      await postMessage({ type: 'save', dbName, key: result.key, rawData }, [rawData.buffer]);
      return { key: result.key, database: newDb };
    }
    return { key: result.key, database: new sqlJsStatic.Database(new Uint8Array(result.rawData)) };
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