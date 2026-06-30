// sources/mysql.test.ts — pure parsing tests (no DB required).
import assert from "node:assert";
import { parseMysqlUrl, describeConn } from "./mysql";

// SQLAlchemy-style scheme (mysql+pymysql) with RAW special chars in the password
// (@, #, $, !) — must be parsed structurally and survive literally.
{
  const c = parseMysqlUrl("mysql+pymysql://Aiuser_r_01:Nat0$#Chn!@2918@10.222.0.22:3306/myshift_koel");
  assert.equal(c.host, "10.222.0.22");
  assert.equal(c.port, 3306);
  assert.equal(c.user, "Aiuser_r_01");
  assert.equal(c.password, "Nat0$#Chn!@2918");
  assert.equal(c.database, "myshift_koel");
}

// defaults: port 3306, empty password, ssl false
{
  const c = parseMysqlUrl("mysql://root@127.0.0.1/shop");
  assert.equal(c.port, 3306);
  assert.equal(c.password, "");
  assert.equal(c.database, "shop");
  assert.equal(c.ssl, false);
}

// ssl flag via query string, database before the '?'
{
  const c = parseMysqlUrl("mysql://app:secret@db.example.com:3307/sales?ssl=true");
  assert.equal(c.database, "sales");
  assert.equal(c.port, 3307);
  assert.equal(c.ssl, true);
}

// key=value form
{
  const c = parseMysqlUrl("host=h.internal user=ro password=pw database=analytics port=3310 sslmode=required");
  assert.equal(c.host, "h.internal");
  assert.equal(c.user, "ro");
  assert.equal(c.database, "analytics");
  assert.equal(c.port, 3310);
  assert.equal(c.ssl, true);
}

// masking never leaks the password
{
  const c = parseMysqlUrl("mysql://u:supersecret@h/db");
  assert.ok(!describeConn(c).includes("supersecret"));
  assert.ok(describeConn(c).includes("***"));
}

// missing database / host throw
assert.throws(() => parseMysqlUrl("mysql://h/"), /database/);
assert.throws(() => parseMysqlUrl("host=h user=u"), /database/);
assert.throws(() => parseMysqlUrl(""), /empty/);

console.log("ok bff/sources/mysql parse");
