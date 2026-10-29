(function () {
  'use strict';

  const EXAMPLES = [
    { group: 'SQL', label: 'Filter, sort and limit', code: "SELECT name, email\nFROM users\nWHERE age >= 18 AND status = 'active'\nORDER BY name\nLIMIT 10;" },
    { group: 'SQL', label: 'LIKE, OR and BETWEEN', code: "SELECT *\nFROM products\nWHERE name LIKE 'Pro%' OR price BETWEEN 10 AND 50;" },
    { group: 'SQL', label: 'GROUP BY with HAVING', code: "SELECT department, COUNT(*) AS employees, AVG(salary) AS avg_salary\nFROM staff\nWHERE hired > '2020-01-01'\nGROUP BY department\nHAVING COUNT(*) > 5\nORDER BY avg_salary DESC;" },
    { group: 'SQL', label: 'JOIN', code: "SELECT o.id, o.total, c.name\nFROM orders o\nJOIN customers c ON o.customer_id = c._id\nWHERE o.total > 100;" },
    { group: 'SQL', label: 'INSERT rows', code: "INSERT INTO users (name, age, city)\nVALUES ('Ada', 36, 'London'), ('Linus', 28, 'Helsinki');" },
    { group: 'SQL', label: 'UPDATE', code: "UPDATE users\nSET status = 'inactive', login_count = login_count + 1\nWHERE last_login < '2024-01-01';" },
    { group: 'SQL', label: 'DELETE', code: 'DELETE FROM sessions WHERE expires_at < NOW();' },
    { group: 'MongoDB', label: 'find with projection', code: 'db.users.find(\n  { age: { $gte: 18 }, status: "active" },\n  { name: 1, email: 1, _id: 0 }\n).sort({ name: 1 }).limit(10)' },
    { group: 'MongoDB', label: '$or with regex', code: 'db.products.find({\n  $or: [{ name: /^Pro/ }, { price: { $gte: 10, $lte: 50 } }]\n})' },
    { group: 'MongoDB', label: 'aggregate pipeline', code: 'db.orders.aggregate([\n  { $match: { status: "shipped" } },\n  { $group: { _id: "$customerId", total: { $sum: "$amount" }, orders: { $sum: 1 } } },\n  { $match: { total: { $gt: 500 } } },\n  { $sort: { total: -1 } },\n  { $limit: 5 }\n])' },
    { group: 'MongoDB', label: '$lookup (join)', code: 'db.orders.aggregate([\n  { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "c" } },\n  { $unwind: "$c" },\n  { $project: { _id: 0, id: 1, total: 1, "c.name": 1 } }\n])' },
    { group: 'MongoDB', label: 'insertOne', code: 'db.users.insertOne({ name: "Ada", age: 36, city: "London" })' },
    { group: 'MongoDB', label: 'updateMany', code: 'db.users.updateMany(\n  { lastLogin: { $lt: ISODate("2024-01-01") } },\n  { $set: { status: "inactive" }, $inc: { loginCount: 1 } }\n)' },
    { group: 'MongoDB', label: 'deleteMany', code: 'db.sessions.deleteMany({ expiresAt: { $exists: false } })' },
  ];

  const STORAGE_KEY = 'nosqlearn.input';
  const $ = (id) => document.getElementById(id);
  const input = $('input'), output = $('output'), errorBox = $('error');
  const notesBox = $('notes'), notesList = notesBox.querySelector('ul');
  const examples = $('examples');

  // Strip leading whitespace/comments, then look for a db.<collection> command.
  function detect(src) {
    const s = src.replace(/^(\s+|--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, '');
    return /^db\s*[.[]/.test(s) ? 'mongo' : 'sql';
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

  // Examples dropdown, grouped by source language.
  for (const group of ['SQL', 'MongoDB']) {
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
