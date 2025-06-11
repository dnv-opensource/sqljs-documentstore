# sqljs-documentstore

`sqljs-documentstore` Minimal, encrypted, sql friendly typed document store, with support for indexed columns. Protects against transactional conflicts.  
The schema for each table is [id, json, ...indexedColumns]


## Install
`npm install --save sqljs-documentstore`

## Usage

exported pieces:  
* `Db` abstract class, extend it and add `TypedDocumentStore`s for each table => class mapping
* `TypedDocumentStore` is meant to map a class type to a table, and has read and write methods
* `LockedDatabase` is consumed in TypedDocumentStore. This is a transactional wrapper around sql.js. It handles transactional scope for multiple programmatic writes and ensures locking so separate txns can't collide.
* `sqlHelpers` has methods to load, save, etc

-----
### Getting started

first, load your database  
```ts
const sqlJsStatic = await sqlite({ locateFile: (file: string) => `${import.meta.env.BASE_URL}assets/${file}` }); //ensure sql-wasm.wasm is placed in dist/assets/ folder
const {key, database} = await sqljsPersistence.load('mydb', 'mySecretDbKey', sqlJsStatic);

const flush = flushHelpers.createAsyncFlushQueue(() => sqljsPersistence.save('mydb', key, database));
const lockedDatabase = new LockedDatabase(database, flush);
```
recommend creating a wrapping "DocumentStores" class as shown below:
```ts
public class DocumentStores extends Db {
  public CustomerData = new TypedDocumentStore(this.db, 'CustomerData', <CustomerData>{}, {
    name: x => x.name,
    orderCount: x => x.orders?.length
  }).asInterface;

  //... more table declarations

  
  ///////
  private static instance: DocumentStores;
  public static get Instance(): DocumentStores { return this.instance ?? (this.instance = new this()); }
  constructor() { super(lockedDatabase); }
}
```

usage example
```ts
  interface CustomerData {
      id: string;
      name: string;
      address: string;
      orders: any[];//OrderData[];
  }


  function exampleUsage() {
    const db = DocumentStores.Instance;
    const allCustomers = ds.CustomerData.getAll(); // returns CustomerData[]
    
    const dave_id = 'abc123';

    db.txn('create Dave', txnId => {
      db.CustomerData.set(txnId, { id: dave_id, name: 'Dave', address: '1 infinity lp', orders: [{ id: 1, description: 'first order' }]});
    });

    const dave = db.CustomerData.get(dave_id); // returns <CustomerData>
    const maybe_dave = db.CustomerData.tryGet(dave_id); //returns <CustomerData?> assert it's not null before using

    db.txn('update Dave', txnId => {
      db.CustomerData.update(txnId, dave_id, x => {
        x.name += ' the great';
        x.address = 'cloud 9';
      });
    });

    const itemsWithOrders = db.CustomerData.query(x => `where ${x.orderCount} >= ?`, [1]);
    const indexValuesOnly = db.CustomerData.queryIndexes(x => `where ${x.orderCount} > 0`); //fetch just index columns (strongly typed as index type - {id, name, orderCount} in this case) useful if table has large quantities of data and you only need, e.g. the ids that match a query
    const customerIds = new Set(indexValuesOnly.map(x => x.id));
  }

    //use txnAsync when you want to have a transactional scope around actions that are async
  async function exampleUsageAsync() {
    const db = DocumentStores.Instance;
    await db.txnAsync('fetch in the middle of a txn', txnId => {
      const newData = await fetch(.../* actual params go here */);
      db.CustomerData.insertMany(newData); //use insertMany if data is not expected to exist already
      db.CustomerData.setMany(newData); //insert new rows, update if already exist
    });
  }
```
