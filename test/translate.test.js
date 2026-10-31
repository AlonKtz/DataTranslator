// Run with: node test/translate.test.js
const assert = require('assert');
const SqlToMongo = require('../js/sql-to-mongo.js');
const MongoToSql = require('../js/mongo-to-sql.js');

const S = (input, expected) => [SqlToMongo, input, expected];
const M = (input, expected) => [MongoToSql, input, expected];

// ---------------------------------------------------------------- exact translations

const exact = {
  basic: [
    S('SELECT * FROM users', 'db.users.find()'),
    S("SELECT name, email FROM users WHERE age >= 18 AND status = 'active' ORDER BY name LIMIT 10",
      'db.users.find({ age: { $gte: 18 }, status: "active" }, { name: 1, email: 1, _id: 0 }).sort({ name: 1 }).limit(10)'),
    S("SELECT * FROM products WHERE name LIKE 'Pro%' OR price BETWEEN 10 AND 50",
      'db.products.find({ $or: [{ name: /^Pro/ }, { price: { $gte: 10, $lte: 50 } }] })'),
    S('SELECT COUNT(*) FROM users WHERE age > 30', 'db.users.countDocuments({ age: { $gt: 30 } })'),
    S('SELECT DISTINCT city FROM users', 'db.users.distinct("city")'),
    S('SELECT * FROM t WHERE a > 1 AND a < 5', 'db.t.find({ a: { $gt: 1, $lt: 5 } })'),
    S('SELECT * FROM t WHERE 5 < a', 'db.t.find({ a: { $gt: 5 } })'),
    S('SELECT * FROM t WHERE NOT (a = 1 OR b IN (2,3)) AND c IS NOT NULL',
      'db.t.find({ $nor: [{ a: 1 }, { b: { $in: [2, 3] } }], c: { $ne: null } })'),
    S("SELECT * FROM users WHERE _id = '507f1f77bcf86cd799439011'", 'db.users.find({ _id: ObjectId("507f1f77bcf86cd799439011") })'),
    S("INSERT INTO users (name, age) VALUES ('Ada', 36)", 'db.users.insertOne({ name: "Ada", age: 36 })'),
    S("UPDATE users SET status = 'inactive', login_count = login_count + 1 WHERE last_login < '2024-01-01'",
      'db.users.updateMany({ last_login: { $lt: "2024-01-01" } }, { $set: { status: "inactive" }, $inc: { login_count: 1 } })'),
    S('DELETE FROM sessions WHERE expires_at < NOW()', 'db.sessions.deleteMany({ expires_at: { $lt: new Date() } })'),

    M('db.users.find({ age: { $gte: 18 }, status: "active" }, { name: 1, email: 1, _id: 0 }).sort({ name: 1 }).limit(10)',
      "SELECT name, email\nFROM users\nWHERE age >= 18 AND status = 'active'\nORDER BY name ASC\nLIMIT 10;"),
    M('db.products.find({ $or: [{ name: /^Pro/ }, { price: { $gte: 10, $lte: 50 } }] })',
      "SELECT *\nFROM products\nWHERE name LIKE 'Pro%' OR price BETWEEN 10 AND 50;"),
    M('db.t.find({ a: 1, $or: [{ b: 2 }, { c: null }] })', 'SELECT *\nFROM t\nWHERE a = 1 AND (b = 2 OR c IS NULL);'),
    M('db.t.countDocuments({ x: { $ne: 3 } })', 'SELECT COUNT(*)\nFROM t\nWHERE x <> 3;'),
    M('db.users.insertMany([{ name: "A", age: 1 }, { name: "B" }])', "INSERT INTO users (name, age)\nVALUES\n  ('A', 1),\n  ('B', NULL);"),
    M('db.users.updateOne({ _id: ObjectId("64b0c0ffee") }, { $inc: { visits: -1 } })',
      "UPDATE users\nSET visits = visits - 1\nWHERE _id = '64b0c0ffee'\nLIMIT 1;"),
    M('db.sessions.deleteMany({})', 'DELETE FROM sessions;'),
  ],

  intermediate: [
    S('SELECT dept, SUM(salary) AS total FROM staff GROUP BY dept ORDER BY total DESC LIMIT 3',
      'db.staff.aggregate([\n  { $group: { _id: "$dept", total: { $sum: "$salary" } } },\n  { $sort: { total: -1 } },\n  { $limit: 3 },\n  { $project: { _id: 0, dept: "$_id", total: 1 } }\n])'),
    S('SELECT name, price * 1.17 AS with_vat FROM products ORDER BY with_vat DESC',
      'db.products.aggregate([\n  { $project: { name: 1, with_vat: { $multiply: ["$price", 1.17] }, _id: 0 } },\n  { $sort: { with_vat: -1 } }\n])'),
    S("SELECT name, CASE WHEN age < 18 THEN 'minor' ELSE 'adult' END AS bracket FROM users",
      'db.users.aggregate([\n  { $project: { name: 1,\n                bracket: { $cond: [{ $lt: ["$age", 18] }, "minor", "adult"] },\n                _id: 0 } }\n])'),
    S("SELECT CAST(price AS INT) AS p, data->>'color' AS color FROM products WHERE data->>'size' = 'L'",
      'db.products.aggregate([\n  { $match: { "data.size": "L" } },\n  { $project: { p: { $toInt: "$price" }, color: "$data.color", _id: 0 } }\n])'),
    S("SELECT * FROM events WHERE created_at > NOW() - INTERVAL '7 days'",
      'db.events.find({\n  $expr: { $gt: ["$created_at",\n                 { $dateSubtract: { startDate: "$$NOW", unit: "day", amount: 7 } }] }\n})'),

    M('db.orders.aggregate([{ $match: { status: "shipped" } }, { $group: { _id: "$customerId", total: { $sum: "$amount" } } }, { $match: { total: { $gt: 500 } } }, { $sort: { total: -1 } }, { $limit: 5 }])',
      "SELECT customerId, SUM(amount) AS total\nFROM orders\nWHERE status = 'shipped'\nGROUP BY customerId\nHAVING SUM(amount) > 500\nORDER BY total DESC\nLIMIT 5;"),
    M('db.orders.aggregate([{ $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "c" } }, { $unwind: "$c" }, { $project: { _id: 0, id: 1, total: 1, "c.name": 1 } }])',
      'SELECT id, total, c.name\nFROM orders\nINNER JOIN customers AS c ON orders.customer_id = c._id;'),
    M('db.t.find({ name: /^a\\d+$/ })', "SELECT *\nFROM t\nWHERE REGEXP_LIKE(name, '^a\\d+$');"),
  ],

  advanced: [
    S("SELECT name FROM products WHERE category_id IN (SELECT _id FROM categories WHERE active = TRUE)",
      'db.products.aggregate([\n  { $lookup: { from: "categories",\n               pipeline: [{ $match: { active: true } },\n                          { $project: { _id: 1 } }],\n               as: "_sub1" } },\n  { $match: { $expr: { $in: ["$category_id", "$_sub1._id"] } } },\n  { $unset: "_sub1" },\n  { $project: { name: 1, _id: 0 } }\n])'),
    S('SELECT day, amount, LAG(amount) OVER (ORDER BY day) AS prev FROM sales',
      'db.sales.aggregate([\n  {\n    $setWindowFields: {\n      sortBy: { day: 1 },\n      output: { prev: { $shift: { output: "$amount", by: -1, default: null } } }\n    }\n  },\n  { $project: { day: 1, amount: 1, prev: 1, _id: 0 } }\n])'),
    S('SELECT city FROM customers UNION ALL SELECT city FROM suppliers',
      'db.customers.aggregate([\n  { $project: { city: 1, _id: 0 } },\n  { $unionWith: { coll: "suppliers",\n                  pipeline: [{ $project: { city: 1, _id: 0 } }] } }\n])'),
    S("INSERT INTO users (email, name, visits) VALUES ('a@x.com', 'Ann', 1) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, visits = users.visits + 1",
      'db.users.updateOne({ email: "a@x.com" }, { $set: { name: "Ann" }, $inc: { visits: 1 } }, { upsert: true })'),
    S("SELECT * FROM posts WHERE 'mongo' = ANY(tags) AND tags @> ARRAY['db', 'nosql'] AND CARDINALITY(tags) = 3",
      'db.posts.find({\n  $and: [{ tags: "mongo" }, { tags: { $all: ["db", "nosql"] } },\n         { tags: { $size: 3 } }]\n})'),

    M('db.orders.aggregate([{ $group: { _id: "$customerId", total: { $sum: "$amount" } } }, { $group: { _id: null, avgTotal: { $avg: "$total" } } }])',
      'SELECT AVG(total) AS avgTotal\nFROM (\n  SELECT customerId, SUM(amount) AS total\n  FROM orders\n  GROUP BY customerId\n) AS t1;'),
    M('db.orders.aggregate([{ $unwind: "$items" }, { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" } } }, { $sort: { qty: -1 } }, { $limit: 3 }])',
      'SELECT item.sku AS sku, SUM(item.qty) AS qty\nFROM orders\nCROSS JOIN UNNEST(items) AS item\nGROUP BY item.sku\nORDER BY qty DESC\nLIMIT 3;'),
    M('db.users.find({ tags: { $all: ["a", "b"] }, roles: { $size: 2 } })',
      "SELECT *\nFROM users\nWHERE tags @> ARRAY['a', 'b'] AND CARDINALITY(roles) = 2;"),
    M('db.users.updateOne({ email: "a@x.com" }, { $set: { name: "Ann" }, $inc: { visits: 1 } }, { upsert: true })',
      "MERGE INTO users\nUSING (SELECT 1) AS src\nON email = 'a@x.com'\nWHEN MATCHED THEN\n  UPDATE SET name = 'Ann',\n             visits = visits + 1\nWHEN NOT MATCHED THEN\n  INSERT (email, name, visits)\n  VALUES ('a@x.com', 'Ann', 1);"),
    M('db.orders.aggregate([{ $sort: { date: 1 } }, { $group: { _id: "$customer", first: { $first: "$date" } } }])',
      'SELECT customer, (ARRAY_AGG(date ORDER BY date ASC))[1] AS first\nFROM orders\nGROUP BY customer;'),
  ],

  schema: [
    S('CREATE UNIQUE INDEX idx_email ON users (email, created_at DESC)',
      'db.users.createIndex({ email: 1, created_at: -1 }, { name: "idx_email", unique: true })'),
    S('DROP TABLE IF EXISTS tmp', 'db.tmp.drop()'),
    S('TRUNCATE TABLE logs', 'db.logs.deleteMany({})'),
    S('ALTER TABLE users RENAME COLUMN fname TO first_name', 'db.users.updateMany({}, { $rename: { fname: "first_name" } })'),
    M('db.users.createIndex({ email: 1, createdAt: -1 }, { unique: true })',
      'CREATE UNIQUE INDEX users_email_createdAt_idx ON users (email, createdAt DESC);'),
    M('db.createCollection("users", { validator: { $jsonSchema: { bsonType: "object", required: ["email"], properties: { email: { bsonType: "string", maxLength: 255 }, age: { bsonType: "int", minimum: 0 } } } } })',
      'CREATE TABLE users (\n  _id CHAR(24) PRIMARY KEY,\n  email VARCHAR(255) NOT NULL,\n  age INTEGER CHECK (age >= 0)\n);'),
    M('db.users.drop()', 'DROP TABLE users;'),
    M('session.startTransaction(); db.a.deleteMany({ x: 1 }); session.commitTransaction()', 'BEGIN;\n\nDELETE FROM a\nWHERE x = 1;\n\nCOMMIT;'),
  ],
};

// ---------------------------------------------------------------- must translate (and round-trip back)

const coverage = {
  sql: [
    // basic
    'SELECT id, name FROM users WHERE id = 5',
    "SELECT * FROM users WHERE email LIKE '%@gmail.com' AND name NOT LIKE 'test%'",
    'SELECT * FROM users WHERE age NOT BETWEEN 18 AND 65',
    "SELECT * FROM users WHERE city IN ('Paris', 'Rome') ORDER BY age DESC, name LIMIT 5 OFFSET 10",
    'SELECT * FROM users WHERE deleted_at IS NULL',
    'SELECT TOP 3 * FROM users',
    'SELECT * FROM users FETCH FIRST 3 ROWS ONLY',
    "INSERT INTO users (name, tags) VALUES ('A', ARRAY['x', 'y']), ('B', ARRAY['z'])",
    "UPDATE users SET verified = TRUE WHERE email = 'a@b.c' LIMIT 1",
    'DELETE FROM users WHERE id = 3 LIMIT 1',
    // intermediate
    'SELECT city, COUNT(*) AS n, AVG(age) AS avg_age, MIN(age), MAX(age) FROM users GROUP BY city HAVING COUNT(*) > 10',
    'SELECT COUNT(DISTINCT city) AS cities FROM users',
    'SELECT category, COUNT(DISTINCT brand) AS brands FROM products GROUP BY category',
    'SELECT UPPER(name) AS n, LENGTH(name) AS len, SUBSTRING(name, 1, 3) AS short, COALESCE(nick, name) AS shown FROM users',
    "SELECT name, CONCAT(first, ' ', last) AS full_name, ROUND(price, 2) AS p FROM people",
    'SELECT EXTRACT(YEAR FROM created_at) AS yr, COUNT(*) AS n FROM orders GROUP BY EXTRACT(YEAR FROM created_at) ORDER BY yr',
    "SELECT DATE_TRUNC('month', created_at) AS m, SUM(total) AS revenue FROM orders GROUP BY DATE_TRUNC('month', created_at)",
    'SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON o.customer_id = c._id',
    'SELECT * FROM orders o JOIN customers c USING (customer_id)',
    'SELECT * FROM orders o RIGHT JOIN customers c ON o.customer_id = c._id',
    'SELECT u.name, o.total FROM users u, orders o WHERE u._id = o.user_id',
    'SELECT * FROM a CROSS JOIN b',
    "SELECT * FROM users WHERE name REGEXP '^[A-Z]' OR REGEXP_LIKE(email, 'test', 'i')",
    "SELECT * FROM users WHERE name ILIKE 'ann%'",
    'SELECT * FROM users WHERE active IS TRUE',
    "SELECT * FROM events WHERE day >= DATE '2024-01-01'",
    // advanced
    'SELECT name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u._id) AS order_count FROM users u',
    'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u._id AND o.total > 100)',
    'SELECT * FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u._id)',
    'SELECT name, price FROM products WHERE price > (SELECT AVG(price) FROM products)',
    'SELECT * FROM products WHERE id NOT IN (SELECT product_id FROM sales)',
    'WITH big AS (SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id HAVING SUM(total) > 1000) SELECT c.name, b.spent FROM big b JOIN customers c ON c._id = b.customer_id ORDER BY b.spent DESC',
    'WITH a AS (SELECT * FROM t WHERE x > 1), b AS (SELECT * FROM a WHERE y < 5) SELECT COUNT(*) AS n FROM b',
    'SELECT * FROM (SELECT dept, AVG(salary) AS avg_sal FROM employees GROUP BY dept) t WHERE t.avg_sal > 5000',
    'SELECT name, RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rnk, SUM(salary) OVER (PARTITION BY dept) AS dept_total FROM employees',
    'SELECT day, SUM(amount) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS week_total, ROW_NUMBER() OVER (ORDER BY day) AS n FROM sales',
    'SELECT name, DENSE_RANK() OVER (ORDER BY score DESC) AS place, LEAD(score, 1, 0) OVER (ORDER BY score DESC) AS next_score FROM players',
    'SELECT city FROM customers UNION SELECT city FROM suppliers ORDER BY city',
    "SELECT dept, STRING_AGG(name, ', ' ORDER BY name) AS names, ARRAY_AGG(id) AS ids FROM employees GROUP BY dept",
    "SELECT customer, (ARRAY_AGG(day ORDER BY day ASC))[1] AS first_day FROM orders GROUP BY customer",
    'SELECT e.name, m.name AS manager FROM employees e LEFT JOIN employees m ON e.manager_id = m._id AND m.active = TRUE',
    'SELECT u.name, lo.total FROM users u LEFT JOIN LATERAL (SELECT total FROM orders o WHERE o.user_id = u._id ORDER BY created_at DESC LIMIT 1) AS lo ON TRUE',
    'SELECT p.title, tag FROM posts p CROSS JOIN UNNEST(p.tags) AS tag WHERE tag LIKE \'db%\'',
    'SELECT * FROM users WHERE EXISTS (SELECT 1 FROM UNNEST(scores) AS s WHERE s >= 80 AND s < 90)',
    "SELECT * FROM docs WHERE to_tsvector(body) @@ plainto_tsquery('coffee shop')",
    "SELECT * FROM docs WHERE MATCH (title, body) AGAINST ('coffee')",
    'SELECT name, DATEDIFF(NOW(), created_at) AS age_days, GREATEST(a, b) AS hi, NULLIF(x, 0) AS nz FROM t',
    "UPDATE posts SET tags = ARRAY_APPEND(tags, 'new') WHERE _id = 1",
    'UPDATE products SET total = price * qty, label = UPPER(name) WHERE id = 5',
    "INSERT INTO archive (id, total) SELECT _id, total FROM orders WHERE status = 'done'",
    "INSERT INTO users (email, name) VALUES ('a@x.com', 'A') ON CONFLICT (email) DO NOTHING",
    "MERGE INTO users USING (SELECT 1) AS s ON email = 'a@x.com' WHEN MATCHED THEN UPDATE SET visits = visits + 1 WHEN NOT MATCHED THEN INSERT (email, visits) VALUES ('a@x.com', 1)",
    "UPDATE users SET status = 'x' WHERE id = 1 RETURNING *",
    'EXPLAIN SELECT * FROM users WHERE age > 30',
    'BEGIN; UPDATE accounts SET balance = balance - 100 WHERE _id = 1; UPDATE accounts SET balance = balance + 100 WHERE _id = 2; COMMIT;',
    // schema / admin
    "CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, age INT CHECK (age >= 0 AND age < 150), role VARCHAR(10) CHECK (role IN ('admin', 'user')), tags TEXT[], created_at TIMESTAMP DEFAULT NOW())",
    'CREATE INDEX idx_active ON users (last_login) WHERE active = TRUE',
    'CREATE VIEW active_users AS SELECT name, email FROM users WHERE active = TRUE',
    'CREATE TABLE top_customers AS SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id',
    "ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active', DROP COLUMN legacy",
    'ALTER TABLE users RENAME TO customers',
    'DROP INDEX idx_email ON users',
    'USE shop',
    'SHOW TABLES',
  ],
  mongo: [
    // basic
    'db.users.find()',
    'db.users.findOne({ email: "a@b.c" })',
    'db.users.find({ age: { $in: [20, 30] }, name: { $exists: true } }).skip(20).limit(10)',
    'db.users.find({ $nor: [{ a: 1 }, { b: 2 }] })',
    'db.users.find({ name: { $not: /^test/ } })',
    'db.users.find({ email: /@gmail\\.com$/i })',
    'db.users.find({}, { name: 1 }).sort({ age: -1 })',
    'db.users.find({ age: { $gt: 30 } }).count()',
    'db.users.distinct("city", { active: true })',
    'db.users.insertOne({ name: "Ada", age: 36, tags: ["admin"], address: { city: "London" } })',
    'db.users.updateMany({ age: { $lt: 18 } }, { $set: { minor: true }, $unset: { legacy: "" } })',
    'db.users.replaceOne({ _id: 1 }, { name: "B", age: 2 })',
    'db.users.deleteOne({ _id: ObjectId("507f1f77bcf86cd799439011") })',
    'db.getCollection("app.logs").find({ level: "error" })',
    // intermediate
    'db.orders.aggregate([{ $match: { status: "A" } }, { $group: { _id: { cust: "$cust_id", day: "$day" }, total: { $sum: "$amount" }, n: { $count: {} } } }, { $sort: { total: -1 } }])',
    'db.orders.aggregate([{ $project: { _id: 0, item: 1, total: { $multiply: ["$price", "$qty"] }, big: { $gte: ["$qty", 10] } } }])',
    'db.users.aggregate([{ $addFields: { fullName: { $concat: ["$first", " ", "$last"] } } }, { $match: { fullName: /Ann/ } }])',
    'db.orders.aggregate([{ $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } }])',
    'db.orders.aggregate([{ $count: "total" }])',
    'db.orders.aggregate([{ $sortByCount: "$status" }])',
    'db.orders.aggregate([{ $sample: { size: 5 } }])',
    'db.orders.aggregate([{ $project: { y: { $year: "$date" }, label: { $switch: { branches: [{ case: { $gt: ["$total", 100] }, then: "big" }], default: "small" } }, n: { $toInt: "$qty" } } }])',
    // advanced
    'db.orders.aggregate([{ $sort: { createdAt: -1 } }, { $limit: 100 }, { $match: { status: "open" } }, { $count: "openRecent" }])',
    'db.employees.aggregate([{ $setWindowFields: { partitionBy: "$dept", sortBy: { salary: -1 }, output: { rnk: { $rank: {} }, running: { $sum: "$salary", window: { documents: ["unbounded", "current"] } } } } }, { $match: { rnk: { $lte: 3 } } }])',
    'db.products.aggregate([{ $facet: { byCategory: [{ $sortByCount: "$category" }], priceStats: [{ $group: { _id: null, avg: { $avg: "$price" } } }] } }])',
    'db.sales.aggregate([{ $bucket: { groupBy: "$price", boundaries: [0, 50, 100], default: "Other" } }])',
    'db.users.aggregate([{ $lookup: { from: "orders", let: { uid: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$userId", "$$uid"] } } }, { $sort: { createdAt: -1 } }, { $limit: 1 }], as: "lastOrder" } }, { $unwind: { path: "$lastOrder", preserveNullAndEmptyArrays: true } }])',
    'db.orders.aggregate([{ $lookup: { from: "customers", localField: "cid", foreignField: "_id", as: "c" } }, { $unwind: "$c" }, { $replaceRoot: { newRoot: "$c" } }])',
    'db.a.aggregate([{ $project: { _id: 0, name: 1 } }, { $unionWith: { coll: "b", pipeline: [{ $project: { _id: 0, name: 1 } }] } }, { $sort: { name: 1 } }])',
    'db.orders.aggregate([{ $match: { status: "done" } }, { $group: { _id: { y: { $year: "$date" } }, revenue: { $sum: "$total" } } }, { $out: "yearly" }])',
    'db.orders.aggregate([{ $group: { _id: "$dept", names: { $push: "$name" } } }, { $project: { n: { $size: "$names" } } }])',
    'db.posts.aggregate([{ $unwind: { path: "$tags", includeArrayIndex: "pos" } }, { $match: { pos: 0 } }])',
    'db.users.find({ scores: { $elemMatch: { $gte: 80, $lt: 90 } }, items: { $elemMatch: { sku: "x", qty: { $gt: 2 } } } })',
    'db.users.updateOne({ email: "a@x.com" }, { $set: { name: "Ann" }, $setOnInsert: { createdAt: new Date() } }, { upsert: true })',
    'db.users.updateMany({}, { $push: { tags: { $each: ["a", "b"] } }, $addToSet: { roles: "user" } })',
    'db.users.updateMany({}, { $rename: { fname: "firstName" } })',
    'db.users.updateMany({}, [{ $set: { total: { $add: ["$a", "$b"] } } }])',
    'db.users.findOneAndUpdate({ _id: 1 }, { $inc: { n: 1 } })',
    'db.users.bulkWrite([{ insertOne: { document: { name: "A" } } }, { updateOne: { filter: { name: "B" }, update: { $set: { x: 1 } } } }, { deleteMany: { filter: { active: false } } }])',
    'db.users.find({ $text: { $search: "coffee" } })',
    // schema / admin
    'db.users.createIndex({ bio: "text" })',
    'db.users.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 })',
    'db.users.dropIndex("users_email_idx")',
    'db.users.getIndexes()',
    'db.createView("adults", "users", [{ $match: { age: { $gte: 18 } } }])',
    'db.createCollection("logs")',
    'db.users.renameCollection("customers")',
    'use shop',
  ],
};

// ---------------------------------------------------------------- optimizations

// Group before joining, filter before joining, and leave LEFT JOINs (which keep unmatched rows) alone.
exact.optimized = [
  S('SELECT s.customerId, c.customerName, SUM(s.shippingCost) AS Total_Cost FROM customers c JOIN shipments s ON c.customerId = s.customerId WHERE s.shippingCost IS NOT NULL GROUP BY s.customerId, c.customerName HAVING SUM(s.shippingCost) > 200 ORDER BY Total_Cost DESC',
    'db.shipments.aggregate([\n  { $match: { shippingCost: { $ne: null } } },\n  { $group: { _id: "$customerId", Total_Cost: { $sum: "$shippingCost" } } },\n  { $match: { Total_Cost: { $gt: 200 } } },\n  { $lookup: { from: "customers", localField: "_id", foreignField: "customerId",\n               as: "c" } },\n  { $unwind: "$c" },\n  { $sort: { Total_Cost: -1 } },\n  { $project: { _id: 0, customerId: "$_id", customerName: "$c.customerName",\n                Total_Cost: 1 } }\n])'),
  S('SELECT d.departmentId, d.departmentName, COUNT(*) AS studentCount FROM students s JOIN departments d ON s.departmentId = d.departmentId GROUP BY d.departmentId, d.departmentName HAVING COUNT(*) > 2',
    'db.students.aggregate([\n  { $group: { _id: "$departmentId", studentCount: { $sum: 1 } } },\n  { $match: { studentCount: { $gt: 2 } } },\n  { $lookup: { from: "departments", localField: "_id",\n               foreignField: "departmentId", as: "d" } },\n  { $unwind: "$d" },\n  { $project: { _id: 0, departmentId: "$_id",\n                departmentName: "$d.departmentName", studentCount: 1 } }\n])'),
  S('SELECT o.id, c.name FROM orders o JOIN customers c ON o.cid = c._id WHERE o.total > 100 AND c.active = TRUE',
    'db.orders.aggregate([\n  { $match: { total: { $gt: 100 } } },\n  { $lookup: { from: "customers", localField: "cid", foreignField: "_id",\n               as: "c" } },\n  { $unwind: "$c" },\n  { $match: { "c.active": true } },\n  { $project: { id: 1, "c.name": 1, _id: 0 } }\n])'),
  S('SELECT c.region, SUM(o.total) AS t FROM orders o LEFT JOIN customers c ON o.cid = c._id GROUP BY o.cid, c.region',
    'db.orders.aggregate([\n  { $lookup: { from: "customers", localField: "cid", foreignField: "_id",\n               as: "c" } },\n  { $unwind: { path: "$c", preserveNullAndEmptyArrays: true } },\n  { $group: { _id: { cid: "$cid", region: "$c.region" }, t: { $sum: "$total" } } },\n  { $project: { _id: 0, region: "$_id.region", t: 1 } }\n])'),
];

// ---------------------------------------------------------------- clear errors for unsupported input

const errors = [
  [SqlToMongo, 'SELECT name, COUNT(*) FROM users GROUP BY city'],
  [SqlToMongo, 'INSERT INTO users VALUES (1, 2)'],
  [SqlToMongo, 'SELECT * FROM a FULL OUTER JOIN b ON a.x = b.x'],
  [SqlToMongo, 'WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t'],
  [SqlToMongo, 'SELECT * FROM a INTERSECT SELECT * FROM b'],
  [SqlToMongo, 'SELECT FROM'],
  [MongoToSql, 'users.find()'],
  [MongoToSql, 'db.users.find({ $where: "this.a > 1" })'],
  [MongoToSql, 'db.users.aggregate([{ $graphLookup: { from: "x" } }])'],
  [MongoToSql, 'db.users.find({ a: { $type: "string" } })'],
  [MongoToSql, 'db.users.find({'],
];

// ---------------------------------------------------------------- run

let failed = 0, total = 0;
const check = (name, fn) => {
  total++;
  try { fn(); } catch (e) { failed++; console.error(`✗ ${name}\n${e.message}\n`); }
};

for (const [level, cases] of Object.entries(exact)) {
  for (const [T, input, expected] of cases) check(`[${level}] ${input}`, () => assert.strictEqual(T.translate(input).output, expected));
}

// Every query must translate, and its translation must translate back without errors.
for (const sql of coverage.sql) {
  check(`[sql → mongo → sql] ${sql}`, () => {
    const mongo = SqlToMongo.translate(sql).output;
    if (/^(db\.|use |show |const session|session\.)/.test(mongo) && !/^session\./.test(mongo)) MongoToSql.translate(mongo);
  });
}
for (const mongo of coverage.mongo) {
  check(`[mongo → sql → mongo] ${mongo}`, () => SqlToMongo.translate(MongoToSql.translate(mongo).output));
}

// Translating to the other side and back should give the same result again.
const stable = [
  "SELECT department, COUNT(*) AS employees, AVG(salary) AS avg_salary FROM staff WHERE hired > '2020-01-01' GROUP BY department HAVING COUNT(*) > 5 ORDER BY avg_salary DESC",
  'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON o.customer_id = c._id WHERE o.total > 100',
  "UPDATE users SET status = 'x', n = n + 2 WHERE age BETWEEN 1 AND 9",
  "SELECT * FROM users WHERE name LIKE 'A%' AND age IN (1, 2) ORDER BY age DESC LIMIT 5",
];
for (const sql of stable) {
  check(`[stable] ${sql}`, () => {
    const mongo = SqlToMongo.translate(sql).output;
    const back = MongoToSql.translate(mongo).output;
    assert.strictEqual(SqlToMongo.translate(back).output, mongo);
  });
}

for (const [T, input] of errors) check(`[error] ${input}`, () => assert.throws(() => T.translate(input), T.TranslateError));

console.log(`${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
