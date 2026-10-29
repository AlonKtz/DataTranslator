// Run with: node test/translate.test.js
const assert = require('assert');
const SqlToMongo = require('../js/sql-to-mongo.js');
const MongoToSql = require('../js/mongo-to-sql.js');

const cases = [
  // SQL -> MongoDB
  [SqlToMongo, "SELECT name, email FROM users WHERE age >= 18 AND status = 'active' ORDER BY name LIMIT 10",
    'db.users.find({ age: { $gte: 18 }, status: "active" }, { name: 1, email: 1, _id: 0 }).sort({ name: 1 }).limit(10)'],
  [SqlToMongo, "SELECT * FROM products WHERE name LIKE 'Pro%' OR price BETWEEN 10 AND 50",
    'db.products.find({ $or: [{ name: /^Pro/ }, { price: { $gte: 10, $lte: 50 } }] })'],
  [SqlToMongo, 'SELECT * FROM users', 'db.users.find()'],
  [SqlToMongo, 'SELECT COUNT(*) FROM users WHERE age > 30', 'db.users.countDocuments({ age: { $gt: 30 } })'],
  [SqlToMongo, 'SELECT DISTINCT city FROM users', 'db.users.distinct("city")'],
  [SqlToMongo, 'SELECT * FROM t WHERE NOT (a = 1 OR b IN (2,3)) AND c IS NOT NULL',
    'db.t.find({ $nor: [{ a: 1 }, { b: { $in: [2, 3] } }], c: { $ne: null } })'],
  [SqlToMongo, 'SELECT * FROM t WHERE a > 1 AND a < 5', 'db.t.find({ a: { $gt: 1, $lt: 5 } })'],
  [SqlToMongo, 'SELECT * FROM t WHERE 5 < a', 'db.t.find({ a: { $gt: 5 } })'],
  [SqlToMongo, 'SELECT * FROM t WHERE a > b', 'db.t.find({ $expr: { $gt: ["$a", "$b"] } })'],
  [SqlToMongo, "UPDATE users SET status = 'inactive', login_count = login_count + 1 WHERE last_login < '2024-01-01'",
    'db.users.updateMany({ last_login: { $lt: "2024-01-01" } }, { $set: { status: "inactive" }, $inc: { login_count: 1 } })'],
  [SqlToMongo, 'DELETE FROM sessions WHERE expires_at < NOW()', 'db.sessions.deleteMany({ expires_at: { $lt: new Date() } })'],
  [SqlToMongo, "INSERT INTO users (name, age) VALUES ('Ada', 36)", 'db.users.insertOne({ name: "Ada", age: 36 })'],
  [SqlToMongo, 'SELECT dept, SUM(salary) AS total FROM staff GROUP BY dept ORDER BY total DESC LIMIT 3',
    'db.staff.aggregate([\n  { $group: { _id: "$dept", total: { $sum: "$salary" } } },\n  { $sort: { total: -1 } },\n  { $limit: 3 },\n  { $project: { _id: 0, dept: "$_id", total: 1 } }\n])'],

  // MongoDB -> SQL
  [MongoToSql, 'db.users.find({ age: { $gte: 18 }, status: "active" }, { name: 1, email: 1, _id: 0 }).sort({ name: 1 }).limit(10)',
    "SELECT name, email\nFROM users\nWHERE age >= 18 AND status = 'active'\nORDER BY name ASC\nLIMIT 10;"],
  [MongoToSql, 'db.products.find({ $or: [{ name: /^Pro/ }, { price: { $gte: 10, $lte: 50 } }] })',
    "SELECT *\nFROM products\nWHERE name LIKE 'Pro%' OR price BETWEEN 10 AND 50;"],
  [MongoToSql, 'db.t.find({ a: 1, $or: [{ b: 2 }, { c: null }] })', 'SELECT *\nFROM t\nWHERE a = 1 AND (b = 2 OR c IS NULL);'],
  [MongoToSql, 'db.t.find({ name: /^a\\d+$/ })', "SELECT *\nFROM t\nWHERE REGEXP_LIKE(name, '^a\\d+$');"],
  [MongoToSql, 'db.t.countDocuments({ x: { $ne: 3 } })', 'SELECT COUNT(*)\nFROM t\nWHERE x <> 3;'],
  [MongoToSql, 'db.orders.aggregate([{ $match: { status: "shipped" } }, { $group: { _id: "$customerId", total: { $sum: "$amount" } } }, { $match: { total: { $gt: 500 } } }, { $sort: { total: -1 } }, { $limit: 5 }])',
    "SELECT customerId, SUM(amount) AS total\nFROM orders\nWHERE status = 'shipped'\nGROUP BY customerId\nHAVING SUM(amount) > 500\nORDER BY total DESC\nLIMIT 5;"],
  [MongoToSql, 'db.users.updateOne({ _id: ObjectId("64b0c0ffee") }, { $inc: { visits: -1 } })',
    "UPDATE users\nSET visits = visits - 1\nWHERE _id = '64b0c0ffee'\nLIMIT 1;"],
  [MongoToSql, 'db.users.insertMany([{ name: "A", age: 1 }, { name: "B" }])',
    "INSERT INTO users (name, age)\nVALUES\n  ('A', 1),\n  ('B', NULL);"],
  [MongoToSql, 'db.sessions.deleteMany({})', 'DELETE FROM sessions;'],
];

// Translating to the other side and back should give the same result again.
const roundTrips = [
  "SELECT department, COUNT(*) AS employees, AVG(salary) AS avg_salary FROM staff WHERE hired > '2020-01-01' GROUP BY department HAVING COUNT(*) > 5 ORDER BY avg_salary DESC",
  'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON o.customer_id = c._id WHERE o.total > 100',
  "UPDATE users SET status = 'x', n = n + 2 WHERE age BETWEEN 1 AND 9",
];

const errors = [
  [SqlToMongo, 'SELECT * FROM a, b'],
  [SqlToMongo, 'SELECT name, COUNT(*) FROM users GROUP BY city'],
  [SqlToMongo, 'INSERT INTO users VALUES (1, 2)'],
  [MongoToSql, 'db.users.find({ tags: { $size: 2 } })'],
  [MongoToSql, 'users.find()'],
];

let failed = 0;
const check = (name, fn) => {
  try { fn(); } catch (e) { failed++; console.error(`✗ ${name}\n${e.message}\n`); }
};

for (const [T, input, expected] of cases) check(input, () => assert.strictEqual(T.translate(input).output, expected));
for (const sql of roundTrips) {
  check(`round trip: ${sql}`, () => {
    const mongo = SqlToMongo.translate(sql).output;
    const back = MongoToSql.translate(mongo).output;
    assert.strictEqual(SqlToMongo.translate(back).output, mongo);
  });
}
for (const [T, input] of errors) check(`error: ${input}`, () => assert.throws(() => T.translate(input), T.TranslateError));

const total = cases.length + roundTrips.length + errors.length;
console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
