# @dnvgl-electricgrid/sqljs-documentstore

`@dnvgl-electricgrid/sqljs-documentstore` Minimal, encrypted, sql friendly typed document store, with support for indexed columns. Protects against transactional conflicts.  
The schema for each table is [id, json, ...indexedColumns]


## Install
`npm install --save @dnvgl-electricgrid/sqljs-documentstore`

## Usage

exported pieces:  
* `Db` abstract class, extend it and add `TypedDocumentStore`s for each table => class mapping
* `TypedDocumentStore` is meant to map a class type to a table, and has read and write methods
* `LockedDatabase` is consumed in TypedDocumentStore. This is a transactional wrapper around sql.js. It handles transactional scope for multiple programmatic writes and ensures locking so separate txns can't collide.
* `sqlHelpers` has methods to load, save, etc

-----
### Getting started

first, load your database
recommend creating a wrapping "DocumentStores" class as shown below:
```ts
const database = await sqljsHelpers.load('mydb', await sqlite());
const lockedDatabase = new LockedDatabase(database, () => sqljsHelpers.save('mydb', database));

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

see [examples.md] (https://github.com/dnvgl-opensource/sqljs-documentstore/docs/examples.md) for usage examples.
