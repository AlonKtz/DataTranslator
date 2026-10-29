(function () {
  'use strict';

  const EXAMPLES = [
    // SQL
    { group: 'SQL · Basic', label: 'Filter, sort and limit', code: "SELECT name, email\nFROM users\nWHERE age >= 18 AND status = 'active'\nORDER BY name\nLIMIT 10;" },
    { group: 'SQL · Basic', label: 'LIKE, IN, BETWEEN, IS NULL', code: "SELECT *\nFROM products\nWHERE (name LIKE 'Pro%' OR category IN ('tools', 'garden'))\n  AND price BETWEEN 10 AND 50\n  AND deleted_at IS NULL;" },
    { group: 'SQL · Basic', label: 'INSERT / UPDATE / DELETE', code: "INSERT INTO users (name, age, city)\nVALUES ('Ada', 36, 'London'), ('Linus', 28, 'Helsinki');\n\nUPDATE users\nSET status = 'inactive', login_count = login_count + 1\nWHERE last_login < '2024-01-01';\n\nDELETE FROM sessions WHERE expires_at < NOW();" },
    { group: 'SQL · Intermediate', label: 'GROUP BY with HAVING', code: "SELECT department, COUNT(*) AS employees, AVG(salary) AS avg_salary\nFROM staff\nWHERE hired > '2020-01-01'\nGROUP BY department\nHAVING COUNT(*) > 5\nORDER BY avg_salary DESC;" },
    { group: 'SQL · Intermediate', label: 'JOINs (INNER, LEFT)', code: "SELECT o.id, o.total, c.name, s.status\nFROM orders o\nJOIN customers c ON o.customer_id = c._id\nLEFT JOIN shipments s ON s.order_id = o._id\nWHERE o.total > 100;" },
    { group: 'SQL · Intermediate', label: 'CASE, CAST and functions', code: "SELECT name,\n       UPPER(city) AS city,\n       CAST(price AS INT) AS whole_price,\n       CASE WHEN age < 18 THEN 'minor' WHEN age < 65 THEN 'adult' ELSE 'senior' END AS bracket,\n       EXTRACT(YEAR FROM created_at) AS joined\nFROM users;" },
    { group: 'SQL · Intermediate', label: 'Dates and intervals', code: "SELECT DATE_TRUNC('month', created_at) AS month, SUM(total) AS revenue\nFROM orders\nWHERE created_at > NOW() - INTERVAL '90 days'\nGROUP BY DATE_TRUNC('month', created_at)\nORDER BY month;" },
    { group: 'SQL · Advanced', label: 'Correlated subqueries', code: "SELECT name,\n       (SELECT COUNT(*) FROM orders o WHERE o.user_id = u._id) AS order_count\nFROM users u\nWHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u._id AND o.total > 100);" },
    { group: 'SQL · Advanced', label: 'CTE (WITH) + JOIN', code: "WITH big_spenders AS (\n  SELECT customer_id, SUM(total) AS spent\n  FROM orders\n  GROUP BY customer_id\n  HAVING SUM(total) > 1000\n)\nSELECT c.name, b.spent\nFROM big_spenders b\nJOIN customers c ON c._id = b.customer_id\nORDER BY b.spent DESC;" },
    { group: 'SQL · Advanced', label: 'Window functions', code: "SELECT name, dept, salary,\n       RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS rank_in_dept,\n       SUM(salary) OVER (PARTITION BY dept) AS dept_total,\n       LAG(salary) OVER (ORDER BY hired) AS prev_hire_salary\nFROM employees;" },
    { group: 'SQL · Advanced', label: 'UNION', code: "SELECT city FROM customers\nUNION\nSELECT city FROM suppliers\nORDER BY city;" },
    { group: 'SQL · Advanced', label: 'Arrays (PostgreSQL)', code: "SELECT p.title, tag\nFROM posts p\nCROSS JOIN UNNEST(p.tags) AS tag\nWHERE 'mongodb' = ANY(p.tags);" },
    { group: 'SQL · Advanced', label: 'Upsert (ON CONFLICT)', code: "INSERT INTO users (email, name, visits)\nVALUES ('ann@example.com', 'Ann', 1)\nON CONFLICT (email) DO UPDATE\nSET name = EXCLUDED.name, visits = users.visits + 1;" },
    { group: 'SQL · Schema', label: 'CREATE TABLE', code: "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  age INT CHECK (age >= 0),\n  role VARCHAR(10) CHECK (role IN ('admin', 'user')),\n  created_at TIMESTAMP DEFAULT NOW()\n);" },
    { group: 'SQL · Schema', label: 'Index, view, ALTER', code: "CREATE UNIQUE INDEX idx_users_email ON users (email);\n\nCREATE VIEW active_users AS\nSELECT name, email FROM users WHERE active = TRUE;\n\nALTER TABLE users RENAME COLUMN fname TO first_name;" },
    { group: 'SQL · Schema', label: 'Transaction', code: "BEGIN;\nUPDATE accounts SET balance = balance - 100 WHERE _id = 1;\nUPDATE accounts SET balance = balance + 100 WHERE _id = 2;\nCOMMIT;" },
    // MongoDB
    { group: 'MongoDB · Basic', label: 'find with projection', code: 'db.users.find(\n  { age: { $gte: 18 }, status: "active" },\n  { name: 1, email: 1, _id: 0 }\n).sort({ name: 1 }).limit(10)' },
    { group: 'MongoDB · Basic', label: '$or, $in, regex, $exists', code: 'db.products.find({\n  $or: [{ name: /^Pro/ }, { category: { $in: ["tools", "garden"] } }],\n  price: { $gte: 10, $lte: 50 },\n  deletedAt: { $exists: false }\n})' },
    { group: 'MongoDB · Basic', label: 'insert / update / delete', code: 'db.users.insertOne({ name: "Ada", age: 36, city: "London" })\n\ndb.users.updateMany(\n  { lastLogin: { $lt: ISODate("2024-01-01") } },\n  { $set: { status: "inactive" }, $inc: { loginCount: 1 } }\n)\n\ndb.sessions.deleteMany({ expiresAt: { $lt: new Date() } })' },
    { group: 'MongoDB · Intermediate', label: 'aggregate: $match → $group', code: 'db.orders.aggregate([\n  { $match: { status: "shipped" } },\n  { $group: { _id: "$customerId", total: { $sum: "$amount" }, orders: { $sum: 1 } } },\n  { $match: { total: { $gt: 500 } } },\n  { $sort: { total: -1 } },\n  { $limit: 5 }\n])' },
    { group: 'MongoDB · Intermediate', label: '$lookup (join)', code: 'db.orders.aggregate([\n  { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "c" } },\n  { $unwind: "$c" },\n  { $project: { _id: 0, id: 1, total: 1, "c.name": 1 } }\n])' },
    { group: 'MongoDB · Intermediate', label: 'Computed fields', code: 'db.orders.aggregate([\n  { $project: {\n      item: 1,\n      total: { $multiply: ["$price", "$qty"] },\n      size: { $cond: [{ $gte: ["$qty", 10] }, "bulk", "single"] },\n      day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }\n  } }\n])' },
    { group: 'MongoDB · Advanced', label: '$unwind arrays', code: 'db.orders.aggregate([\n  { $unwind: "$items" },\n  { $group: { _id: "$items.sku", sold: { $sum: "$items.qty" } } },\n  { $sort: { sold: -1 } },\n  { $limit: 3 }\n])' },
    { group: 'MongoDB · Advanced', label: '$lookup with pipeline', code: 'db.users.aggregate([\n  { $lookup: {\n      from: "orders",\n      let: { uid: "$_id" },\n      pipeline: [\n        { $match: { $expr: { $eq: ["$userId", "$$uid"] } } },\n        { $sort: { createdAt: -1 } },\n        { $limit: 1 }\n      ],\n      as: "lastOrder"\n  } },\n  { $unwind: { path: "$lastOrder", preserveNullAndEmptyArrays: true } },\n  { $project: { name: 1, lastTotal: "$lastOrder.total" } }\n])' },
    { group: 'MongoDB · Advanced', label: '$setWindowFields', code: 'db.employees.aggregate([\n  { $setWindowFields: {\n      partitionBy: "$dept",\n      sortBy: { salary: -1 },\n      output: {\n        rank: { $rank: {} },\n        running: { $sum: "$salary", window: { documents: ["unbounded", "current"] } }\n      }\n  } },\n  { $match: { rank: { $lte: 3 } } }\n])' },
    { group: 'MongoDB · Advanced', label: '$facet and $bucket', code: 'db.products.aggregate([\n  { $facet: {\n      byCategory: [{ $sortByCount: "$category" }],\n      byPrice: [{ $bucket: { groupBy: "$price", boundaries: [0, 50, 100, 500], default: "500+" } }]\n  } }\n])' },
    { group: 'MongoDB · Advanced', label: 'Array queries & updates', code: 'db.users.find({\n  tags: { $all: ["mongodb", "sql"] },\n  scores: { $elemMatch: { $gte: 80, $lt: 90 } }\n})\n\ndb.users.updateMany({}, { $push: { tags: "new" }, $pull: { tags: "old" } })' },
    { group: 'MongoDB · Advanced', label: 'Upsert', code: 'db.users.updateOne(\n  { email: "ann@example.com" },\n  { $set: { name: "Ann" }, $inc: { visits: 1 }, $setOnInsert: { createdAt: new Date() } },\n  { upsert: true }\n)' },
    { group: 'MongoDB · Schema', label: 'createCollection with schema', code: 'db.createCollection("users", {\n  validator: { $jsonSchema: {\n    bsonType: "object",\n    required: ["email"],\n    properties: {\n      email: { bsonType: "string", maxLength: 255 },\n      age: { bsonType: "int", minimum: 0 },\n      role: { enum: ["admin", "user"] }\n    }\n  } }\n})' },
    { group: 'MongoDB · Schema', label: 'Indexes and views', code: 'db.users.createIndex({ email: 1 }, { unique: true })\n\ndb.users.createIndex({ bio: "text" })\n\ndb.createView("adults", "users", [{ $match: { age: { $gte: 18 } } }])' },
    { group: 'MongoDB · Schema', label: 'Transaction', code: 'const session = db.getMongo().startSession()\nsession.startTransaction()\ndb.accounts.updateOne({ _id: 1 }, { $inc: { balance: -100 } })\ndb.accounts.updateOne({ _id: 2 }, { $inc: { balance: 100 } })\nsession.commitTransaction()' },
  ];

  const STORAGE_KEY = 'nosqlearn.input';
  const $ = (id) => document.getElementById(id);
  const input = $('input'), output = $('output'), errorBox = $('error');
  const notesBox = $('notes'), notesList = notesBox.querySelector('ul');
  const examples = $('examples');

  // Strip leading whitespace/comments, then look for something only the MongoDB shell starts with.
  function detect(src) {
    const s = src.replace(/^(\s+|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, '');
    return /^(db\s*[.[]|session\.|(const|let|var)\s+\w+\s*=|show\s+(collections|dbs)\b)/.test(s) ? 'mongo' : 'sql';
  }

  function direction() {
    const v = document.querySelector('input[name="dir"]:checked').value;
    return v === 'auto' ? detect(input.value) : v;
  }

  function renderNotes(notes) {
    notesList.replaceChildren(...notes.map((n) => { const li = document.createElement('li'); li.textContent = n; return li; }));
    notesBox.hidden = notes.length === 0;
  }

  function run() {
    const src = input.value;
    try { localStorage.setItem(STORAGE_KEY, src); } catch (e) { /* storage unavailable */ }
    const dir = direction();
    $('input-label').textContent = dir === 'mongo' ? 'MongoDB' : 'SQL';
    $('output-label').textContent = dir === 'mongo' ? 'SQL' : 'MongoDB';
    errorBox.hidden = true;
    if (!src.trim()) { output.textContent = ''; renderNotes([]); return; }
    const translator = dir === 'mongo' ? window.MongoToSql : window.SqlToMongo;
    try {
      const result = translator.translate(src);
      output.textContent = result.output;
      renderNotes(result.notes);
    } catch (e) {
      if (!(e instanceof translator.TranslateError)) console.error(e);
      output.textContent = '';
      errorBox.textContent = e.message;
      errorBox.hidden = false;
      renderNotes([]);
    }
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, 200); };

  // Examples dropdown, grouped by language and level.
  for (const group of [...new Set(EXAMPLES.map((ex) => ex.group))]) {
    const og = document.createElement('optgroup');
    og.label = group;
    EXAMPLES.forEach((ex, i) => {
      if (ex.group !== group) return;
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = ex.label;
      og.appendChild(opt);
    });
    examples.appendChild(og);
  }
  examples.addEventListener('change', () => {
    if (examples.value === '') return;
    input.value = EXAMPLES[Number(examples.value)].code;
    examples.value = '';
    document.querySelector('input[name="dir"][value="auto"]').checked = true;
    run();
    input.focus();
  });

  input.addEventListener('input', schedule);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clearTimeout(timer); run(); }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
      schedule();
    }
  });
  document.querySelectorAll('input[name="dir"]').forEach((r) => r.addEventListener('change', run));

  $('clear').addEventListener('click', () => { input.value = ''; run(); input.focus(); });

  $('swap').addEventListener('click', () => {
    if (!output.textContent) return;
    input.value = output.textContent;
    document.querySelector('input[name="dir"][value="auto"]').checked = true;
    run();
  });

  $('copy').addEventListener('click', async () => {
    const btn = $('copy');
    if (!output.textContent) return;
    try {
      await navigator.clipboard.writeText(output.textContent);
      btn.textContent = 'Copied!';
    } catch (e) {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });

  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }
  input.value = saved != null && saved.trim() ? saved : EXAMPLES[0].code;
  run();
})();
