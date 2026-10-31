# (No)SQLearn

A single-page tool that translates **SQL ⇄ MongoDB** (mongosh syntax), from basic queries to advanced ones,
with notes explaining how each part maps.
It runs entirely in the browser: plain HTML, CSS and JavaScript, with no build step and no dependencies.

## Use it

Open `index.html` in a browser, or serve the folder with any static server. Then paste or type a query.
The direction is auto-detected (anything starting with `db.`, `session.` or `show collections` is treated as MongoDB),
or you can pick it yourself. The examples menu is grouped by level.

- **⇄** puts the result back in as the new input
- **Ctrl/⌘ + Enter** translates immediately
- Separate multiple statements with `;` (SQL) or new lines (MongoDB)
- **Autocomplete** (on by default, toggle in the input pane) closes brackets and quotes, keeps indentation on Enter,
  and offers the rest of the keyword, function, method or `$operator` you are typing: **Tab** or **→** accepts, **Esc** dismisses
- The button above the title switches between light and dark mode (the default follows your system)

## What's supported

### Basic

| SQL | MongoDB |
| --- | --- |
| `SELECT cols FROM t WHERE ... ORDER BY ... LIMIT / OFFSET / TOP / FETCH FIRST` | `find(filter, projection).sort().skip().limit()`, `findOne()` |
| `= <> < <= > >=`, `IN`, `BETWEEN`, `LIKE / ILIKE`, `IS [NOT] NULL`, `AND / OR / NOT` | `$eq $ne $lt $lte $gt $gte`, `$in / $nin`, regex, `$exists`, `$and / $or / $nor / $not` |
| `COUNT(*)`, `SELECT DISTINCT col` | `countDocuments()`, `distinct()` |
| `INSERT ... VALUES`, `UPDATE ... SET`, `DELETE` | `insertOne / insertMany`, `updateOne / updateMany` (`$set $inc $mul $unset $min $max`), `deleteOne / deleteMany` |

### Intermediate

| SQL | MongoDB |
| --- | --- |
| `GROUP BY`, `HAVING`, `COUNT / SUM / AVG / MIN / MAX`, `COUNT(DISTINCT)` | `$group`, `$match` after `$group`, `$addToSet` + `$size` |
| `INNER / LEFT / RIGHT JOIN ... ON`, `JOIN ... USING`, `FROM a, b WHERE ...` | `$lookup` + `$unwind` |
| `CASE`, `CAST / ::`, `COALESCE`, `NULLIF`, `GREATEST`, string and math functions | `$cond / $switch`, `$toInt ...`, `$ifNull`, `$concat`, `$substrCP`, `$round` ... |
| Dates: `EXTRACT`, `DATE_TRUNC`, `NOW() - INTERVAL '7 days'`, `DATE '2024-01-01'`, `TO_CHAR` | `$year ...`, `$dateTrunc`, `$dateSubtract / $dateAdd`, `ISODate()`, `$dateToString` |
| JSON paths `data->>'key'` | dotted paths `"data.key"` |
| `REGEXP`, `REGEXP_LIKE` | regex / `$regex` |

### Advanced

| SQL | MongoDB |
| --- | --- |
| Subqueries: `IN (SELECT ...)`, `EXISTS`, scalar `(SELECT ...)`, correlated ones | `$lookup` with `let` + `pipeline` |
| `FROM (SELECT ...) AS t`, `WITH` (CTEs) | the inner pipeline runs first and the outer one continues it |
| `UNION [ALL]` | `$unionWith` (+ `$group` on `$$ROOT` to remove duplicates) |
| Window functions: `ROW_NUMBER / RANK / DENSE_RANK / LAG / LEAD / SUM ... OVER (PARTITION BY ... ORDER BY ... ROWS ...)` | `$setWindowFields` |
| `STRING_AGG / GROUP_CONCAT / ARRAY_AGG`, `(ARRAY_AGG(x ORDER BY y))[1]` | `$push` + `$reduce`, `$sort` + `$first / $last` |
| `LATERAL (SELECT ...)` joins | `$lookup` with a pipeline |
| Arrays (PostgreSQL): `UNNEST`, `= ANY`, `@>`, `CARDINALITY`, `ARRAY_APPEND / ARRAY_REMOVE` | `$unwind`, array equality, `$all`, `$size`, `$elemMatch`, `$push / $addToSet / $pull / $pop` |
| `INSERT ... ON CONFLICT`, `MERGE` | `updateOne(..., { upsert: true })`, `$setOnInsert`, `bulkWrite()` |
| `INSERT ... SELECT`, `CREATE TABLE ... AS SELECT` | `$merge`, `$out` |
| `ORDER BY RANDOM() LIMIT n` | `$sample` |
| Full text: `to_tsvector(...) @@ plainto_tsquery(...)`, `MATCH ... AGAINST` | `$text: { $search }` |
| Pipelines SQL can't express in one `SELECT` (e.g. `$match` after `$limit`, two `$group`s) | → nested subqueries |
| `$facet`, `$bucket`, `$sortByCount`, `$count`, `$replaceRoot` | → one query per facet (CTE), `CASE` buckets, `GROUP BY` + `ORDER BY` ... |
| `UPDATE / DELETE ... RETURNING` | `findOneAndUpdate / findOneAndDelete` |
| `EXPLAIN` | `explain("executionStats")` |

### Schema and admin

| SQL | MongoDB |
| --- | --- |
| `CREATE TABLE` (types, `NOT NULL`, `PRIMARY KEY`, `UNIQUE`, `CHECK`) | `createCollection()` with a `$jsonSchema` validator + unique indexes |
| `CREATE [UNIQUE] INDEX ... [WHERE]`, `USING GIN (to_tsvector(...))`, `DROP INDEX` | `createIndex()` (incl. `partialFilterExpression`, text indexes), `dropIndex()` |
| `CREATE VIEW`, `DROP TABLE / VIEW`, `TRUNCATE` | `db.createView()`, `drop()`, `deleteMany({})` |
| `ALTER TABLE ADD / DROP / RENAME COLUMN`, `RENAME TO` | `updateMany` with `$set / $unset / $rename`, `renameCollection()` |
| `BEGIN / COMMIT / ROLLBACK`, `USE`, `SHOW TABLES` | session transactions, `use`, `show collections` |

### Optimizations (SQL → MongoDB)

The generated pipelines are optimized rather than translated clause by clause:

- **Group before join:** `GROUP BY` over an `INNER JOIN` on the join key groups the aggregated table first and runs
  `$lookup` once per group instead of once per row. `HAVING` also runs before the join. This assumes the joined key is
  unique (an `_id` or primary key), and the notes say so.
- **Filter before join:** `WHERE` conditions on the main table alone run in a `$match` before `$lookup`.
- **Merged stages:** adjacent `$match` stages become one.
- **Compact output:** each stage stays on one line when it fits, and long ones wrap with aligned continuation lines.

Not supported: recursive CTEs (`$graphLookup`), `FULL OUTER JOIN`, `INTERSECT / EXCEPT`, geospatial queries and `$where`.
These produce a clear error message rather than a wrong translation.
Where databases differ, the output uses PostgreSQL syntax and the notes say so.

## Tests

```bash
node test/translate.test.js
```

The suite checks exact translations per level, translates every query back the other way, and checks that
unsupported input fails with a clear message.

## Deploy to GitHub Pages

The site is static, so no build is needed:

1. Push this repository to GitHub.
2. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, then pick `main` and `/ (root)`.
3. The site is published at `https://<user>.github.io/<repo>/`.

`.nojekyll` is included so GitHub serves the files as they are.

## Project layout

```
index.html            page markup
css/style.css         styles (light and dark)
js/sql-to-mongo.js    SQL parser + MongoDB generator
js/mongo-to-sql.js    mongosh parser + SQL generator
js/editor.js          syntax highlighting and autocomplete for the input
js/app.js             UI wiring, examples and theme
test/                 Node test script
```
