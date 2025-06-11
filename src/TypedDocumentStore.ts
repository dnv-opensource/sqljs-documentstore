/* eslint-disable no-use-before-define */
/* eslint-disable lines-between-class-members */
import * as _ from 'lodash';
import { ILockedDatabase } from './LockedDatabase';
import { sqljsHelpers } from './sqljsHelpers';
import { SqlValue } from 'sql.js';

export type TIndexType<T> = Record<string, ((obj: T) => string|number|boolean|undefined)>;

export class TypedDocumentStore<T extends IdInterface, TIndex extends TIndexType<T>> implements ITypedDocumentStore<T, TIndex> {
  public tableName;
  public indexedFields;

  private _indexColumns;
  private _indexColumnNamesSql;
  private _indexQuestionMarksSql;
  private _updateParamsSql;

  private setSql;
  private insertSql;

  constructor(private _db: () => ILockedDatabase, tableName: string, docType: T /* used for generic inference magic */, indexedFields: TIndex = <never>{}) {
    this.tableName = tableName;
    this.indexedFields = indexedFields;

    //helper fields for sql template strings below
    this._indexColumns = _.keys(this.indexedFields);
    this._indexColumnNamesSql = this._indexColumns.map(c => `, ${c}`).join('');
    this._indexQuestionMarksSql = ', ?'.repeat(this._indexColumns.length);
    this._updateParamsSql = _.map(this._indexColumns, (name, index) => `, ${name}=?${index + [dbRow.id, dbRow.json].length + 1}`).join('');

    //actual sql template strings
    this.insertSql = `insert into ${this.tableName} (${dbRow.id}, ${dbRow.json}${this._indexColumnNamesSql}) values (?, ?${this._indexQuestionMarksSql});`;
    this.setSql =    `insert into ${this.tableName} (${dbRow.id}, ${dbRow.json}${this._indexColumnNamesSql}) values (?, ?${this._indexQuestionMarksSql}) `
      + `on conflict(${dbRow.id}) do update set ${dbRow.json}=?2 ${this._updateParamsSql} where ${dbRow.id}=?1;`;

  }

  private get db() { return this._db(); }

  get asInterface() : ITypedDocumentStore<T, TIndex> { return this;}
  
  /**
   * ensure table (schema) exists
   */
  init(options: { autoMigrateIndexChanges: boolean } = { autoMigrateIndexChanges: true }): void {
    const tableExists = sqljsHelpers.isTable(this.db, this.tableName);
    if (!tableExists) {
      this.db.txn(`${this.tableName} create table`, txnId => {
        const createTableSql = `create table if not exists ${this.tableName} (${dbRow.id} primary key not null, ${dbRow.json} ${this._indexColumnNamesSql});`;
        this.db.run(txnId, createTableSql);
      });
    } else if (options.autoMigrateIndexChanges) {
      //check for and append missing columns
      const result = sqljsHelpers.query<table_infoType>(this.db, `PRAGMA table_info('${this.tableName}')`);
      if (!result) {
        console.warn(`unable to get table_info for ${this.tableName}`);
        return;
      }
      const existingColumns = new Set(result.map(x => x.name));
      const missingColumns = _.filter(this._indexColumns, columnName => !existingColumns.has(<string>columnName));
      if (missingColumns.length === 0) {
        return;
      }
      console.log(`adding missing columns to ${this.tableName}`, missingColumns);
      this.db.txn(`${this.tableName} add missing columns`, txnId => {
        missingColumns.forEach(columnName => this.db.run(txnId, `alter table ${this.tableName} add column ${columnName};`));
        this.rebuildIndexes(txnId);
      });
    }
  }

   get(id: unknown) : T {
    const result = this._tryGet(id);
    if (result === null || result === undefined) throw new Error(`${TypedDocumentStore.name}<${this.tableName}>.get(${id}) was undefined`);
    return <T>result;
  }

  tryGet(id: unknown) : T|undefined {
    return this._tryGet(id);
  }

  private _tryGet(id: unknown) {
    const rows = sqljsHelpers.query<DbRow>(this.db, `select ${dbRow.id}, ${dbRow.json} from ${this.tableName} where ${dbRow.id} = ?;`, [id]);
    if (rows.length == 0) return undefined;
    return <T>JSON.parse(rows[0].json);
  }

   getMany(ids: unknown[]): T[] {
    const results = this._tryGetMany(ids);
    const missingIds = ids.filter((_, i) => results[i] === null || results[i] === undefined);
    if (missingIds.length > 0) throw new Error(`${TypedDocumentStore.name}<${this.tableName}>.getMany(...) was undefined for ids ${missingIds.join(', ')}`);
    return <T[]>results;
  }

  /**
   * returns ids => in order set of results, if no result for given id, array item will be null
   * prefer use of 'getMany' if all items are expected to exist
   */
  tryGetMany(ids: unknown[]) {
    return this._tryGetMany(ids);
  }

  private _tryGetMany(ids: unknown[]) {
    if (ids.length === 0) return [];
    const queryResult = sqljsHelpers.query<DbRow>(this.db, `select ${dbRow.id}, ${dbRow.json} from ${this.tableName} where ${dbRow.id} in (${'?,'.repeat(ids.length).slice(0, -1)});`, ids);
    const rowById = _.keyBy(queryResult, row => <number|string>row.id);
    let currentId!: unknown;
    try {
      return ids.map((id: any) => {
        currentId = id;
        if (!(id in rowById)) return undefined;
        const row = rowById[id];
        return <T>JSON.parse(row.json);
      });
    } catch (e) {
      throw Error(`error while parsing document ${this.tableName} id: ${currentId}`);
    }
  }

  exists(id: unknown) : boolean {
    const result = (this.db.exec(`select 1 from ${this.tableName} where ${dbRow.id} = ?;`, [<SqlValue>id]));
    return (result.values?.length ?? 0) > 0;
  }

  getAll(): T[] {
    const results = sqljsHelpers.query<DbRow>(this.db, `select ${dbRow.json} from ${this.tableName};`);
    return results.map(x => <T>JSON.parse(x.json));
  }

  /**
   * Query document store by indexed columns. Provide a sql fragment of where clause and array of parameters. Can be abused to do joins, etc.
   * @example .query(x => `where ${x.name} like ? and ${x.active} = ?`, [nameSearchValue, isActive]);
   * @example .query(x => `where ${x.name} like ?1 and ${x.active} = ?2`, [nameSearchValue, isActive]);
   */
  query(whereSql: ((x: Record<keyof TIndex, string>) => string), params: unknown[]): T[] {
    const querySql = `select ${dbRow.id}, ${dbRow.json} from ${this.tableName} ${whereSql(this._buildQueryObject())};`;
    const results = sqljsHelpers.query<DbRow>(this.db, querySql, params);
    return results.map(x => <T>JSON.parse(x.json));
  }

  /**
   * Return just index values, helpful for doing fast queries on indexed fields without needing to fetch and deserialize the entire object
   */
  queryIndexes(whereSql?: ((x: Record<keyof TIndex | 'id', string>) => string), params?: unknown[]): ({ [k in keyof(TIndex)]: ReturnType<TIndex[k]>} & Pick<T, 'id'>)[] {
    const querySql = `select ${dbRow.id}${this._indexColumnNamesSql} from ${this.tableName} ${whereSql !== undefined ? whereSql(this._buildQueryObject()) : ''};`;
    const results = sqljsHelpers.query<({ [k in keyof(TIndex)]: ReturnType<TIndex[k]>} & Pick<T, 'id'>)>(this.db, querySql, params);
    return results;
  }

  count(): number {
    const result = this.db.exec(`select count(1) from ${this.tableName};`);
    return result[0].values[0][0] as number;
  }

  /**
   * insert or update a single document
   */
  set(txnId: string, value: T) : void { this.db.run(txnId, this.setSql, this._buildParams(value)); }

  /**
   * insert or update many documents, prefer use of insertMany if data is expected to not exist
   */
  setMany(txnId: string, values: T[]) : void {
    if (values.length === 0) return;
    values.forEach(value => this.db.run(txnId, this.setSql, this._buildParams(value)));
  }

  insertMany(txnId: string, values: T[]) : void {
    if (values.length === 0) return;
    values.forEach(value => this.db.run(txnId, this.insertSql, this._buildParams(value)));
  }

   /**
   * fetch, modify, and update a document
   */
  update(txnId: string, id: Pick<T, 'id'>['id'], updateAction: (existing: Omit<T, 'id'>) => void) : void {
    const value = this.get(id);
    updateAction(value);
    this.set(txnId, value);
  }

  /**
   * like update, but falls back to initializer value if document doesn't already exist
   */
  upsert(txnId: string, initializer: T, updateAction: (existing: Omit<T, 'id'>) => void) : void {
    const value = this.tryGet(initializer.id) ?? initializer;
    updateAction(value);
    this.set(txnId, value);
  }

  remove(txnId: string, id: Pick<T, 'id'>['id']): void { this.db.run(txnId, `delete from ${this.tableName} where ${dbRow.id} = ?;`, sqljsHelpers.sanitizeParams([id])); }
  removeMany(txnId: string, ids: Pick<T, 'id'>['id'][]) : void { if (ids.length === 0) return; this.db.run(txnId, `delete from ${this.tableName} where ${dbRow.id} in (${'?,'.repeat(ids.length).slice(0, -1)});`, sqljsHelpers.sanitizeParams(ids)); }
  removeAll(txnId: string): void { this.db.run(txnId, `delete from ${this.tableName};`); }

  private _buildQueryObject(): Record<keyof TIndex, string> {
    const queryObject = <any>{};
    this._indexColumns.forEach(columnName => ((queryObject[columnName]) = <never>columnName));
    return queryObject;
  }

  private _buildParams(value: T) {
    // eslint-disable-next-line prefer-destructuring
    const id = value.id;
    const json = JSON.stringify(value);
    const indexParams = this._indexValues(value);
    return sqljsHelpers.sanitizeParams(_.concat([id, json], indexParams));
  }

  private _indexValues(obj: T) { return _.map(this.indexedFields, accessor => accessor(obj)); }

  private rebuildIndexes(txnId: string) { this.setMany(txnId, this.getAll()); }
}

export interface ITypedDocumentStore<T extends IdInterface, TIndex extends TIndexType<T>> extends TypedDocumentStore<T, TIndex>{};
export interface IdInterface { id: unknown; }
export interface ITypedDocumentStoreInit extends Pick<TypedDocumentStore<any,any>, 'init'> {};
export function isTypedDocumentStore(obj: unknown): obj is ITypedDocumentStoreInit {
  const x = (obj as ITypedDocumentStoreInit);
  return x.init !== undefined;
}
export interface DbRow { id: unknown, json: string }
export const dbRow = <DbRow>{ id: 'id', json: 'json' };

type table_infoType = {cid: number, name: string, type: string, notnull: number, dflt_value: string|null, pk: number};