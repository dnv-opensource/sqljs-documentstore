import {BindParams, QueryExecResult, type Database} from 'sql.js';
import AsyncLock from "async-lock";

export class LockedDatabase implements ILockedDatabase {
  lock = new AsyncLock();
  config: configType = {};
  state: {queued: queuedItemType[]} = { queued: [] };
  txnId?: string;

  constructor(private db: Pick<Database, 'exec'|'run'>, private flush: () => void) {}

  run(txnId: string, sql: string, params: BindParams = []): void {
    if (txnId !== this.txnId) throw new Error(`run: transaction doesn't match, txn in progress: ${this.txnId}, attempted txn: ${this.txnId}`);
    this.db.run(sql, params);
  }

  exec(sql: string, params: BindParams = []): QueryExecResult[] { return this.db.exec(sql, params); }

  /**
   * all write operations must be wrapped in a transaction
   * txns are locked using async-lock library to avoid bleeding across session/txn
   */
  async txnAsync(description: string, actions: (txnId: string) => Promise<void>): Promise<void> {
    const txnId = `${description} ${Math.floor(Math.random() * 4294967296).toString(16)}`; //generate a unique but identifiable txnId
    const queuedItem = { txnId, description, timing: { waitMs: 0, actionMs: 0, flushMs: 0 } };
    this.state.queued.push(queuedItem);
    var ms = performance.now();
    await this.lock.acquire('txn_lock', async () => {
      try {
        queuedItem.timing.waitMs = performance.now() - ms; ms = performance.now();
        this.txnId = txnId;
        this.run(txnId, 'BEGIN TRANSACTION;');
        await actions(txnId);
        queuedItem.timing.actionMs = performance.now() - ms; ms = performance.now();
        this.run(txnId, 'COMMIT TRANSACTION;');
        this.flush();
        queuedItem.timing.flushMs = performance.now() - ms;
      } catch (error) {
        this.run(txnId, 'ROLLBACK TRANSACTION;');
        throw error;
      } finally {
        this.txnId = undefined;
        this.state.queued.pop();
        this.config.loggingHook?.(queuedItem);
      }
    });
  }

  txn(description: string, actions: (txnId: string) => void): void {
    const txnId = `${description} ${Math.floor(Math.random() * 4294967296).toString(16)}`; //generate a unique but identifiable txnId
    const queuedItem = { txnId, description, timing: { waitMs: 0, actionMs: 0, flushMs: 0 } };
    this.state.queued.push(queuedItem);
    var ms = performance.now();
    if (this.lock.isBusy('txn_lock')) throw new Error(`_txnSync: transaction already in progress, txn in progress: ${this.txnId}, attempted txn: ${txnId}`);
    
    try {
      queuedItem.timing.waitMs = performance.now() - ms; ms = performance.now();
      this.txnId = txnId;
      this.run(txnId, 'BEGIN TRANSACTION;');
      actions(txnId);
      queuedItem.timing.actionMs = performance.now() - ms; ms = performance.now();
      this.run(txnId, 'COMMIT TRANSACTION;');
      this.flush();
      queuedItem.timing.flushMs = performance.now() - ms;
    } catch (error) {
      this.run(txnId, 'ROLLBACK TRANSACTION;');
      throw error;
    } finally {
      this.txnId = undefined;
      this.state.queued.pop();
      this.config.loggingHook?.(queuedItem);
    }
  }
}

export interface ILockedDatabase extends LockedDatabase{};
export interface configType { loggingHook?: (q: queuedItemType) => Promise<void> };
export interface queuedItemType {txnId: string, description: string, timing: { waitMs: number, actionMs: number, flushMs: number}};