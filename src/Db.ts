import { isTypedDocumentStore } from "./TypedDocumentStore";
import { ILockedDatabase } from "./LockedDatabase";
import { sqljsHelpers } from "./sqljsHelpers";

export abstract class Db {
    constructor(private database: () => ILockedDatabase) { }

    public txn(description: string, actions: (txnId: string) => void): void { return this.database().txn(description, txnId => actions(txnId)); }
    public async txnAsync(description: string, actions: (txnId: string) => Promise<void>): Promise<void> { return this.database().txnAsync(description, txnId => actions(txnId)); }
    
    public initted = false;
    public init() { Object.values(this).filter(value => isTypedDocumentStore(value)).forEach(store => store.init()); this.initted = true; }

   /**
   * Used to query from console, or for advanced querying scenarios in code
   * @example //from console
   * console.table(await window.db.query('select * from FieldDefinitionData f join CalculatedFieldDefinitionData c on f.id = c.fieldId;'));
   * @example //from code - advanced query - join tables and union the data types:
   * await doc.query<FieldDefinitionData & CalculatedFieldDefinitionData, {fJson: string, cJson: string}>(
   * 'select f.json fJson, c.json cJson from FieldDefinitionData f join CalculatedFieldDefinitionData c on f.id = c.fieldId',
   * undefined, row => _.merge(<FieldDefinitionData>JSON.parse(row.fJson), <CalculatedFieldDefinitionData>JSON.parse(row.cJson)));
   * @example //from code - less type checking:
   * <(FieldDefinitionData & CalculatedFieldDefinitionData)[]> await doc.query(
   * 'select f.json fJson, c.json cJson from FieldDefinitionData f join CalculatedFieldDefinitionData c on f.id = c.fieldId',
   * undefined, row => _.merge(JSON.parse(row.fJson), JSON.parse(row.cJson)));
   */
    public query<T = unknown, TRow = T>(sql: string, params?: unknown[], projection?: (row: TRow) => T): T[] {
        const result = sqljsHelpers.query<TRow>(this.database(), sql, params);
        if (result.length == 0) return [];
        if (!projection) return <T[]><any>result;
        return result.map(row => projection(row));
    }
}