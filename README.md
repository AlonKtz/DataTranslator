# (No)SQLearn

A small single-page tool that translates **SQL ⇄ MongoDB** (mongosh syntax), with notes explaining how each part maps.
It runs entirely in the browser: plain HTML, CSS and JavaScript, with no build step and no dependencies.

## Use it

Open `index.html` in a browser, or serve the folder with any static server. Then paste or type a query.
The direction is auto-detected (anything starting with `db.` is treated as MongoDB), or you can pick it yourself.

- **⇄** puts the result back in as the new input
- **Ctrl/⌘ + Enter** translates immediately
- Separate multiple statements with `;`

## What's supported

| SQL | MongoDB |
| --- | --- |
| `SELECT cols FROM t WHERE ... ORDER BY ... LIMIT/OFFSET` | `find(filter, projection).sort().skip().limit()` |
| `=, <>, <, <=, >, >=, IN, BETWEEN, LIKE, IS NULL, AND/OR/NOT` | `$eq, $ne, $lt, ..., $in, $nin, regex, $and/$or/$nor/$not` |
| `COUNT(*)` / `SELECT DISTINCT col` | `countDocuments()` / `distinct()` |
| `GROUP BY`, `HAVING`, `SUM/AVG/MIN/MAX/COUNT` | `aggregate([$match, $group, $match, $sort, $project])` |
| `INNER JOIN` / `LEFT JOIN ... ON a.x = b.y` | `$lookup` + `$unwind` |
| Computed columns (`price * 2 AS x`, `UPPER(name)`, ...) | `$project` with aggregation expressions |
| `INSERT INTO t (cols) VALUES ...` | `insertOne()` / `insertMany()` |
| `UPDATE t SET ...` | `updateMany()` with `$set` / `$inc` / `$mul`, or an update pipeline |
| `DELETE FROM t WHERE ...` | `deleteMany()` (`LIMIT 1` → `deleteOne()`) |

Not supported (yet): subqueries, `UNION`, `CASE` in SQL input, `RIGHT/FULL JOIN`, and array operators such as `$elemMatch`, `$push` and `$unwind` on its own.
These produce a clear error message rather than a wrong translation.

## Tests

```bash
node test/translate.test.js
```

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
js/app.js             UI wiring and examples
test/                 Node test script
```
