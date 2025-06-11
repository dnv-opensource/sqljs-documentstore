Example sqljs-documentstore usages

``` ts
  interface CustomerData {
      id: string;
      name: string;
      address: string;
      orders: any[];//OrderData[];
  }

  // provide access to a CustomerData documentstore, with columns defined for name and orderCount
  let db: ILockedDatabase;
  const CustomerData = new TypedDocumentStore(() => db, 'CustomerData', <CustomerData>{}, {
    name: x => x.name,
    orderCount: x => x.orders?.length
  }).asInterface;

  
  // usage calling examples
  async function exampleUsage() {
    const allCustomers = await CustomerData.getAll();

    const dave_id = 'abc123';
    const dave = await CustomerData.get(dave_id); //prefer use of 'get' if data is expected to exist, it will throw if it doesn't exist

    const david_id = dave_id + 'id';
    const david = await CustomerData.tryGet(dave_id); //this will return a T? and you'll have to assert it's returned what you want

    db.txn('update Dave', async txnId => {
      CustomerData.update(txnId, dave_id, x => {
        x.name += ' the great';
        x.address = 'cloud 9';
        x.orders = [];
      })
    });
  }
  ```