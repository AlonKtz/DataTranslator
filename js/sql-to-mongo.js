/*
 * SQL -> MongoDB (mongosh) translator.
 * Covers queries (joins, subqueries, CTEs, UNION, window functions), writes (incl. upserts),
 * DDL (tables, indexes, views, ALTER) and transactions.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlToMongo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class TranslateError extends Error {}
  const fail = (msg) => { throw new TranslateError(msg); };

  // Words that end an expression or a table reference (so they are never taken as an alias).
  const RESERVED = new Set((
    'SELECT FROM WHERE GROUP ORDER BY HAVING LIMIT OFFSET FETCH JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ' +
    'ON USING AND OR NOT IN IS NULL LIKE ILIKE REGEXP RLIKE BETWEEN AS SET VALUES INTO INSERT UPDATE DELETE ' +
    'DISTINCT ALL UNION INTERSECT EXCEPT MINUS ASC DESC TRUE FALSE CASE WHEN THEN ELSE END TOP WITH OVER ' +
    'PARTITION EXISTS RETURNING WINDOW CREATE DROP ALTER TRUNCATE LATERAL'
  ).split(' '));

  // ---------------------------------------------------------------- tokenizer

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    let arrayDepth = 0; // inside ARRAY[...] or a subscript, brackets are operators, not quoted names
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '[') {
        const prev = tokens[tokens.length - 1];
        const word = prev && prev.type === 'ident' && !prev.quoted ? prev.value.toUpperCase() : null;
        if (arrayDepth > 0 || word === 'ARRAY' || (prev && prev.type === 'op' && prev.value === ')') ||
          (word && !RESERVED.has(word) && /[0-9]/.test(src[i + 1] || ''))) {
          tokens.push({ type: 'op', value: '[' });
          arrayDepth++;
          i++;
          continue;
        }
      }
      if (c === ']' && arrayDepth > 0) { tokens.push({ type: 'op', value: ']' }); arrayDepth--; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
      if (c === "'" || ((c === 'E' || c === 'e' || c === 'N' || c === 'n') && src[i + 1] === "'")) {
        if (c !== "'") i++;
        let s = '';
        i++;
        for (;;) {
          if (i >= n) fail('Unterminated string literal');
          const ch = src[i];
          if (ch === "'") {
            if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
            i++;
            break;
          }
          if (ch === '\\' && (src[i + 1] === "'" || src[i + 1] === '\\')) { s += src[i + 1]; i += 2; continue; }
          s += ch;
          i++;
        }
        tokens.push({ type: 'string', value: s });
        continue;
      }
      if (c === '"' || c === '`' || c === '[') {
        const close = c === '[' ? ']' : c;
        const end = src.indexOf(close, i + 1);
        if (end < 0) fail('Unterminated quoted identifier');
        tokens.push({ type: 'ident', value: src.slice(i + 1, end), quoted: true });
        i = end + 1;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
        tokens.push({ type: 'number', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
        tokens.push({ type: 'ident', value: m[0] });
        i += m[0].length;
        continue;
      }
      const three = src.substr(i, 3), two = src.substr(i, 2);
      if (three === '->>') { tokens.push({ type: 'op', value: three }); i += 3; continue; }
      if (['<=', '>=', '<>', '!=', '||', '->', '::', '@>', '@@'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
      if ('=<>(),.*;+-/%?'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
      fail(`Unexpected character "${c}"`);
    }
    tokens.push({ type: 'eof' });
    return tokens;
  }

  function describe(t) {
    if (t.type === 'eof') return 'end of input';
    if (t.type === 'string') return `'${t.value}'`;
    return `"${t.value}"`;
  }

  // ---------------------------------------------------------------- parser

  class Raw { constructor(code) { this.code = code; } }

  const EXTRACT_FIELDS = {
    YEAR: 'YEAR', MONTH: 'MONTH', DAY: 'DAY', HOUR: 'HOUR', MINUTE: 'MINUTE', SECOND: 'SECOND',
    DOW: 'DOW', DOY: 'DAYOFYEAR', WEEK: 'WEEK', QUARTER: 'QUARTER', EPOCH: 'EPOCH', MILLISECOND: 'MILLISECOND',
  };
  const UNITS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];

  function normalizeUnit(u) {
    let unit = String(u).toLowerCase();
    if (!UNITS.includes(unit) && unit.endsWith('s')) unit = unit.slice(0, -1);
    if (!UNITS.includes(unit)) fail(`Unknown time unit "${u}"`);
    return unit;
  }

  class Parser {
    constructor(tokens) { this.t = tokens; this.p = 0; }
    peek(o = 0) { return this.t[Math.min(this.p + o, this.t.length - 1)]; }
    next() { return this.t[this.p++]; }
    atEnd() { return this.peek().type === 'eof' || this.isOp(';'); }
    isKw(kw, o = 0) { const t = this.peek(o); return t.type === 'ident' && !t.quoted && t.value.toUpperCase() === kw; }
    acceptKw(...kws) {
      if (kws.every((k, j) => this.isKw(k, j))) { this.p += kws.length; return true; }
      return false;
    }
    expectKw(...kws) { if (!this.acceptKw(...kws)) this.fail(`Expected ${kws.join(' ')}`); }
    isOp(v, o = 0) { const t = this.peek(o); return t.type === 'op' && t.value === v; }
    acceptOp(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
    expectOp(v) { if (!this.acceptOp(v)) this.fail(`Expected "${v}"`); }
    fail(msg) { fail(`${msg} but found ${describe(this.peek())}`); }
    isName(o = 0) { const t = this.peek(o); return t.type === 'ident' && (t.quoted || !RESERVED.has(t.value.toUpperCase())); }
    ident() { if (!this.isName()) this.fail('Expected a name'); return this.next().value; }
    intValue() {
      const t = this.peek();
      if (t.type !== 'number' || !Number.isInteger(t.value)) this.fail('Expected a whole number');
      this.p++;
      return t.value;
    }
    startsQuery(o = 0) { return this.isKw('SELECT', o) || this.isKw('WITH', o); }

    qualifiedName() {
      let name = this.ident();
      while (this.acceptOp('.')) name = this.ident(); // schema.table -> table
      return name;
    }

    nameList() {
      this.expectOp('(');
      const names = [];
      do {
        names.push(this.ident());
        if (this.acceptOp('(')) { this.intValue(); this.expectOp(')'); } // MySQL prefix length
        if (!this.acceptKw('ASC')) this.acceptKw('DESC');
      } while (this.acceptOp(','));
      this.expectOp(')');
      return names;
    }

    skipParens() {
      this.expectOp('(');
      for (let depth = 1; depth > 0;) {
        const t = this.next();
        if (t.type === 'eof') fail('Unbalanced parentheses');
        if (t.type === 'op' && t.value === '(') depth++;
        if (t.type === 'op' && t.value === ')') depth--;
      }
    }

    // Skips tokens up to (not including) the next "," or ")" at this nesting level.
    skipClause() {
      while (!this.atEnd() && !this.isOp(',') && !this.isOp(')')) {
        if (this.isOp('(')) this.skipParens(); else this.p++;
      }
    }

    parseAll() {
      const stmts = [];
      while (this.peek().type !== 'eof') {
        if (this.acceptOp(';')) continue;
        stmts.push(this.statement());
        if (!this.atEnd()) this.fail('Expected end of statement');
      }
      return stmts;
    }

    statement() {
      if (this.acceptKw('EXPLAIN')) {
        this.acceptKw('ANALYZE');
        return { type: 'explain', stmt: this.statement() };
      }
      if (this.acceptKw('USE')) return { type: 'use', name: this.ident() };
      if (this.acceptKw('SHOW')) {
        if (this.acceptKw('TABLES')) return { type: 'show', what: 'collections' };
        if (this.acceptKw('DATABASES')) return { type: 'show', what: 'dbs' };
        this.fail('Expected TABLES or DATABASES after SHOW');
      }
      if (this.isKw('MERGE')) return this.merge();
      const ctes = this.isKw('WITH') ? this.withClause() : null;
      if (this.isKw('SELECT') || this.isOp('(')) {
        const q = this.query();
        if (ctes) q.ctes = [...ctes, ...(q.ctes || [])];
        return q;
      }
      let st;
      if (this.isKw('INSERT') || this.isKw('REPLACE')) st = this.insert();
      else if (this.isKw('UPDATE')) st = this.update();
      else if (this.isKw('DELETE')) st = this.del();
      else if (ctes) this.fail('Expected SELECT, INSERT, UPDATE or DELETE after WITH');
      else if (this.isKw('CREATE')) st = this.create();
      else if (this.isKw('DROP')) st = this.drop();
      else if (this.isKw('ALTER')) st = this.alter();
      else if (this.acceptKw('TRUNCATE')) {
        this.acceptKw('TABLE');
        const names = [];
        do names.push(this.qualifiedName()); while (this.acceptOp(','));
        while (!this.atEnd()) this.p++;
        st = { type: 'truncate', names };
      } else if (this.acceptKw('BEGIN') || this.acceptKw('START', 'TRANSACTION')) {
        if (!this.acceptKw('TRANSACTION')) this.acceptKw('WORK');
        st = { type: 'tx', action: 'begin' };
      } else if (this.acceptKw('COMMIT') || this.acceptKw('END')) { this.acceptKw('WORK') || this.acceptKw('TRANSACTION'); st = { type: 'tx', action: 'commit' }; }
      else if (this.acceptKw('ROLLBACK')) { this.acceptKw('WORK') || this.acceptKw('TRANSACTION'); st = { type: 'tx', action: 'rollback' }; }
      else this.fail('Expected SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER or TRUNCATE');
      if (ctes) st.ctes = ctes;
      return st;
    }

    withClause() {
      this.expectKw('WITH');
      if (this.isKw('RECURSIVE')) fail('WITH RECURSIVE is not supported — in MongoDB, recursive lookups use $graphLookup');
      const ctes = [];
      do {
        const name = this.ident();
        if (this.isOp('(')) fail('CTE column lists are not supported — alias the columns inside the query instead');
        this.expectKw('AS');
        if (!this.acceptKw('NOT', 'MATERIALIZED')) this.acceptKw('MATERIALIZED');
        this.expectOp('(');
        const query = this.query();
        this.expectOp(')');
        ctes.push({ name, query });
      } while (this.acceptOp(','));
      return ctes;
    }

    // SELECT ... [UNION [ALL] SELECT ...] [ORDER BY] [LIMIT]
    query() {
      const ctes = this.isKw('WITH') ? this.withClause() : null;
      const parts = [this.selectCore()];
      const alls = [];
      for (;;) {
        if (this.isKw('INTERSECT') || this.isKw('EXCEPT') || this.isKw('MINUS')) {
          fail(`${this.peek().value.toUpperCase()} is not supported — express it with WHERE [NOT] EXISTS (subquery) instead`);
        }
        if (!this.acceptKw('UNION')) break;
        const all = this.acceptKw('ALL');
        if (!all) this.acceptKw('DISTINCT');
        alls.push(all);
        parts.push(this.selectCore());
      }
      const q = parts.length === 1 ? parts[0] : { type: 'union', parts, all: alls.every(Boolean), orderBy: [], limit: null, offset: null };
      this.tail(q);
      if (ctes) q.ctes = [...ctes, ...(q.ctes || [])];
      return q;
    }

    tail(q) {
      if (this.acceptKw('ORDER', 'BY')) q.orderBy = this.orderList();
      if (this.acceptKw('LIMIT')) {
        if (this.acceptKw('ALL')) q.limit = null;
        else {
          const a = this.intValue();
          if (this.acceptOp(',')) { q.offset = a; q.limit = this.intValue(); } else q.limit = a;
        }
      }
      if (this.acceptKw('OFFSET')) {
        q.offset = this.intValue();
        if (!this.acceptKw('ROWS')) this.acceptKw('ROW');
      }
      if (this.acceptKw('FETCH')) {
        if (!this.acceptKw('FIRST')) this.expectKw('NEXT');
        q.limit = this.intValue();
        if (!this.acceptKw('ROWS')) this.acceptKw('ROW');
        this.expectKw('ONLY');
      }
    }

    orderList() {
      const list = [];
      do {
        const expr = this.expr();
        let dir = 1;
        if (this.acceptKw('DESC')) dir = -1;
        else this.acceptKw('ASC');
        if (this.acceptKw('NULLS')) { if (!this.acceptKw('FIRST')) this.expectKw('LAST'); }
        list.push({ expr, dir });
      } while (this.acceptOp(','));
      return list;
    }

    selectCore() {
      if (this.acceptOp('(')) {
        const q = this.query();
        this.expectOp(')');
        return q;
      }
      this.expectKw('SELECT');
      const q = { type: 'select', distinct: false, columns: [], joins: [], where: null, groupBy: [], having: null, orderBy: [], limit: null, offset: null };
      if (this.acceptKw('DISTINCT')) {
        if (this.isKw('ON')) fail('DISTINCT ON is not supported — use GROUP BY');
        q.distinct = true;
      } else this.acceptKw('ALL');
      if (this.acceptKw('TOP')) q.limit = this.intValue();
      do q.columns.push(this.selectItem()); while (this.acceptOp(','));
      if (!this.acceptKw('FROM')) this.fail('Expected FROM (a SELECT needs a table)');
      q.from = this.tableRef();
      for (;;) {
        let kind;
        if (this.acceptKw('NATURAL')) fail('NATURAL JOIN is not supported — use JOIN ... ON or JOIN ... USING');
        if (this.acceptKw('JOIN') || this.acceptKw('INNER', 'JOIN')) kind = 'inner';
        else if (this.acceptKw('LEFT', 'JOIN') || this.acceptKw('LEFT', 'OUTER', 'JOIN')) kind = 'left';
        else if (this.acceptKw('RIGHT', 'JOIN') || this.acceptKw('RIGHT', 'OUTER', 'JOIN')) kind = 'right';
        else if (this.acceptKw('FULL', 'JOIN') || this.acceptKw('FULL', 'OUTER', 'JOIN')) kind = 'full';
        else if (this.acceptKw('CROSS', 'JOIN')) kind = 'cross';
        else if (this.acceptOp(',')) kind = 'comma';
        else break;
        const table = this.tableRef();
        let on = null;
        if (kind !== 'cross' && kind !== 'comma') {
          if (this.acceptKw('USING')) {
            const cols = this.nameList();
            const conds = cols.map((c) => ({ type: 'cmp', op: '=', left: { type: 'col', parts: [q.from.alias, c] }, right: { type: 'col', parts: [table.alias, c] } }));
            on = conds.length === 1 ? conds[0] : { type: 'and', items: conds };
          } else {
            this.expectKw('ON');
            on = this.expr();
          }
        }
        q.joins.push({ kind, table, on });
      }
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('GROUP', 'BY')) {
        if (this.isKw('ROLLUP') || this.isKw('CUBE') || this.isKw('GROUPING')) fail('ROLLUP / CUBE / GROUPING SETS are not supported — use $facet with one $group per level');
        do q.groupBy.push(this.expr()); while (this.acceptOp(','));
      }
      if (this.acceptKw('HAVING')) q.having = this.expr();
      if (this.isKw('WINDOW')) fail('Named windows (WINDOW w AS ...) are not supported — write the window inline in OVER (...)');
      return q;
    }

    tableRef() {
      const lateral = this.acceptKw('LATERAL');
      if (this.acceptOp('(')) {
        const query = this.query();
        this.expectOp(')');
        this.acceptKw('AS');
        if (!this.isName()) this.fail('A subquery in FROM needs an alias');
        const alias = this.ident();
        return { subquery: query, name: alias, alias, lateral };
      }
      if (this.isKw('UNNEST') && this.isOp('(', 1)) {
        this.p += 2;
        const array = this.expr();
        this.expectOp(')');
        const ordinality = this.acceptKw('WITH', 'ORDINALITY');
        this.acceptKw('AS');
        const alias = this.ident();
        const names = this.isOp('(') ? this.nameList() : [];
        if (array.type !== 'col') fail('UNNEST() needs an array column');
        if (ordinality && names.length !== 2) fail('UNNEST ... WITH ORDINALITY needs column names: AS t(element, position)');
        return { unnest: array, name: alias, alias, element: names[0] || alias, ordinality: ordinality ? names[1] : null };
      }
      if (lateral) fail('LATERAL needs a subquery: LATERAL (SELECT ...) AS alias');
      const name = this.qualifiedName();
      let alias = null;
      if (this.acceptKw('AS')) alias = this.ident();
      else if (this.isName()) alias = this.ident();
      return { name, alias: alias || name };
    }

    selectItem() {
      if (this.acceptOp('*')) return { star: true };
      if (this.peek().type === 'ident' && this.isOp('.', 1) && this.isOp('*', 2)) {
        const qualifier = this.next().value;
        this.p += 2;
        return { star: true, qualifier };
      }
      const expr = this.expr();
      let alias = null;
      if (this.acceptKw('AS')) alias = this.peek().type === 'string' ? this.next().value : this.ident();
      else if (this.isName()) alias = this.ident();
      return { expr, alias };
    }

    setList() {
      const sets = [];
      do {
        const parts = [this.ident()];
        while (this.acceptOp('.')) parts.push(this.ident());
        this.expectOp('=');
        sets.push({ column: { type: 'col', parts }, value: this.expr() });
      } while (this.acceptOp(','));
      return sets;
    }

    returning() {
      if (!this.acceptKw('RETURNING')) return false;
      do { if (!this.acceptOp('*')) this.expr(); if (this.acceptKw('AS')) this.ident(); } while (this.acceptOp(','));
      return true;
    }

    insert() {
      const replace = this.acceptKw('REPLACE');
      if (!replace) this.expectKw('INSERT');
      this.acceptKw('IGNORE');
      this.expectKw('INTO');
      const st = { type: 'insert', table: this.qualifiedName(), columns: null, rows: null, query: null, conflict: null, returning: false, replace };
      if (this.isOp('(') && !this.startsQuery(1)) st.columns = this.nameList();
      if (this.acceptKw('VALUES')) {
        st.rows = [];
        do {
          this.expectOp('(');
          const row = [];
          do row.push(this.expr()); while (this.acceptOp(','));
          this.expectOp(')');
          st.rows.push(row);
        } while (this.acceptOp(','));
      } else if (this.startsQuery() || this.isOp('(')) st.query = this.query();
      else this.fail('Expected VALUES or SELECT');
      if (this.acceptKw('ON', 'CONFLICT')) {
        const target = this.isOp('(') ? this.nameList() : null;
        this.expectKw('DO');
        if (this.acceptKw('NOTHING')) st.conflict = { target, action: 'nothing' };
        else {
          this.expectKw('UPDATE');
          this.expectKw('SET');
          st.conflict = { target, action: 'update', sets: this.setList() };
          if (this.isKw('WHERE')) fail('ON CONFLICT ... DO UPDATE ... WHERE is not supported');
        }
      } else if (this.acceptKw('ON', 'DUPLICATE', 'KEY', 'UPDATE')) {
        st.conflict = { target: null, action: 'update', sets: this.setList(), mysql: true };
      }
      st.returning = this.returning();
      return st;
    }

    // MERGE INTO t USING (SELECT 1) AS s ON cond WHEN MATCHED THEN UPDATE ... WHEN NOT MATCHED THEN INSERT ...
    merge() {
      this.expectKw('MERGE');
      this.expectKw('INTO');
      const st = { type: 'merge', table: this.tableRef(), on: null, sets: null, insert: null };
      this.expectKw('USING');
      if (this.isOp('(')) {
        if (!(this.isKw('SELECT', 1) && this.peek(2).type === 'number' && this.isOp(')', 3))) {
          fail('MERGE ... USING <data source> is only supported with a single dummy row, e.g. USING (SELECT 1) AS s');
        }
        this.skipParens();
      } else if (!this.acceptKw('DUAL')) fail('MERGE ... USING another table is not supported — use USING (SELECT 1) AS s');
      if (!this.acceptKw('AS')) { /* optional */ }
      if (this.isName()) this.ident();
      this.expectKw('ON');
      st.on = this.expr();
      while (this.acceptKw('WHEN')) {
        const matched = !this.acceptKw('NOT');
        this.expectKw('MATCHED');
        if (this.isKw('AND')) fail('Conditional WHEN [NOT] MATCHED AND ... clauses are not supported');
        this.expectKw('THEN');
        if (matched) {
          if (this.isKw('DELETE')) fail('WHEN MATCHED THEN DELETE is not supported');
          this.expectKw('UPDATE');
          this.expectKw('SET');
          st.sets = this.setList();
        } else {
          this.expectKw('INSERT');
          const columns = this.nameList();
          this.expectKw('VALUES');
          this.expectOp('(');
          const values = [];
          do values.push(this.expr()); while (this.acceptOp(','));
          this.expectOp(')');
          st.insert = { columns, values };
        }
      }
      if (!st.sets && !st.insert) this.fail('Expected WHEN MATCHED or WHEN NOT MATCHED');
      return st;
    }

    update() {
      this.expectKw('UPDATE');
      const table = this.tableRef();
      this.expectKw('SET');
      const q = { type: 'update', table, sets: this.setList(), where: null, limit: null, returning: false };
      if (this.isKw('FROM')) fail('UPDATE ... FROM (joined updates) is not supported — use an aggregation with $merge');
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('LIMIT')) q.limit = this.intValue();
      q.returning = this.returning();
      return q;
    }

    del() {
      this.expectKw('DELETE');
      this.expectKw('FROM');
      const q = { type: 'delete', table: this.tableRef(), where: null, limit: null, returning: false };
      if (this.isKw('USING')) fail('DELETE ... USING (joined deletes) is not supported');
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('LIMIT')) q.limit = this.intValue();
      q.returning = this.returning();
      return q;
    }

    // ---- DDL

    typeName() {
      const t = this.next();
      if (t.type !== 'ident') fail('Expected a type name');
      let name = t.value.toUpperCase();
      if (name === 'DOUBLE') this.acceptKw('PRECISION');
      if (name === 'CHARACTER' && this.acceptKw('VARYING')) name = 'VARCHAR';
      if ((name === 'TIMESTAMP' || name === 'TIME') && (this.isKw('WITH') || this.isKw('WITHOUT'))) {
        this.p++;
        this.expectKw('TIME');
        this.expectKw('ZONE');
      }
      const args = [];
      if (this.acceptOp('(')) {
        do { const a = this.next(); args.push(a.value); } while (this.acceptOp(','));
        this.expectOp(')');
      }
      let array = false;
      while (this.peek().type === 'ident' && this.peek().quoted && this.peek().value === '') { this.p++; array = true; }
      return { name, args, array };
    }

    columnDef() {
      const col = { name: this.ident(), type: this.typeName(), notNull: false, pk: false, unique: false, def: undefined, references: null, autoInc: false, checks: [] };
      if (/SERIAL$/.test(col.type.name)) col.autoInc = true;
      while (!this.atEnd() && !this.isOp(',') && !this.isOp(')')) {
        if (this.acceptKw('NOT', 'NULL')) col.notNull = true;
        else if (this.acceptKw('NULL')) { /* nullable is the default */ }
        else if (this.acceptKw('PRIMARY', 'KEY')) col.pk = true;
        else if (this.acceptKw('UNIQUE')) { col.unique = true; this.acceptKw('KEY'); }
        else if (this.acceptKw('DEFAULT')) col.def = this.unary();
        else if (this.acceptKw('REFERENCES')) { col.references = this.qualifiedName(); if (this.isOp('(')) this.nameList(); }
        else if (this.acceptKw('CHECK')) { this.expectOp('('); col.checks.push(this.expr()); this.expectOp(')'); }
        else if (this.acceptKw('AUTO_INCREMENT') || this.acceptKw('AUTOINCREMENT') || this.acceptKw('IDENTITY')) { col.autoInc = true; if (this.isOp('(')) this.skipParens(); }
        else if (this.acceptKw('GENERATED')) { col.autoInc = true; while (!this.atEnd() && !this.isOp(',') && !this.isOp(')')) { if (this.isOp('(')) this.skipParens(); else this.p++; } }
        else if (this.acceptKw('CONSTRAINT')) this.ident();
        else if (this.isOp('(')) this.skipParens();
        else this.p++; // ON DELETE CASCADE, COLLATE x, UNSIGNED, COMMENT '...'
      }
      return col;
    }

    create() {
      this.expectKw('CREATE');
      this.acceptKw('OR', 'REPLACE');
      if (!this.acceptKw('TEMPORARY')) this.acceptKw('TEMP');
      if (this.acceptKw('TABLE')) return this.createTable();
      const unique = this.acceptKw('UNIQUE');
      if (this.acceptKw('INDEX')) return this.createIndex(unique);
      if (this.acceptKw('VIEW') || this.acceptKw('MATERIALIZED', 'VIEW')) {
        this.acceptKw('IF', 'NOT', 'EXISTS');
        const name = this.qualifiedName();
        this.expectKw('AS');
        return { type: 'createView', name, query: this.query() };
      }
      if (this.acceptKw('DATABASE') || this.acceptKw('SCHEMA')) {
        this.acceptKw('IF', 'NOT', 'EXISTS');
        return { type: 'createDatabase', name: this.ident() };
      }
      this.fail('Expected TABLE, INDEX or VIEW after CREATE');
    }

    createTable() {
      this.acceptKw('IF', 'NOT', 'EXISTS');
      const name = this.qualifiedName();
      if (this.acceptKw('AS')) return { type: 'createTableAs', name, query: this.query() };
      this.expectOp('(');
      const st = { type: 'createTable', name, columns: [], pk: [], uniques: [], indexes: [], fks: [], checks: [] };
      do {
        if (this.acceptKw('CONSTRAINT')) this.ident();
        if (this.acceptKw('PRIMARY', 'KEY')) st.pk = this.nameList();
        else if (this.acceptKw('UNIQUE')) {
          if (!this.acceptKw('KEY')) this.acceptKw('INDEX');
          if (this.isName() && !this.isOp('(')) this.ident();
          st.uniques.push(this.nameList());
        } else if (this.acceptKw('FOREIGN', 'KEY')) {
          const cols = this.nameList();
          this.expectKw('REFERENCES');
          st.fks.push({ cols, table: this.qualifiedName() });
          this.skipClause();
        } else if (this.acceptKw('CHECK')) { this.expectOp('('); st.checks.push(this.expr()); this.expectOp(')'); }
        else if (this.isKw('KEY') || this.isKw('INDEX')) {
          this.p++;
          if (this.isName() && !this.isOp('(')) this.ident();
          st.indexes.push(this.nameList());
        } else st.columns.push(this.columnDef());
      } while (this.acceptOp(','));
      this.expectOp(')');
      while (!this.atEnd()) this.p++; // table options such as ENGINE=InnoDB
      return st;
    }

    createIndex(unique) {
      this.acceptKw('CONCURRENTLY');
      this.acceptKw('IF', 'NOT', 'EXISTS');
      const name = this.isKw('ON') ? null : this.ident();
      this.expectKw('ON');
      const table = this.qualifiedName();
      const using = this.acceptKw('USING') ? this.ident().toUpperCase() : null;
      this.expectOp('(');
      const keys = [];
      do {
        const e = this.expr();
        let dir = using === 'HASH' ? 'hashed' : 1;
        if (e.type === 'func' && e.name === 'TO_TSVECTOR') {
          // Full-text index: every column inside to_tsvector(...) becomes a "text" key.
          const cols = [];
          find(e, (n) => { if (n.type === 'col') cols.push(n); return false; });
          cols.forEach((col) => keys.push({ col, dir: 'text' }));
          continue;
        }
        if (e.type !== 'col') fail('Expression indexes are not supported — index plain columns');
        if (this.acceptKw('DESC')) dir = -1; else this.acceptKw('ASC');
        keys.push({ col: e, dir });
      } while (this.acceptOp(','));
      this.expectOp(')');
      const st = { type: 'createIndex', name, table, unique, keys, where: null };
      if (this.acceptKw('WHERE')) st.where = this.expr();
      return st;
    }

    drop() {
      this.expectKw('DROP');
      if (this.acceptKw('TABLE') || this.acceptKw('VIEW') || this.acceptKw('MATERIALIZED', 'VIEW')) {
        this.acceptKw('IF', 'EXISTS');
        const names = [];
        do names.push(this.qualifiedName()); while (this.acceptOp(','));
        if (!this.acceptKw('CASCADE')) this.acceptKw('RESTRICT');
        return { type: 'dropTable', names };
      }
      if (this.acceptKw('INDEX')) {
        this.acceptKw('CONCURRENTLY');
        this.acceptKw('IF', 'EXISTS');
        const name = this.qualifiedName();
        let table = null;
        if (this.acceptKw('ON')) table = this.qualifiedName();
        return { type: 'dropIndex', name, table };
      }
      if (this.acceptKw('DATABASE') || this.acceptKw('SCHEMA')) {
        this.acceptKw('IF', 'EXISTS');
        return { type: 'dropDatabase', name: this.ident() };
      }
      this.fail('Expected TABLE, VIEW or INDEX after DROP');
    }

    alter() {
      this.expectKw('ALTER');
      this.expectKw('TABLE');
      this.acceptKw('IF', 'EXISTS');
      const st = { type: 'alter', table: this.qualifiedName(), actions: [] };
      do {
        if (this.acceptKw('ADD')) {
          if (this.acceptKw('CONSTRAINT')) this.ident();
          if (this.acceptKw('UNIQUE') || this.acceptKw('PRIMARY', 'KEY')) {
            if (!this.acceptKw('KEY')) this.acceptKw('INDEX');
            st.actions.push({ kind: 'unique', cols: this.nameList() });
          } else if (this.isKw('FOREIGN') || this.isKw('CHECK')) { this.skipClause(); st.actions.push({ kind: 'constraint' }); }
          else if (this.acceptKw('INDEX') || this.acceptKw('KEY')) {
            if (this.isName() && !this.isOp('(')) this.ident();
            st.actions.push({ kind: 'index', cols: this.nameList() });
          } else {
            this.acceptKw('COLUMN');
            this.acceptKw('IF', 'NOT', 'EXISTS');
            st.actions.push({ kind: 'addColumn', col: this.columnDef() });
          }
        } else if (this.acceptKw('DROP')) {
          if (this.acceptKw('CONSTRAINT') || this.acceptKw('INDEX') || this.acceptKw('PRIMARY', 'KEY') || this.acceptKw('FOREIGN', 'KEY')) {
            this.skipClause();
            st.actions.push({ kind: 'constraint' });
          } else {
            this.acceptKw('COLUMN');
            this.acceptKw('IF', 'EXISTS');
            st.actions.push({ kind: 'dropColumn', name: this.ident() });
            if (!this.acceptKw('CASCADE')) this.acceptKw('RESTRICT');
          }
        } else if (this.acceptKw('RENAME')) {
          if (this.acceptKw('TO') || this.acceptKw('AS')) st.actions.push({ kind: 'renameTable', to: this.qualifiedName() });
          else {
            this.acceptKw('COLUMN');
            const from = this.ident();
            this.expectKw('TO');
            st.actions.push({ kind: 'renameColumn', from, to: this.ident() });
          }
        } else if (this.acceptKw('ALTER') || this.acceptKw('MODIFY') || this.acceptKw('CHANGE')) {
          this.skipClause();
          st.actions.push({ kind: 'alterColumn' });
        } else this.fail('Expected ADD, DROP, RENAME or ALTER');
      } while (this.acceptOp(','));
      return st;
    }

    // ---- expressions, lowest precedence first

    expr() { return this.orExpr(); }

    orExpr() {
      const items = [this.andExpr()];
      while (this.acceptKw('OR')) items.push(this.andExpr());
      return items.length === 1 ? items[0] : { type: 'or', items };
    }

    andExpr() {
      const items = [this.notExpr()];
      while (this.acceptKw('AND')) items.push(this.notExpr());
      return items.length === 1 ? items[0] : { type: 'and', items };
    }

    notExpr() {
      if (this.acceptKw('NOT')) return { type: 'not', expr: this.notExpr() };
      return this.predicate();
    }

    predicate() {
      const left = this.additive();
      if (this.acceptKw('IS')) {
        const not = this.acceptKw('NOT');
        if (this.acceptKw('NULL')) return { type: 'isnull', expr: left, not };
        if (this.isKw('TRUE') || this.isKw('FALSE')) {
          const value = this.next().value.toUpperCase() === 'TRUE';
          return { type: 'cmp', op: not ? '!=' : '=', left, right: { type: 'lit', value } };
        }
        if (this.isKw('DISTINCT')) fail('IS [NOT] DISTINCT FROM is not supported');
        this.fail('Expected NULL, TRUE or FALSE after IS');
      }
      const not = this.acceptKw('NOT');
      if (this.acceptKw('IN')) {
        this.expectOp('(');
        if (this.startsQuery()) {
          const query = this.query();
          this.expectOp(')');
          return { type: 'insub', expr: left, query, not };
        }
        const list = [];
        do list.push(this.additive()); while (this.acceptOp(','));
        this.expectOp(')');
        return { type: 'in', expr: left, list, not };
      }
      if (this.acceptKw('BETWEEN')) {
        this.acceptKw('SYMMETRIC');
        const low = this.additive();
        this.expectKw('AND');
        return { type: 'between', expr: left, low, high: this.additive(), not };
      }
      if (this.isKw('LIKE') || this.isKw('ILIKE')) {
        const ci = this.next().value.toUpperCase() === 'ILIKE';
        const node = { type: 'like', expr: left, pattern: this.additive(), not, ci };
        if (this.acceptKw('ESCAPE')) this.next();
        return node;
      }
      if (this.acceptKw('REGEXP') || this.acceptKw('RLIKE')) {
        return { type: 'regex', expr: left, pattern: this.additive(), flags: '', not };
      }
      if (this.isKw('SIMILAR')) fail('SIMILAR TO is not supported — use LIKE or REGEXP');
      if (not) this.fail('Expected IN, BETWEEN or LIKE after NOT');
      const t = this.peek();
      if (t.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>=', '@>', '@@'].includes(t.value)) {
        this.p++;
        const op = t.value === '<>' ? '!=' : t.value;
        if ((this.isKw('ANY') || this.isKw('SOME')) && this.isOp('(', 1) && !this.startsQuery(2)) {
          this.p += 2;
          const array = this.expr();
          this.expectOp(')');
          if (op !== '=') fail('Only = ANY(array) is supported');
          return { type: 'any', value: left, array };
        }
        if (this.isKw('ANY') || this.isKw('ALL') || this.isKw('SOME')) fail('Comparisons with ANY / ALL (subquery) are not supported — use IN or EXISTS');
        return { type: 'cmp', op, left, right: this.additive() };
      }
      return left;
    }

    additive() {
      let left = this.multiplicative();
      for (;;) {
        const t = this.peek();
        if (t.type !== 'op' || !['+', '-', '||'].includes(t.value)) return left;
        this.p++;
        left = { type: 'binop', op: t.value, left, right: this.multiplicative() };
      }
    }

    multiplicative() {
      let left = this.unary();
      for (;;) {
        const t = this.peek();
        if (t.type !== 'op' || !['*', '/', '%'].includes(t.value)) return left;
        this.p++;
        left = { type: 'binop', op: t.value, left, right: this.unary() };
      }
    }

    unary() {
      if (this.acceptOp('-')) {
        const e = this.unary();
        if (e.type === 'lit' && typeof e.value === 'number') return { type: 'lit', value: -e.value };
        return { type: 'binop', op: '*', left: { type: 'lit', value: -1 }, right: e };
      }
      if (this.acceptOp('+')) return this.unary();
      return this.postfix(this.primary());
    }

    postfix(e) {
      for (;;) {
        if (this.acceptOp('::')) { e = { type: 'cast', expr: e, to: this.typeName() }; continue; }
        if (this.acceptOp('[')) {
          const index = this.expr();
          this.expectOp(']');
          e = { type: 'subscript', expr: e, index };
          continue;
        }
        if (this.isOp('->') || this.isOp('->>')) {
          this.p++;
          const t = this.next();
          if (e.type !== 'col' || (t.type !== 'string' && t.type !== 'number')) fail("JSON operators -> / ->> need a column and a literal key, e.g. data->>'name'");
          e = { type: 'col', parts: [...e.parts, String(t.value)] };
          continue;
        }
        return e;
      }
    }

    primary() {
      const t = this.peek();
      if (t.type === 'number' || t.type === 'string') { this.p++; return { type: 'lit', value: t.value }; }
      if (this.acceptOp('(')) {
        if (this.startsQuery()) {
          const query = this.query();
          this.expectOp(')');
          return { type: 'subquery', query };
        }
        const e = this.expr();
        this.expectOp(')');
        return e;
      }
      if (this.isOp('?')) fail('Query placeholders (?) are not supported — use literal values');
      if (t.type === 'ident') {
        if (!t.quoted) {
          const kw = t.value.toUpperCase();
          if (kw === 'NULL') { this.p++; return { type: 'lit', value: null }; }
          if (kw === 'TRUE' || kw === 'FALSE') { this.p++; return { type: 'lit', value: kw === 'TRUE' }; }
          if (kw === 'CASE') { this.p++; return this.caseExpr(); }
          if (kw === 'EXISTS' && this.isOp('(', 1)) {
            this.p += 2;
            const query = this.query();
            this.expectOp(')');
            return { type: 'exists', query };
          }
          if (kw === 'INTERVAL') { this.p++; return this.interval(); }
          if (kw === 'MATCH' && this.isOp('(', 1)) {
            // MySQL full-text: MATCH (cols) AGAINST ('words' [IN ... MODE])
            this.p++;
            this.skipParens();
            this.expectKw('AGAINST');
            this.expectOp('(');
            const t2 = this.next();
            if (t2.type !== 'string') fail('AGAINST expects a string');
            while (!this.isOp(')') && !this.atEnd()) this.p++;
            this.expectOp(')');
            return { type: 'fulltext', search: t2.value };
          }
          if (kw === 'ARRAY' && this.isOp('[', 1)) {
            this.p += 2;
            const items = [];
            if (!this.isOp(']')) { do items.push(this.expr()); while (this.acceptOp(',')); }
            this.expectOp(']');
            return { type: 'array', items };
          }
          if ((kw === 'DATE' || kw === 'TIMESTAMP' || kw === 'DATETIME') && this.peek(1).type === 'string') {
            this.p++;
            return { type: 'lit', value: new Raw(`ISODate(${JSON.stringify(this.next().value)})`) };
          }
          if (kw === 'CAST' && this.isOp('(', 1)) {
            this.p += 2;
            const expr = this.expr();
            this.expectKw('AS');
            const to = this.typeName();
            this.expectOp(')');
            return { type: 'cast', expr, to };
          }
          if (kw === 'EXTRACT' && this.isOp('(', 1)) {
            this.p += 2;
            const field = String(this.next().value).toUpperCase();
            this.expectKw('FROM');
            const e = this.expr();
            this.expectOp(')');
            if (!EXTRACT_FIELDS[field]) fail(`EXTRACT(${field} ...) is not supported`);
            return { type: 'func', name: EXTRACT_FIELDS[field], args: [e], distinct: false };
          }
          if (this.isOp('(', 1)) return this.funcCall();
          if (['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'LOCALTIMESTAMP', 'SYSDATE'].includes(kw)) {
            this.p++;
            return { type: 'func', name: 'NOW', args: [], distinct: false };
          }
          if (RESERVED.has(kw)) this.fail('Expected an expression');
        }
        const parts = [this.next().value];
        while (this.isOp('.') && !this.isOp('*', 1)) { this.p++; parts.push(this.ident()); }
        return { type: 'col', parts };
      }
      this.fail('Expected an expression');
    }

    caseExpr() {
      const operand = this.isKw('WHEN') ? null : this.expr();
      const whens = [];
      while (this.acceptKw('WHEN')) {
        const w = this.expr();
        this.expectKw('THEN');
        whens.push({ when: operand ? { type: 'cmp', op: '=', left: operand, right: w } : w, then: this.expr() });
      }
      if (!whens.length) this.fail('Expected WHEN');
      const node = { type: 'case', whens, else: null };
      if (this.acceptKw('ELSE')) node.else = this.expr();
      this.expectKw('END');
      return node;
    }

    interval() {
      const t = this.next();
      let amount, unit;
      if (t.type === 'string') {
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(t.value);
        if (!m) fail(`Unsupported interval '${t.value}' — use a form like INTERVAL '7 days'`);
        amount = Number(m[1]);
        unit = m[2] || this.next().value;
      } else if (t.type === 'number') {
        amount = t.value;
        unit = this.next().value;
      } else fail('Expected an interval such as INTERVAL \'7 days\'');
      return { type: 'interval', amount, unit: normalizeUnit(unit) };
    }

    funcCall() {
      const name = this.next().value.toUpperCase();
      this.expectOp('(');
      const node = { type: 'func', name, args: [], distinct: false };
      if (this.acceptOp('*')) { node.star = true; this.expectOp(')'); }
      else if (!this.acceptOp(')')) {
        if (this.acceptKw('DISTINCT')) node.distinct = true;
        else this.acceptKw('ALL');
        if (name === 'POSITION') {
          const sub = this.additive();
          this.expectKw('IN');
          node.args = [sub, this.additive()];
        } else {
          do node.args.push(this.expr()); while (this.acceptOp(','));
          if ((name === 'SUBSTRING' || name === 'SUBSTR') && this.acceptKw('FROM')) {
            node.args.push(this.expr());
            if (this.acceptKw('FOR')) node.args.push(this.expr());
          }
        }
        if (this.acceptKw('ORDER', 'BY')) node.orderBy = this.orderList();
        if (this.acceptKw('SEPARATOR')) node.args.push(this.primary());
        this.expectOp(')');
      }
      if (this.acceptKw('WITHIN', 'GROUP')) {
        this.expectOp('(');
        this.expectKw('ORDER', 'BY');
        node.orderBy = this.orderList();
        this.expectOp(')');
      }
      if (this.isKw('FILTER')) fail('FILTER (WHERE ...) is not supported — use SUM(CASE WHEN ... THEN 1 ELSE 0 END)');
      if (this.acceptKw('OVER')) return this.windowSpec(node);
      return node;
    }

    windowSpec(func) {
      if (!this.isOp('(')) fail('Named windows are not supported — write OVER (PARTITION BY ... ORDER BY ...)');
      this.expectOp('(');
      const w = { type: 'window', func, partitionBy: [], orderBy: [], frame: null };
      if (this.acceptKw('PARTITION', 'BY')) { do w.partitionBy.push(this.expr()); while (this.acceptOp(',')); }
      if (this.acceptKw('ORDER', 'BY')) w.orderBy = this.orderList();
      const mode = this.acceptKw('ROWS') ? 'documents' : this.acceptKw('RANGE') ? 'range' : null;
      if (mode) {
        let start, end = 'current';
        if (this.acceptKw('BETWEEN')) {
          start = this.frameBound();
          this.expectKw('AND');
          end = this.frameBound();
        } else start = this.frameBound();
        w.frame = { mode, start, end };
      }
      this.expectOp(')');
      return w;
    }

    frameBound() {
      if (this.acceptKw('UNBOUNDED')) {
        if (!this.acceptKw('PRECEDING')) this.expectKw('FOLLOWING');
        return 'unbounded';
      }
      if (this.acceptKw('CURRENT', 'ROW')) return 'current';
      const n = this.intValue();
      if (this.acceptKw('PRECEDING')) return -n;
      this.expectKw('FOLLOWING');
      return n;
    }
  }

  // ---------------------------------------------------------------- mongosh printer

  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) && !(v instanceof Raw);
  const isEmpty = (v) => isPlain(v) && Object.keys(v).length === 0;
  const isOnly = (v, k) => isPlain(v) && Object.keys(v).length === 1 && k in v;
  const key = (k) => (IDENT.test(k) ? k : JSON.stringify(k));

  function flat(v) {
    if (v instanceof Raw) return v.code;
    if (v instanceof RegExp) return String(v);
    if (Array.isArray(v)) return '[' + v.map(flat).join(', ') + ']';
    if (isPlain(v)) {
      const e = Object.entries(v);
      return e.length ? '{ ' + e.map(([k, x]) => key(k) + ': ' + flat(x)).join(', ') + ' }' : '{}';
    }
    if (typeof v === 'string') return JSON.stringify(v);
    if (Object.is(v, -0)) return '0';
    return String(v);
  }

  const WIDTH = 80;
  // `col` is the column the value starts at, `indent` the indentation of its line. A value that
  // doesn't fit on one line keeps as many entries per line as fit, with continuation lines aligned
  // under the first entry. When an entry itself needs several lines, it falls back to one entry
  // per line instead.
  function fmt(v, col = 0, indent = col, pack = true) {
    const f = flat(v);
    if (col + f.length <= WIDTH || !(Array.isArray(v) || isPlain(v))) return f;
    const arr = Array.isArray(v);
    const items = arr ? v.map((x) => ['', x]) : Object.entries(v).map(([k, x]) => [key(k) + ': ', x]);
    const open = arr ? '[' : '{ ', close = arr ? ']' : ' }';
    const start = col + open.length;
    const lines = [];
    let cur = '', packed = pack && start <= WIDTH / 2;
    items.forEach(([k, x], i) => {
      if (!packed) return;
      const tail = i === items.length - 1 ? close.length : 1;
      if (cur) {
        const lastLine = cur.slice(cur.lastIndexOf('\n') + 1);
        const at = (cur.includes('\n') ? 0 : start) + lastLine.length + 2;
        const text = k + flat(x);
        if (!cur.includes('\n') && at + text.length + tail <= WIDTH) { cur += ', ' + text; return; }
        lines.push(cur);
      }
      cur = k + fmt(x, start + k.length, start);
      // A nested value may wrap the same way, but not fall back to one entry per line.
      if (/[[{]\n/.test(cur)) packed = false;
    });
    if (packed) return open + [...lines, cur].join(',\n' + ' '.repeat(start)) + close;
    const pad = ' '.repeat(indent), inner = ' '.repeat(indent + 2);
    return (arr ? '[' : '{') + '\n' + items.map(([k, x]) => inner + k + fmt(x, indent + 2 + k.length, indent + 2)).join(',\n') +
      '\n' + pad + (arr ? ']' : '}');
  }

  // Call arguments start mid-line, so their outer braces always open onto their own lines.
  const fmtTop = (v) => fmt(v, 0, 0, false);
  const fmtPipeline = (stages) => (stages.length ? '[\n' + stages.map((s) => '  ' + fmt(s, 2)).join(',\n') + '\n]' : '[]');
  const collection = (name) => (/^[A-Za-z_][\w]*$/.test(name) ? 'db.' + name : `db.getCollection(${JSON.stringify(name)})`);
  const args = (...list) => list.filter((a) => a !== undefined).map(fmtTop).join(', ');

  // ---------------------------------------------------------------- shared helpers

  const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STRING_AGG', 'GROUP_CONCAT', 'LISTAGG', 'ARRAY_AGG', 'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP']);
  const isAgg = (n) => !!n && n.type === 'func' && AGGREGATES.has(n.name);
  const CMP = { '=': '$eq', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
  const FLIP = { '=': '=', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
  const BINOPS = { '+': '$add', '-': '$subtract', '*': '$multiply', '/': '$divide', '%': '$mod', '||': '$concat' };
  const NOW_FUNCS = new Set(['NOW', 'GETDATE', 'SYSDATETIME', 'CURRENT_TIMESTAMP']);
  const SUB_TYPES = ['exists', 'insub', 'subquery'];
  const NO = Symbol('not-a-literal');

  // Depth-first search through an expression tree; never descends into subqueries.
  function find(node, pred, stopAt = []) {
    if (!node || typeof node !== 'object' || node instanceof Raw) return false;
    if (Array.isArray(node)) return node.some((n) => find(n, pred, stopAt));
    if (pred(node)) return true;
    if (node.type && stopAt.includes(node.type)) return false;
    return Object.entries(node).some(([k, v]) => k !== 'query' && find(v, pred, stopAt));
  }
  const containsAgg = (n) => find(n, isAgg, ['window', ...SUB_TYPES]);
  const containsWindow = (n) => find(n, (x) => x.type === 'window', SUB_TYPES);
  const containsSub = (n) => find(n, (x) => SUB_TYPES.includes(x.type));

  function literal(node) {
    if (node.type === 'lit') return node.value;
    if (node.type === 'array') {
      const items = node.items.map(literal);
      return items.includes(NO) ? NO : items;
    }
    if (node.type === 'func' && NOW_FUNCS.has(node.name) && !node.args.length) return new Raw('new Date()');
    return NO;
  }

  const lastPart = (col) => col.parts[col.parts.length - 1];

  function defaultName(node) {
    switch (node.type) {
      case 'col': return lastPart(node);
      case 'func': {
        const fn = node.name.toLowerCase();
        const a = node.args[0];
        return a && a.type === 'col' ? `${fn}_${lastPart(a)}` : fn;
      }
      case 'window': return defaultName(node.func);
      case 'cast': return defaultName(node.expr);
      case 'case': return 'case';
      default: return 'expr';
    }
  }

  function uniqueName(base, taken) {
    const name = String(base).replace(/\./g, '_').replace(/^\$+/, '') || 'field';
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}_${i}`;
    taken.add(n);
    return n;
  }

  function omit(obj, keys) {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
  }

  // Maps table aliases to document paths. Main-table qualifiers are dropped, joined aliases stay
  // as a prefix, and (inside a correlated subquery) outer aliases become $$let variables.
  function makeScope(from, joins, outer) {
    const main = new Set([from.alias.toLowerCase(), String(from.name || from.alias).toLowerCase()]);
    const joined = new Map(joins.filter((j) => !j.table.unnest).map((j) => [j.table.alias.toLowerCase(), j.table.alias]));
    // UNNEST(array) AS x: after $unwind the element lives at the array's own path.
    const unnests = new Map(joins.filter((j) => j.table.unnest).flatMap((j) =>
      [[j.table.alias.toLowerCase(), j.table.unnest], [j.table.element.toLowerCase(), j.table.unnest]]));
    const positions = new Set(joins.filter((j) => j.table.ordinality).map((j) => j.table.ordinality.toLowerCase()));
    const scope = {
      joinTouched: false,
      has: (h) => main.has(h) || joined.has(h) || unnests.has(h),
      resolve(col) {
        const [head, ...rest] = col.parts;
        const u = unnests.get(head.toLowerCase());
        if (u) {
          const base = scope.plain(u);
          if (base.path === undefined) fail('UNNEST of an outer column is not supported');
          scope.joinTouched = true;
          return { path: rest.length ? base.path + '.' + rest.join('.') : base.path };
        }
        if (!rest.length && positions.has(head.toLowerCase())) scope.joinTouched = true;
        return scope.plain(col);
      },
      plain(col) {
        const [head, ...rest] = col.parts;
        if (rest.length) {
          const h = head.toLowerCase();
          if (joined.has(h)) { scope.joinTouched = true; return { path: joined.get(h) + '.' + rest.join('.') }; }
          if (main.has(h)) return { path: rest.join('.') };
          if (outer && outer.scope.has(h)) return { outerVar: outer.letVar(col) };
        }
        return { path: col.parts.join('.') };
      },
      path(col) { const r = scope.resolve(col); return r.path === undefined ? null : r.path; },
      canon(node) { return JSON.stringify(node, (k, v) => (k === 'query' ? '<subquery>' : v && v.type === 'col' ? JSON.stringify(scope.resolve(v)) : v)); },
    };
    return scope;
  }

  // Collects the outer-query values a correlated subquery needs, for $lookup's `let`.
  function outerRef(scope) {
    const lets = {};
    const taken = new Set();
    return {
      scope,
      lets,
      letVar(col) {
        const target = scope.resolve(col);
        const value = target.outerVar ? '$$' + target.outerVar : '$' + target.path;
        const existing = Object.keys(lets).find((k) => lets[k] === value);
        if (existing) return existing;
        const name = uniqueName(('o_' + lastPart(col)).replace(/\W/g, '_').toLowerCase(), taken);
        lets[name] = value;
        return name;
      },
    };
  }

  function makeCtx(scope, env) {
    const ctx = {
      scope,
      env,
      notes: env.notes,
      pending: [],      // $lookup stages for subqueries, inserted before the stage that uses them
      pendingNames: [],
      windows: null,    // window node canon -> output field
      fieldOf(n) {
        if (n.type === 'col') return scope.path(n);
        if (n.type === 'window' && ctx.windows) return ctx.windows.get(scope.canon(n)) || null;
        return null;
      },
    };
    return ctx;
  }

  function flushPending(ctx, stage, unset = true) {
    const out = [...ctx.pending];
    if (stage) out.push(stage);
    if (unset && ctx.pendingNames.length) out.push({ $unset: ctx.pendingNames.length === 1 ? ctx.pendingNames[0] : ctx.pendingNames.slice() });
    ctx.pending = [];
    ctx.pendingNames = [];
    return out;
  }

  function likeToRegex(pattern, ci) {
    if (/^%+$/.test(pattern)) return new RegExp('', ci ? 'i' : '');
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '%') re += '.*';
      else if (ch === '_') re += '.';
      else if (ch === '\\' && i + 1 < pattern.length) re += escapeRe(pattern[++i]);
      else re += escapeRe(ch);
    }
    re = '^' + re + '$';
    if (re.startsWith('^.*')) re = re.slice(3);
    if (re.endsWith('.*$')) re = re.slice(0, -3);
    return new RegExp(re, ci ? 'i' : '');
  }
  const escapeRe = (ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

  function makeRegex(pattern, flags) {
    try { return new RegExp(pattern, String(flags).replace(/[^ims]/g, '')); }
    catch (e) { fail(`Invalid regular expression: ${pattern}`); }
  }

  // `_id = '64b...'` almost always means an ObjectId.
  function idValue(field, v, notes) {
    if ((field === '_id' || field.endsWith('._id')) && typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v)) {
      notes.push('A 24-character hex string compared with _id is written as ObjectId("...").');
      return new Raw(`ObjectId(${JSON.stringify(v)})`);
    }
    return v;
  }

  // ---------------------------------------------------------------- WHERE -> query filter

  function toFilter(node, ctx) {
    switch (node.type) {
      case 'and': return mergeAnd(node.items.map((n) => toFilter(n, ctx)));
      case 'or': return { $or: node.items.flatMap((n) => { const f = toFilter(n, ctx); return isOnly(f, '$or') ? f.$or : [f]; }) };
      case 'not': return negate(toFilter(node.expr, ctx));
      case 'cmp': return cmpFilter(node, ctx);
      case 'in': {
        const f = ctx.fieldOf(node.expr), vals = node.list.map(literal);
        if (f && !vals.includes(NO)) return { [f]: { [node.not ? '$nin' : '$in']: vals.map((v) => idValue(f, v, ctx.notes)) } };
        break;
      }
      case 'between': {
        const f = ctx.fieldOf(node.expr), lo = literal(node.low), hi = literal(node.high);
        if (f && lo !== NO && hi !== NO) {
          return node.not ? { $or: [{ [f]: { $lt: lo } }, { [f]: { $gt: hi } }] } : { [f]: { $gte: lo, $lte: hi } };
        }
        break;
      }
      case 'like': {
        const f = ctx.fieldOf(node.expr), p = literal(node.pattern);
        if (f && typeof p === 'string') {
          const re = likeToRegex(p, node.ci);
          ctx.notes.push(`LIKE '${p}' → regex ${re} (% becomes .*, _ becomes .).`);
          return { [f]: node.not ? { $not: re } : re };
        }
        break;
      }
      case 'regex': {
        const f = ctx.fieldOf(node.expr), p = literal(node.pattern);
        if (f && typeof p === 'string') {
          const re = makeRegex(p, node.flags);
          return { [f]: node.not ? { $not: re } : re };
        }
        break;
      }
      case 'isnull': {
        const f = ctx.fieldOf(node.expr);
        if (f) return { [f]: node.not ? { $ne: null } : null };
        break;
      }
      case 'any': {
        const f = ctx.fieldOf(node.array), v = literal(node.value);
        if (f && v !== NO) {
          ctx.notes.push('value = ANY(array) → { array: value }: MongoDB matches an array field if any element equals the value.');
          return { [f]: v };
        }
        break;
      }
      case 'fulltext': return fullText(node.search, ctx);
      case 'exists': {
        const elem = elemMatch(node.query, ctx);
        if (elem) return elem;
        const { as } = subLookup(node.query, 'exists', ctx);
        ctx.notes.push('EXISTS (subquery) → $lookup with a pipeline, then $match on a non-empty result.');
        return { [as]: { $ne: [] } };
      }
      case 'insub': {
        const { as, field } = subLookup(node.query, 'in', ctx);
        ctx.notes.push('IN (subquery) → $lookup with a pipeline, then $in against the returned values.');
        const e = { $in: [aggExpr(node.expr, ctx), `$${as}.${field}`] };
        return { $expr: node.not ? { $not: [e] } : e };
      }
      case 'func':
        if (node.name === 'REGEXP_LIKE' && node.args.length >= 2) {
          const flags = node.args[2] ? literal(node.args[2]) : '';
          return toFilter({ type: 'regex', expr: node.args[0], pattern: node.args[1], flags: typeof flags === 'string' ? flags : '', not: false }, ctx);
        }
        break;
      case 'col': {
        const f = ctx.fieldOf(node);
        if (f) return { [f]: true };
        break;
      }
      case 'lit':
        if (node.value === true) return {};
        break;
    }
    return { $expr: aggExpr(node, ctx) };
  }

  function fullText(search, ctx) {
    ctx.notes.push('Full-text search → $text: { $search }. It needs a text index on the searched fields: createIndex({ field: "text" }).');
    return { $text: { $search: search } };
  }

  // EXISTS (SELECT 1 FROM UNNEST(arr) AS e WHERE ...) -> { arr: { $elemMatch: ... } }
  function elemMatch(q, ctx) {
    if (q.type !== 'select' || !q.from.unnest || q.joins.length || q.groupBy.length || q.having || !q.where) return null;
    const f = ctx.fieldOf(q.from.unnest);
    if (!f) return null;
    const alias = q.from.alias;
    const raw = toFilter(q.where, makeCtx(makeScope({ name: alias, alias }, [], null), ctx.env));
    const match = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === alias) Object.assign(match, isOpObj(v) ? v : v instanceof RegExp ? { $regex: v } : { $eq: v });
      else match[k] = v;
    }
    ctx.notes.push('EXISTS over UNNEST(array) → $elemMatch: at least one element must match every condition.');
    return { [f]: { $elemMatch: match } };
  }

  function cmpFilter(node, ctx) {
    let op = node.op;
    if (op === '@@') {
      const q = node.right;
      const v = q.type === 'func' && /TSQUERY$/.test(q.name) ? literal(q.args[q.args.length - 1]) : NO;
      if (typeof v !== 'string') fail('Full-text search (@@) is supported as to_tsvector(...) @@ plainto_tsquery(\'words\')');
      return fullText(v, ctx);
    }
    if (op === '@>') {
      const f = ctx.fieldOf(node.left), v = literal(node.right);
      if (f && Array.isArray(v)) {
        ctx.notes.push('array @> ARRAY[...] (contains all) → $all.');
        return { [f]: { $all: v } };
      }
      return { $expr: aggExpr(node, ctx) };
    }
    if (op === '=' && node.left.type === 'func' && ['CARDINALITY', 'ARRAY_LENGTH'].includes(node.left.name) && node.left.args[0]) {
      const f = ctx.fieldOf(node.left.args[0]), v = literal(node.right);
      if (f && typeof v === 'number') return { [f]: { $size: v } };
    }
    let f = ctx.fieldOf(node.left), v = literal(node.right);
    if (!f || v === NO) {
      const f2 = ctx.fieldOf(node.right), v2 = literal(node.left);
      if (!f2 || v2 === NO) return { $expr: aggExpr(node, ctx) };
      f = f2; v = v2; op = FLIP[op];
    }
    v = idValue(f, v, ctx.notes);
    return op === '=' ? { [f]: v } : { [f]: { [CMP[op]]: v } };
  }

  const isOpObj = (v) => isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

  // Combines AND-ed filters into one object, falling back to $and when fields collide.
  function mergeAnd(filters) {
    const list = filters.flatMap((f) => (isOnly(f, '$and') ? f.$and : [f])).filter((f) => !isEmpty(f));
    const out = {};
    for (const f of list) {
      for (const [k, v] of Object.entries(f)) {
        if (!(k in out)) { out[k] = v; continue; }
        if (isOpObj(out[k]) && isOpObj(v) && Object.keys(v).every((o) => !(o in out[k]))) { out[k] = { ...out[k], ...v }; continue; }
        return { $and: list };
      }
    }
    return out;
  }

  function negate(f) {
    const keys = Object.keys(f);
    if (keys.length === 1) {
      const k = keys[0], v = f[k];
      if (k === '$or') return { $nor: v };
      if (k === '$nor') return v.length === 1 ? v[0] : { $or: v };
      if (k === '$expr') return { $expr: { $not: [v] } };
      if (!k.startsWith('$')) {
        if (isOpObj(v)) {
          const ops = Object.keys(v);
          if (ops.length === 1) {
            switch (ops[0]) {
              case '$eq': return { [k]: { $ne: v.$eq } };
              case '$ne': return { [k]: v.$ne };
              case '$in': return { [k]: { $nin: v.$in } };
              case '$nin': return { [k]: { $in: v.$nin } };
              case '$not': return { [k]: v.$not };
            }
          }
          return { [k]: { $not: v } };
        }
        if (v instanceof RegExp) return { [k]: { $not: v } };
        return { [k]: { $ne: v } };
      }
    }
    return { $nor: [f] };
  }

  // ---------------------------------------------------------------- subqueries

  // Adds a $lookup that runs the subquery (correlated through `let` when it references the
  // outer query) and returns the name of the array field holding its result.
  function subLookup(query, kind, ctx) {
    if (kind === 'exists' && query.type === 'select' && !query.groupBy.length && !containsAgg(query.columns)) {
      query = { ...query, columns: [{ star: true }], orderBy: [] };
    }
    const outer = outerRef(ctx.scope);
    const inner = compileQuery(query, ctx.env, outer);
    if (kind !== 'exists' && (!inner.outputs || inner.outputs.length !== 1)) fail('A subquery used as a value must select exactly one column');
    const as = `_sub${++ctx.env.subCount}`;
    const pipeline = inner.stages.slice();
    if (kind === 'exists') pipeline.push({ $limit: 1 });
    const lookup = { from: inner.coll };
    if (Object.keys(outer.lets).length) lookup.let = outer.lets;
    lookup.pipeline = pipeline;
    lookup.as = as;
    ctx.pending.push({ $lookup: lookup });
    ctx.pendingNames.push(as);
    return { as, field: inner.outputs && inner.outputs[0] };
  }

  // ---------------------------------------------------------------- expressions -> aggregation expressions

  const unary = (op) => (a, name) => {
    if (a.length !== 1) fail(`${name}() takes exactly one argument`);
    return { [op]: a[0] };
  };

  function substr(a) {
    if (a.length < 2) fail('SUBSTRING() needs at least a string and a start position');
    const start = typeof a[1] === 'number' ? a[1] - 1 : { $subtract: [a[1], 1] };
    return { $substrCP: [a[0], start, a.length > 2 ? a[2] : { $strLenCP: a[0] }] };
  }

  function dateFormat(fmtString, mysql) {
    const map = mysql
      ? [['%i', '%M'], ['%s', '%S'], ['%H', '%H'], ['%Y', '%Y'], ['%m', '%m'], ['%d', '%d']]
      : [['YYYY', '%Y'], ['HH24', '%H'], ['HH', '%H'], ['MI', '%M'], ['SS', '%S'], ['MS', '%L'], ['MM', '%m'], ['DD', '%d']];
    if (mysql) return String(fmtString).replace(/%[iHsYmd]/g, (m) => map.find(([k]) => k === m)[1]);
    let out = String(fmtString);
    for (const [k, v] of map) out = out.split(k).join(v);
    return out;
  }

  const SCALAR = {
    UPPER: unary('$toUpper'), UCASE: unary('$toUpper'),
    LOWER: unary('$toLower'), LCASE: unary('$toLower'),
    LENGTH: unary('$strLenCP'), CHAR_LENGTH: unary('$strLenCP'), CHARACTER_LENGTH: unary('$strLenCP'), LEN: unary('$strLenCP'),
    ABS: unary('$abs'), CEIL: unary('$ceil'), CEILING: unary('$ceil'), FLOOR: unary('$floor'), SQRT: unary('$sqrt'),
    EXP: unary('$exp'), LN: unary('$ln'), LOG10: unary('$log10'),
    LOG: (a) => (a.length === 2 ? { $log: [a[1], a[0]] } : { $ln: a[0] }),
    YEAR: unary('$year'), MONTH: unary('$month'), DAY: unary('$dayOfMonth'), DAYOFMONTH: unary('$dayOfMonth'),
    HOUR: unary('$hour'), MINUTE: unary('$minute'), SECOND: unary('$second'), MILLISECOND: unary('$millisecond'),
    DAYOFWEEK: unary('$dayOfWeek'), DAYOFYEAR: unary('$dayOfYear'), WEEK: unary('$week'),
    DOW: (a) => ({ $subtract: [{ $dayOfWeek: a[0] }, 1] }),
    QUARTER: (a) => ({ $ceil: { $divide: [{ $month: a[0] }, 3] } }),
    EPOCH: (a) => ({ $divide: [{ $toLong: a[0] }, 1000] }),
    TRIM: (a) => ({ $trim: { input: a[0] } }),
    LTRIM: (a) => ({ $ltrim: { input: a[0] } }),
    RTRIM: (a) => ({ $rtrim: { input: a[0] } }),
    CONCAT: (a) => ({ $concat: a }),
    CONCAT_WS: (a) => ({ $concat: a.slice(1).flatMap((x, i) => (i ? [a[0], x] : [x])) }),
    REPLACE: (a) => ({ $replaceAll: { input: a[0], find: a[1], replacement: a[2] } }),
    POSITION: (a) => ({ $add: [{ $indexOfCP: [a[1], a[0]] }, 1] }),
    STRPOS: (a) => ({ $add: [{ $indexOfCP: [a[0], a[1]] }, 1] }),
    INSTR: (a) => ({ $add: [{ $indexOfCP: [a[0], a[1]] }, 1] }),
    LEFT: (a) => ({ $substrCP: [a[0], 0, a[1]] }),
    RIGHT: (a) => ({ $substrCP: [a[0], { $subtract: [{ $strLenCP: a[0] }, a[1]] }, a[1]] }),
    ROUND: (a) => ({ $round: a }),
    TRUNC: (a) => ({ $trunc: a }), TRUNCATE: (a) => ({ $trunc: a }),
    MOD: (a) => ({ $mod: a }),
    POWER: (a) => ({ $pow: a }), POW: (a) => ({ $pow: a }),
    RANDOM: () => ({ $rand: {} }), RAND: () => ({ $rand: {} }),
    COALESCE: (a) => ({ $ifNull: a }), IFNULL: (a) => ({ $ifNull: a }), NVL: (a) => ({ $ifNull: a }), ISNULL: (a) => ({ $ifNull: a }),
    NULLIF: (a) => ({ $cond: [{ $eq: [a[0], a[1]] }, null, a[0]] }),
    GREATEST: (a) => ({ $max: a }), LEAST: (a) => ({ $min: a }),
    SUBSTRING: substr, SUBSTR: substr,
    DATE_TRUNC: (a) => ({ $dateTrunc: { date: a[1], unit: normalizeUnit(a[0]) } }),
    DATE_PART: (a) => {
      const f = EXTRACT_FIELDS[String(a[0]).toUpperCase()];
      if (!f) fail(`DATE_PART('${a[0]}') is not supported`);
      return SCALAR[f]([a[1]], f);
    },
    DATEDIFF: (a) => ({ $dateDiff: { startDate: a[1], endDate: a[0], unit: 'day' } }),
    TO_CHAR: (a) => ({ $dateToString: { date: a[0], format: dateFormat(a[1], false) } }),
    DATE_FORMAT: (a) => ({ $dateToString: { date: a[0], format: dateFormat(a[1], true) } }),
    CARDINALITY: unary('$size'),
    ARRAY_APPEND: (a) => ({ $concatArrays: [a[0], [a[1]]] }),
    ARRAY_CAT: (a) => ({ $concatArrays: a }),
    ARRAY_REMOVE: (a) => ({ $filter: { input: a[0], cond: { $ne: ['$$this', a[1]] } } }),
    ARRAY_LENGTH: (a) => ({ $size: a[0] }),
    NOW: () => '$$NOW',
  };

  const CASTS = [
    [/^(INT|INTEGER|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|SIGNED|UNSIGNED)$/, '$toInt'],
    [/^(BIGINT|INT8)$/, '$toLong'],
    [/^(DECIMAL|NUMERIC|MONEY|DEC)$/, '$toDecimal'],
    [/^(FLOAT|FLOAT4|FLOAT8|REAL|DOUBLE)$/, '$toDouble'],
    [/^(VARCHAR|CHAR|CHARACTER|TEXT|NVARCHAR|NCHAR|STRING|UUID|CLOB)$/, '$toString'],
    [/^(DATE|TIMESTAMP|DATETIME|TIMESTAMPTZ|TIME)$/, '$toDate'],
    [/^(BOOLEAN|BOOL|BIT)$/, '$toBool'],
  ];

  function castOp(type) {
    const hit = CASTS.find(([re]) => re.test(type.name));
    if (!hit) fail(`CAST to ${type.name} is not supported`);
    return hit[1];
  }

  function aggExpr(node, ctx) {
    const f = ctx.fieldOf(node);
    if (f != null) return '$' + f;
    if (isAgg(node)) {
      if (ctx.aggRef) return ctx.aggRef(node);
      fail(`${node.name}() can only be used in the SELECT list, HAVING or ORDER BY`);
    }
    const sub = (n) => aggExpr(n, ctx);
    const wrapNot = (e, not) => (not ? { $not: [e] } : e);
    switch (node.type) {
      case 'lit':
        return typeof node.value === 'string' && node.value.startsWith('$') ? { $literal: node.value } : node.value;
      case 'col': {
        const r = ctx.scope.resolve(node);
        return r.outerVar ? '$$' + r.outerVar : '$' + r.path;
      }
      case 'func': {
        if (node.name === 'REGEXP_LIKE') return sub({ type: 'regex', expr: node.args[0], pattern: node.args[1], flags: node.args[2] ? literal(node.args[2]) : '', not: false });
        if ((node.name === 'DATE_ADD' || node.name === 'DATE_SUB' || node.name === 'ADDDATE' || node.name === 'SUBDATE') && node.args[1] && node.args[1].type === 'interval') {
          return dateMath(node.name.includes('SUB') ? '-' : '+', node.args[0], node.args[1], ctx);
        }
        const fn = SCALAR[node.name];
        if (!fn) fail(`Function ${node.name}() is not supported`);
        return fn(node.args.map(sub), node.name);
      }
      case 'binop': {
        if (node.right.type === 'interval' && (node.op === '+' || node.op === '-')) return dateMath(node.op, node.left, node.right, ctx);
        if (node.left.type === 'interval' && node.op === '+') return dateMath('+', node.right, node.left, ctx);
        const op = BINOPS[node.op];
        const assoc = op === '$add' || op === '$multiply' || op === '$concat';
        return { [op]: [node.left, node.right].flatMap((n) => { const v = sub(n); return assoc && isOnly(v, op) ? v[op] : [v]; }) };
      }
      case 'interval': fail('An INTERVAL can only be added to or subtracted from a date');
      case 'cast': return { [castOp(node.to)]: sub(node.expr) };
      case 'case': {
        const elseValue = node.else ? sub(node.else) : null;
        if (node.whens.length === 1) return { $cond: [sub(node.whens[0].when), sub(node.whens[0].then), elseValue] };
        return { $switch: { branches: node.whens.map((w) => ({ case: sub(w.when), then: sub(w.then) })), default: elseValue } };
      }
      case 'cmp':
        if (node.op === '@>') return { $setIsSubset: [sub(node.right), sub(node.left)] };
        if (node.op === '@@') fail('Full-text search can only be used in WHERE');
        return { [CMP[node.op]]: [sub(node.left), sub(node.right)] };
      case 'array': return node.items.map(sub);
      case 'any': return { $in: [sub(node.value), sub(node.array)] };
      case 'subscript': {
        const idx = literal(node.index);
        // (ARRAY_AGG(x ORDER BY y))[1] is the "first value in order" idiom -> $first / $last.
        if (ctx.aggRef && isAgg(node.expr) && node.expr.name === 'ARRAY_AGG' && node.expr.orderBy && idx === 1) {
          return ctx.aggRef({ ...node.expr, name: 'ARRAY_AGG_FIRST' });
        }
        return { $arrayElemAt: [sub(node.expr), typeof idx === 'number' ? idx - 1 : { $subtract: [sub(node.index), 1] }] };
      }
      case 'and': return { $and: node.items.map(sub) };
      case 'or': return { $or: node.items.map(sub) };
      case 'not': return { $not: [sub(node.expr)] };
      case 'in': return wrapNot({ $in: [sub(node.expr), node.list.map(sub)] }, node.not);
      case 'between': {
        const x = sub(node.expr);
        return wrapNot({ $and: [{ $gte: [x, sub(node.low)] }, { $lte: [x, sub(node.high)] }] }, node.not);
      }
      case 'isnull': return { [node.not ? '$ne' : '$eq']: [{ $ifNull: [sub(node.expr), null] }, null] };
      case 'like':
      case 'regex': {
        const p = literal(node.pattern);
        if (typeof p !== 'string') fail('LIKE / REGEXP patterns must be string literals');
        const regex = node.type === 'like' ? likeToRegex(p, node.ci) : makeRegex(p, node.flags);
        return wrapNot({ $regexMatch: { input: sub(node.expr), regex } }, node.not);
      }
      case 'subquery': {
        const { as, field } = subLookup(node.query, 'scalar', ctx);
        ctx.notes.push('A scalar subquery → $lookup with a pipeline; its single value is read with $arrayElemAt.');
        return { $arrayElemAt: [`$${as}.${field}`, 0] };
      }
      case 'exists': {
        const { as } = subLookup(node.query, 'exists', ctx);
        return { $gt: [{ $size: '$' + as }, 0] };
      }
      case 'insub': {
        const { as, field } = subLookup(node.query, 'in', ctx);
        return wrapNot({ $in: [sub(node.expr), `$${as}.${field}`] }, node.not);
      }
      case 'window': fail('Window functions can only be used in the SELECT list');
      case 'fulltext': fail('Full-text search can only be used in WHERE');
    }
    fail('This expression is not supported');
  }

  function dateMath(op, dateNode, interval, ctx) {
    ctx.notes.push(`Date ${op === '+' ? '+' : '-'} INTERVAL → ${op === '+' ? '$dateAdd' : '$dateSubtract'} (MongoDB 5.0+).`);
    return { [op === '+' ? '$dateAdd' : '$dateSubtract']: { startDate: aggExpr(dateNode, ctx), unit: interval.unit, amount: interval.amount } };
  }

  // ---------------------------------------------------------------- SELECT

  function where(q, ctx) { return q.where ? toFilter(q.where, ctx) : {}; }

  function isCountAll(n) {
    return n.type === 'func' && n.name === 'COUNT' && !n.distinct &&
      (n.star || (n.args.length === 1 && n.args[0].type === 'lit' && n.args[0].value !== null));
  }

  // The select item an ORDER BY / GROUP BY entry points at, by alias or 1-based position.
  function selectTarget(q, expr) {
    if (expr.type === 'lit' && Number.isInteger(expr.value)) {
      const item = q.columns[expr.value - 1];
      if (!item || item.star) fail(`Position ${expr.value} does not match a SELECT column`);
      return item;
    }
    if (expr.type === 'col' && expr.parts.length === 1) {
      const n = expr.parts[0].toLowerCase();
      return q.columns.find((c) => c.alias && c.alias.toLowerCase() === n) || null;
    }
    return null;
  }

  // Resolves ORDER BY to a $sort spec, either before the final $project (source fields: `pre`)
  // or after it (output names: `post`).
  function planSort(q, outputs, ctx) {
    if (!q.orderBy.length) return {};
    const canon = ctx.scope.canon;
    const pre = {}, post = {};
    let preOk = true, postOk = true;
    for (const { expr, dir } of q.orderBy) {
      const target = selectTarget(q, expr);
      const node = target ? target.expr : expr;
      let f = null;
      try { f = ctx.fieldOf(node); } catch (e) { f = null; }
      if (f) pre[f] = dir; else preOk = false;
      const out = outputs.find((o) => (target ? o.item === target : canon(o.item.expr) === canon(node)));
      if (out) post[out.name] = dir; else postOk = false;
    }
    if (preOk) return { pre };
    if (postOk) return { post };
    fail('ORDER BY expression could not be translated — add it to SELECT with an alias and order by the alias');
  }

  function source(ref, env) {
    if (ref.subquery) return { query: ref.subquery, env };
    const cte = env.ctes.get(String(ref.name).toLowerCase());
    if (cte) return { query: cte.query, env: cte.env };
    return { coll: ref.name };
  }

  function withCtes(env, ctes) {
    if (!ctes || !ctes.length) return env;
    const map = new Map(env.ctes);
    for (const c of ctes) {
      // Each CTE sees only the ones defined before it (so `WITH users AS (SELECT ... FROM users)` works).
      map.set(c.name.toLowerCase(), { query: c.query, env: { ...env, ctes: new Map(map) } });
    }
    env.notes.push('WITH (CTE) → the CTE\'s pipeline is inlined where it is used.');
    return { ...env, ctes: map };
  }

  function compileQuery(q, env, outer) {
    env = withCtes(env, q.ctes);
    return q.type === 'union' ? compileUnion(q, env, outer) : compileSelect(q, env, outer);
  }

  // `FROM a, b WHERE a.x = b.y` -> an inner join on that equality instead of a cross product.
  function promoteCommaJoins(q) {
    if (!q.where || !q.joins.some((j) => j.kind === 'comma')) return q;
    const items = q.where.type === 'and' ? q.where.items.slice() : [q.where];
    const joins = q.joins.map((j) => {
      if (j.kind !== 'comma') return j;
      const a = j.table.alias.toLowerCase();
      const onJoin = (c) => c.type === 'col' && c.parts.length > 1 && c.parts[0].toLowerCase() === a;
      const idx = items.findIndex((e) => e.type === 'cmp' && e.op === '=' && e.left.type === 'col' && e.right.type === 'col' && onJoin(e.left) !== onJoin(e.right));
      if (idx < 0) return j;
      const on = items.splice(idx, 1)[0];
      return { kind: 'inner', table: j.table, on, fromComma: true };
    });
    const where = items.length === 0 ? null : items.length === 1 ? items[0] : { type: 'and', items };
    return { ...q, joins, where };
  }

  function normalizeJoins(q, notes) {
    q = promoteCommaJoins(q);
    if (q.joins.some((j) => j.fromComma)) notes.push('FROM a, b WHERE a.x = b.y → treated as JOIN ... ON a.x = b.y ($lookup).');
    if (!q.joins.some((j) => j.kind === 'right' || j.kind === 'full')) return q;
    if (q.joins.some((j) => j.kind === 'full')) fail('FULL OUTER JOIN has no $lookup equivalent — combine a LEFT JOIN with $unionWith of the unmatched documents');
    if (q.joins.length !== 1) fail('RIGHT JOIN is only supported as the single join — rewrite it as a LEFT JOIN');
    const j = q.joins[0];
    return { ...q, from: j.table, joins: [{ kind: 'left', table: q.from, on: j.on }] };
  }

  // Compiles a SELECT into { coll, stages, outputs } where outputs are the result field names
  // (null for SELECT *).
  const isRandomOrder = (q) => q.orderBy.length === 1 && q.orderBy[0].expr.type === 'func' && ['RANDOM', 'RAND', 'NEWID'].includes(q.orderBy[0].expr.name);

  function compileSelect(q, env, outer) {
    if (isRandomOrder(q)) {
      if (q.limit == null) fail('ORDER BY RANDOM() needs a LIMIT — it becomes $sample: { size: n }');
      env.notes.push('ORDER BY RANDOM() LIMIT n → $sample: { size: n }.');
      const c = compileSelect({ ...q, orderBy: [], limit: null }, env, outer);
      c.stages.push({ $sample: { size: q.limit } });
      return c;
    }
    if (q.joins.some((j) => j.kind === 'right')) env.notes.push('RIGHT JOIN → swapped into a LEFT JOIN ($lookup from the right-hand table).');
    q = normalizeJoins(q, env.notes);
    const src = source(q.from, env);
    let coll;
    const stages = [];
    if (src.query) {
      const inner = compileQuery(src.query, src.env);
      coll = inner.coll;
      stages.push(...inner.stages);
      if (q.from.subquery) env.notes.push('A subquery in FROM → its pipeline runs first, the outer query continues it.');
    } else coll = src.coll;

    const scope = makeScope(q.from, q.joins, outer);
    const ctx = makeCtx(scope, env);
    const grouped = q.groupBy.length > 0 || q.distinct || !!q.having ||
      q.columns.some((c) => !c.star && containsAgg(c.expr)) || q.orderBy.some((o) => containsAgg(o.expr));

    // WHERE conditions on the main collection alone run before the joins, so fewer documents get joined.
    let early = null, late = q.where;
    if (q.where && q.joins.length && !containsSub(q.where)) {
      const items = q.where.type === 'and' ? q.where.items : [q.where];
      const touches = items.map((item) => { scope.joinTouched = false; toFilter(item, ctx); return scope.joinTouched; });
      const pick = (want) => {
        const list = items.filter((_, i) => touches[i] === want);
        return list.length === 0 ? null : list.length === 1 ? list[0] : { type: 'and', items: list };
      };
      early = pick(false);
      late = pick(true);
      if (early && late) env.notes.push('Optimized: conditions on the main collection run in a $match before $lookup, so fewer documents are joined.');
    }
    scope.joinTouched = false;
    const earlyFilter = early ? toFilter(early, ctx) : null;
    if (earlyFilter && !isEmpty(earlyFilter)) stages.push({ $match: earlyFilter });
    const filter = late ? toFilter(late, ctx) : null;
    const whereStages = filter || ctx.pending.length ? flushPending(ctx, filter && !isEmpty(filter) ? { $match: filter } : null) : [];
    if (filter || earlyFilter) env.notes.push('WHERE → $match.');
    const needsJoin = scope.joinTouched;
    if (!needsJoin) stages.push(...whereStages);
    for (const j of q.joins) stages.push(...lookupStages(j, scope, ctx));
    if (needsJoin) stages.push(...whereStages);

    const hasWindow = q.columns.some((c) => !c.star && containsWindow(c.expr));
    if (grouped && hasWindow) fail('Window functions combined with GROUP BY are not supported — group in a subquery (FROM (SELECT ...)) first');
    let outputs;
    if (grouped) {
      outputs = groupStages(q, ctx, stages);
      const better = !outer && !src.query && groupBeforeJoin(q, coll, stages, env);
      if (better) { coll = better.coll; stages.splice(0, stages.length, ...better.stages); }
    } else {
      if (hasWindow) stages.push(...windowStages(q, ctx));
      outputs = projectStages(q, ctx, stages);
    }
    return { coll, stages: mergeMatches(stages), outputs };
  }

  // ---------------------------------------------------------------- pipeline optimizations

  // Adjacent $match stages become one.
  function mergeMatches(stages) {
    const out = [];
    for (const s of stages) {
      const prev = out[out.length - 1];
      if (prev && isOnly(prev, '$match') && isOnly(s, '$match')) {
        const a = prev.$match, b = s.$match;
        const clash = Object.keys(b).some((k) => k in a);
        out[out.length - 1] = { $match: clash ? { $and: [a, b] } : { ...a, ...b } };
      } else out.push(s);
    }
    return out;
  }

  // Field paths read by an expression ("$a.b" -> "a.b"); $$variables are skipped.
  function exprRefs(v, out = []) {
    if (typeof v === 'string') { if (v.startsWith('$') && !v.startsWith('$$')) out.push(v.slice(1)); }
    else if (Array.isArray(v)) v.forEach((x) => exprRefs(x, out));
    else if (isPlain(v)) Object.values(v).forEach((x) => exprRefs(x, out));
    return out;
  }
  function mapExpr(v, map) {
    if (typeof v === 'string') return v.startsWith('$') && !v.startsWith('$$') ? '$' + map(v.slice(1)) : v;
    if (Array.isArray(v)) return v.map((x) => mapExpr(x, map));
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapExpr(x, map)]));
    return v;
  }
  // Splits a $match filter into single-condition pieces ($and is flattened).
  function matchUnits(m) {
    return Object.entries(m).flatMap(([k, v]) => (k === '$and' ? v.flatMap(matchUnits) : [{ [k]: v }]));
  }
  // The field paths a filter piece depends on, or null when it can't be analysed.
  function matchRefs(u) {
    const [[k, v]] = Object.entries(u);
    if (k === '$expr') return exprRefs(v);
    if (k === '$or' || k === '$nor') {
      const parts = v.map((m) => matchUnits(m).map(matchRefs));
      return parts.flat(2).includes(null) ? null : parts.flat(2);
    }
    return k.startsWith('$') ? null : [k];
  }
  function mapMatch(m, map) {
    return Object.fromEntries(Object.entries(m).map(([k, v]) => {
      if (k === '$expr') return [k, mapExpr(v, map)];
      if (k === '$and' || k === '$or' || k === '$nor') return [k, v.map((x) => mapMatch(x, map))];
      return [map(k), v];
    }));
  }
  const andMatch = (units) => (units.length ? [{ $match: units.reduce((acc, u) => mergeMatches([{ $match: acc }, { $match: u }])[0].$match, {}) }] : []);

  // GROUP BY over an inner join: group the table being aggregated first, then join the other one
  // (one $lookup per group instead of one per row). Returns null when the rewrite doesn't apply.
  function groupBeforeJoin(q, coll, stages, env) {
    if (q.joins.length !== 1 || !q.groupBy.length) return null;
    const j = q.joins[0];
    if (j.kind !== 'inner' || j.table.unnest || j.table.lateral || source(j.table, env).query) return null;
    const gi = stages.findIndex((s) => isOnly(s, '$group'));
    const li = stages.findIndex((s) => isOnly(s, '$lookup'));
    if (gi < 0 || li < 0 || gi < li) return null;
    const L = stages[li].$lookup, A = L.as;
    if (!L.localField || stages[li + 1].$unwind !== '$' + A) return null;
    const before = [...stages.slice(0, li), ...stages.slice(li + 2, gi)];
    if (!before.every((s) => isOnly(s, '$match'))) return null;
    const G = stages[gi].$group, rest = stages.slice(gi + 1);
    if (G._id === null || typeof G._id !== 'string' && !isPlain(G._id)) return null;

    const onJoined = (p) => p === A || p.startsWith(A + '.');
    const sideOf = (refs) => {
      const sides = new Set(refs.map((p) => (onJoined(p) ? 'J' : 'B')));
      return sides.size > 1 ? null : sides.size ? [...sides][0] : '';
    };
    // The "fact" side is the one the aggregates read; the other ("dim") side is joined afterwards.
    const accRefs = Object.entries(G).filter(([k]) => k !== '_id').flatMap(([, v]) => exprRefs(v));
    const accSide = sideOf(accRefs);
    if (accSide === null || accRefs.includes(A)) return null;
    const fact = accSide || 'B';
    const bAlias = q.from.alias || coll;
    const factMap = fact === 'J' ? (p) => p.slice(A.length + 1) : (p) => p;
    const dimMap = fact === 'J' ? (p) => bAlias + '.' + p : (p) => p;
    const factKey = fact === 'J' ? A + '.' + L.foreignField : L.localField;
    const dimKey = fact === 'J' ? L.localField : A + '.' + L.foreignField;
    const dimAs = fact === 'J' ? bAlias : A;

    // Group keys: dim-side join key -> fact-side join key; other dim columns are read after the join.
    const single = typeof G._id === 'string';
    const entries = single ? [['', G._id]] : Object.entries(G._id);
    const newId = {}, dimFields = {};
    let keyName = null;
    for (const [name, v] of entries) {
      const side = sideOf(exprRefs(v));
      if (side === null) return null;
      if (side === (fact === 'J' ? 'B' : 'J')) {
        if (typeof v !== 'string') return null;
        const path = v.slice(1);
        if (path === dimKey) { newId[name] = '$' + factMap(factKey); keyName = name; }
        else dimFields[name] = dimMap(path);
      } else {
        newId[name] = mapExpr(v, factMap);
        if (v === '$' + factKey) keyName = name;
      }
    }
    if (keyName === null || (single && Object.keys(dimFields).length)) return null;

    const factUnits = [], dimUnits = [];
    for (const u of before.flatMap((s) => matchUnits(s.$match))) {
      const refs = matchRefs(u);
      const side = refs && sideOf(refs);
      if (!side) return null;
      if (side === fact) factUnits.push(mapMatch(u, factMap)); else dimUnits.push(mapMatch(u, dimMap));
    }

    // Later stages read dropped group keys ("$_id.name") from the joined document instead, and when
    // only the join key is left, _id becomes that value itself.
    const dropped = Object.keys(dimFields);
    const collapse = !single && Object.keys(newId).length === 1;
    const under = (p, n) => p === '_id.' + n || p.startsWith('_id.' + n + '.');
    const dimPath = (p) => dropped.some((d) => under(p, d));
    const fixPath = (p) => {
      const n = dropped.find((d) => under(p, d));
      if (n) return dimFields[n] + p.slice(4 + n.length);
      return collapse && under(p, keyName) ? '_id' + p.slice(4 + keyName.length) : p;
    };
    const fixStage = (s) => {
      const [[op, body]] = Object.entries(s);
      if (op === '$match') return { $match: mapMatch(body, fixPath) };
      if (op === '$sort') return { $sort: Object.fromEntries(Object.entries(body).map(([k, d]) => [fixPath(k), d])) };
      return { [op]: mapExpr(body, fixPath) };
    };
    if ((dropped.length || collapse) && rest.some((s) => exprRefs(s).includes('_id'))) return null;
    let lead = 0;
    while (lead < rest.length && isOnly(rest[lead], '$match') && !exprRefs(rest[lead]).concat(Object.keys(rest[lead].$match)).some(dimPath)) lead++;

    const group = { _id: single ? newId[''] : collapse ? Object.values(newId)[0] : newId, ...Object.fromEntries(Object.entries(G).filter(([k]) => k !== '_id').map(([k, v]) => [k, mapExpr(v, factMap)])) };
    const lookup = {
      from: fact === 'J' ? coll : L.from,
      localField: single || collapse ? '_id' : '_id.' + keyName,
      foreignField: fact === 'J' ? L.localField : L.foreignField,
      as: dimAs,
    };
    const dimTable = fact === 'J' ? q.from.name || coll : j.table.name || L.from;
    env.notes.push(`Optimized: $group runs before $lookup, so ${lookup.from} is joined once per group instead of once per row. ` +
      `This assumes ${dimTable}.${lookup.foreignField} is unique (true for _id or a primary key).`);
    return {
      coll: fact === 'J' ? L.from : coll,
      stages: [
        ...andMatch(factUnits),
        { $group: group },
        ...rest.slice(0, lead).map(fixStage),
        { $lookup: lookup },
        { $unwind: '$' + dimAs },
        ...andMatch(dimUnits),
        ...rest.slice(lead).map(fixStage),
      ],
    };
  }

  function compileUnion(q, env, outer) {
    const first = compileQuery(q.parts[0], env, outer);
    const names = first.outputs;
    const stages = first.stages.slice();
    for (const part of q.parts.slice(1)) {
      const c = compileQuery(part, env, outer);
      const pipeline = c.stages.slice();
      if (names && c.outputs && c.outputs.join('\u0000') !== names.join('\u0000')) {
        if (c.outputs.length !== names.length) fail('Each side of a UNION must select the same number of columns');
        pipeline.push({ $project: Object.fromEntries([['_id', 0], ...names.map((n, i) => [n, '$' + c.outputs[i]])]) });
      }
      stages.push({ $unionWith: pipeline.length ? { coll: c.coll, pipeline } : c.coll });
    }
    env.notes.push('UNION ALL → $unionWith, which appends another collection\'s pipeline results.');
    if (!q.all) {
      stages.push({ $group: { _id: '$$ROOT' } }, { $replaceRoot: { newRoot: '$_id' } });
      env.notes.push('UNION (without ALL) removes duplicates → $group on the whole document ($$ROOT) + $replaceRoot.');
    }
    if (q.orderBy.length) {
      const sort = {};
      for (const { expr, dir } of q.orderBy) {
        let name;
        if (expr.type === 'lit' && Number.isInteger(expr.value) && names) name = names[expr.value - 1];
        else if (expr.type === 'col') name = expr.parts[expr.parts.length - 1];
        if (!name) fail('ORDER BY after UNION must name an output column');
        sort[name] = dir;
      }
      stages.push({ $sort: sort });
    }
    if (q.offset != null) stages.push({ $skip: q.offset });
    if (q.limit != null) stages.push({ $limit: q.limit });
    return { coll: first.coll, stages, outputs: names };
  }

  function lookupStages(j, scope, ctx) {
    const alias = j.table.alias;
    const preserve = j.kind === 'left';
    const onTrue = !j.on || (j.on.type === 'lit' && j.on.value === true);
    if (j.table.unnest) {
      if (!onTrue) fail('JOIN UNNEST(...) only supports ON TRUE — filter in WHERE instead');
      const path = scope.plain(j.table.unnest).path;
      if (!path) fail('UNNEST() needs a column of the main table');
      ctx.notes.push(`UNNEST(array) → $unwind: one document per array element${preserve ? ' (LEFT JOIN keeps documents with empty arrays via preserveNullAndEmptyArrays)' : ''}.`);
      const idx = j.table.ordinality;
      if (idx) {
        ctx.notes.push('WITH ORDINALITY → includeArrayIndex (0-based in MongoDB, so 1 is added to match SQL\'s 1-based position).');
        const spec = { path: '$' + path, includeArrayIndex: idx };
        if (preserve) spec.preserveNullAndEmptyArrays = true;
        return [{ $unwind: spec }, { $set: { [idx]: { $add: ['$' + idx, 1] } } }];
      }
      return [{ $unwind: preserve ? { path: '$' + path, preserveNullAndEmptyArrays: true } : '$' + path }];
    }
    if (j.table.lateral) {
      if (!onTrue) fail('LATERAL joins only support ON TRUE — put conditions inside the subquery');
      const outer = outerRef(scope);
      const inner = compileQuery(j.table.subquery, ctx.env, outer);
      const lookup = { from: inner.coll };
      if (Object.keys(outer.lets).length) lookup.let = outer.lets;
      lookup.pipeline = inner.stages;
      lookup.as = alias;
      ctx.notes.push('A LATERAL subquery join → $lookup with let + pipeline (references to the outer row become $$variables), then $unwind.');
      return [{ $lookup: lookup }, { $unwind: preserve ? { path: '$' + alias, preserveNullAndEmptyArrays: true } : '$' + alias }];
    }
    const src = source(j.table, ctx.env);
    if (j.kind === 'cross' || j.kind === 'comma') {
      const inner = src.query ? compileQuery(src.query, src.env) : { coll: src.coll, stages: [] };
      ctx.notes.push(j.kind === 'comma'
        ? 'FROM a, b → a cross join ($lookup with an empty pipeline + $unwind); the WHERE clause then filters the pairs. JOIN ... ON is usually faster.'
        : 'CROSS JOIN → $lookup with an empty pipeline + $unwind (every pair of documents).');
      return [{ $lookup: { from: inner.coll, pipeline: inner.stages, as: alias } }, { $unwind: '$' + alias }];
    }
    const unwind = { $unwind: preserve ? { path: '$' + alias, preserveNullAndEmptyArrays: true } : '$' + alias };
    const on = j.on;
    const isJoinSide = (c) => c.type === 'col' && c.parts.length > 1 && c.parts[0].toLowerCase() === alias.toLowerCase();
    const isOtherSide = (c) => c.type === 'col' && !isJoinSide(c) && scope.path(c) !== null;
    if (!src.query && on.type === 'cmp' && on.op === '=') {
      let local = null, foreign = null;
      if (isJoinSide(on.right) && isOtherSide(on.left)) { local = on.left; foreign = on.right; }
      else if (isJoinSide(on.left) && isOtherSide(on.right)) { local = on.right; foreign = on.left; }
      if (local) {
        ctx.notes.push('JOIN ... ON a.x = b.y → $lookup (localField / foreignField) + $unwind for one document per match. LEFT JOIN keeps unmatched documents via preserveNullAndEmptyArrays.');
        return [
          { $lookup: { from: src.coll, localField: scope.path(local), foreignField: foreign.parts.slice(1).join('.'), as: alias } },
          unwind,
        ];
      }
    }
    // General form: evaluate the ON condition inside the joined collection, with outer values via `let`.
    const inner = src.query ? compileQuery(src.query, src.env) : { coll: src.coll, stages: [] };
    const outer = outerRef(scope);
    const jscope = makeScope({ name: j.table.name, alias }, [], outer);
    const jctx = makeCtx(jscope, ctx.env);
    const cond = toFilter(on, jctx);
    const lookup = { from: inner.coll };
    if (Object.keys(outer.lets).length) lookup.let = outer.lets;
    lookup.pipeline = [...inner.stages, ...flushPending(jctx, { $match: cond })];
    lookup.as = alias;
    ctx.notes.push('JOIN with a complex ON (or a joined subquery/CTE) → $lookup with let + pipeline; outer columns become $$variables.');
    return [{ $lookup: lookup }, unwind];
  }

  function finish(stages, shape, sort, q, beforeShape = []) {
    if (sort.pre) stages.push({ $sort: sort.pre });
    if (sort.post) {
      stages.push(...beforeShape);
      beforeShape = [];
      if (shape) stages.push(shape);
      shape = null;
      stages.push({ $sort: sort.post });
    }
    if (q.offset != null) stages.push({ $skip: q.offset });
    if (q.limit != null) stages.push({ $limit: q.limit });
    stages.push(...beforeShape);
    if (shape) stages.push(shape);
  }

  // Numbers and booleans in $project mean include/exclude, so literal values need $literal.
  const projValue = (v) => (typeof v === 'number' || typeof v === 'boolean' || v === null ? { $literal: v } : v);

  function projectStages(q, ctx, stages) {
    const star = q.columns.some((c) => c.star);
    const taken = new Set();
    const outputs = [];
    let withId = false;
    for (const item of q.columns) {
      if (item.star) continue;
      const e = item.expr;
      const p = e.type === 'col' ? ctx.fieldOf(e) : null;
      if (p) {
        // A column that resolves to a different field (e.g. an UNNEST alias) keeps the name it was selected by.
        const alias = item.alias || (p.split('.').pop() !== lastPart(e) ? lastPart(e) : null);
        if (!alias || alias === p) {
          if (p === '_id') withId = true;
          taken.add(p);
          outputs.push({ item, name: p, value: 1, plain: true });
        } else {
          outputs.push({ item, name: uniqueName(alias, taken), value: '$' + p });
        }
        continue;
      }
      const value = aggExpr(e, ctx);
      const name = uniqueName(item.alias || defaultName(e), taken);
      outputs.push({ item, name, value: value === '$' + name ? 1 : projValue(value), plain: value === '$' + name });
    }
    const pending = flushPending(ctx, null, star);
    const sort = planSort(q, outputs, ctx);
    let shape = null;
    if (!star) {
      shape = { $project: Object.fromEntries(outputs.map((o) => [o.name, o.value])) };
      if (!withId) shape.$project._id = 0;
    } else {
      const computed = outputs.filter((o) => !o.plain);
      if (computed.length) shape = { $addFields: Object.fromEntries(computed.map((o) => [o.name, o.value])) };
    }
    if (star && pending.length && shape) {
      // Lookups must run before $addFields, and their helper fields are removed after it.
      const unset = pending.pop();
      finish(stages, shape, sort, q, pending);
      stages.push(unset);
    } else finish(stages, shape, sort, q, pending);
    return star ? null : outputs.map((o) => o.name);
  }

  function windowOutput(w, ctx) {
    const f = w.func;
    const arg = () => {
      if (!f.args[0]) fail(`${f.name}() needs an argument`);
      return aggExpr(f.args[0], ctx);
    };
    let spec, cumulative = false;
    switch (f.name) {
      case 'ROW_NUMBER': spec = { $documentNumber: {} }; break;
      case 'RANK': spec = { $rank: {} }; break;
      case 'DENSE_RANK': spec = { $denseRank: {} }; break;
      case 'LAG': case 'LEAD': {
        const n = f.args[1] ? literal(f.args[1]) : 1;
        if (typeof n !== 'number') fail(`${f.name}() offset must be a number`);
        const def = f.args[2] ? literal(f.args[2]) : null;
        spec = { $shift: { output: arg(), by: f.name === 'LAG' ? -n : n, default: def === NO ? null : def } };
        break;
      }
      case 'FIRST_VALUE': spec = { $first: arg() }; cumulative = true; break;
      case 'LAST_VALUE': spec = { $last: arg() }; cumulative = true; break;
      case 'COUNT': spec = isCountAll(f) ? { $sum: 1 } : { $sum: { $cond: [{ $eq: [{ $ifNull: [arg(), null] }, null] }, 0, 1] } }; cumulative = true; break;
      case 'SUM': case 'AVG': case 'MIN': case 'MAX': spec = { ['$' + f.name.toLowerCase()]: arg() }; cumulative = true; break;
      case 'STDDEV': case 'STDDEV_SAMP': spec = { $stdDevSamp: arg() }; cumulative = true; break;
      case 'STDDEV_POP': spec = { $stdDevPop: arg() }; cumulative = true; break;
      default: fail(`${f.name}() OVER (...) is not supported`);
    }
    if (!cumulative && !w.orderBy.length) fail(`${f.name}() needs ORDER BY inside OVER (...)`);
    if (cumulative) {
      if (w.frame) spec.window = { [w.frame.mode]: [w.frame.start, w.frame.end] };
      else if (w.orderBy.length) {
        spec.window = { documents: ['unbounded', 'current'] };
        ctx.notes.push('An aggregate OVER (... ORDER BY ...) is a running total → window: { documents: ["unbounded", "current"] }.');
      }
    }
    return spec;
  }

  function windowStages(q, ctx) {
    const canon = ctx.scope.canon;
    const taken = new Set();
    const windows = new Map();
    const groups = new Map();
    const collect = (node, alias) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'window') {
        const c = canon(node);
        if (windows.has(c)) return;
        const field = uniqueName(alias || defaultName(node), taken);
        const key = canon({ p: node.partitionBy, o: node.orderBy });
        if (!groups.has(key)) {
          const g = {};
          if (node.partitionBy.length === 1) g.partitionBy = aggExpr(node.partitionBy[0], ctx);
          else if (node.partitionBy.length) g.partitionBy = Object.fromEntries(node.partitionBy.map((p) => [defaultName(p), aggExpr(p, ctx)]));
          if (node.orderBy.length) {
            g.sortBy = {};
            for (const { expr, dir } of node.orderBy) {
              const f = ctx.fieldOf(expr);
              if (!f) fail('ORDER BY inside OVER (...) must use plain columns');
              g.sortBy[f] = dir;
            }
          }
          g.output = {};
          groups.set(key, g);
        }
        groups.get(key).output[field] = windowOutput(node, ctx);
        windows.set(c, field);
        return;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object' && !(v instanceof Raw)) collect(v);
    };
    for (const item of q.columns) if (!item.star) collect(item.expr, item.expr.type === 'window' ? item.alias : null);
    ctx.windows = windows;
    ctx.notes.push('Window functions (OVER) → $setWindowFields (MongoDB 5.0+); PARTITION BY → partitionBy, ORDER BY → sortBy.');
    return [...groups.values()].map((g) => ({ $setWindowFields: g }));
  }

  function accumulator(node, base, order) {
    const arg = node.args[0];
    const x = () => {
      if (!arg) fail(`${node.name}() needs an argument`);
      return aggExpr(arg, base);
    };
    if (node.orderBy) {
      const same = (a, b) => a.length === b.length && a.every((o, i) => base.scope.canon(o.expr) === base.scope.canon(b[i].expr));
      const reversed = same(node.orderBy, order) && node.orderBy.every((o, i) => o.dir === -order[i].dir);
      const forward = same(node.orderBy, order) && !reversed;
      if (node.name === 'ARRAY_AGG_FIRST') {
        if (!forward && !reversed) fail('Aggregates ordered in different ways are not supported in one GROUP BY');
        base.notes.push('(ARRAY_AGG(x ORDER BY y))[1] → $sort before $group, then $first (or $last for the reverse order).');
        return { acc: { [forward ? '$first' : '$last']: x() } };
      }
      if (!forward) fail('Aggregates ordered in different ways are not supported in one GROUP BY');
    }
    switch (node.name) {
      case 'COUNT':
        if (node.distinct) return { acc: { $addToSet: x() }, post: (r) => ({ $size: r }) };
        if (isCountAll(node)) return { acc: { $sum: 1 } };
        return { acc: { $sum: { $cond: [{ $eq: [{ $ifNull: [x(), null] }, null] }, 0, 1] } } };
      case 'STRING_AGG': case 'GROUP_CONCAT': case 'LISTAGG': {
        const sep = node.args[1] ? literal(node.args[1]) : ',';
        if (typeof sep !== 'string') fail(`${node.name}() separator must be a string literal`);
        base.notes.push(`${node.name}() → $push in $group, then $reduce joins the values into one string.`);
        return {
          acc: { [node.distinct ? '$addToSet' : '$push']: x() },
          post: (r) => ({ $reduce: { input: r, initialValue: '', in: { $concat: ['$$value', { $cond: [{ $eq: ['$$value', ''] }, '', sep] }, { $toString: '$$this' }] } } }),
        };
      }
      case 'ARRAY_AGG': return { acc: { [node.distinct ? '$addToSet' : '$push']: x() } };
      case 'STDDEV': case 'STDDEV_SAMP': return { acc: { $stdDevSamp: x() } };
      case 'STDDEV_POP': return { acc: { $stdDevPop: x() } };
    }
    if (node.distinct) fail(`${node.name}(DISTINCT ...) is not supported`);
    if (node.star || node.args.length !== 1) fail(`${node.name}() takes exactly one argument`);
    return { acc: { ['$' + node.name.toLowerCase()]: x() } };
  }

  function groupStages(q, ctx, stages) {
    const notes = ctx.notes;
    if (q.columns.some((c) => c.star)) fail('SELECT * cannot be combined with GROUP BY, DISTINCT or aggregate functions');
    const canon = ctx.scope.canon;
    const keyNodes = (q.groupBy.length ? q.groupBy : q.distinct ? q.columns.map((c) => c.expr) : [])
      .map((k) => { const t = selectTarget(q, k); return t ? t.expr : k; });

    const keyTaken = new Set();
    const keys = keyNodes.map((node) => {
      if (containsAgg(node)) fail('Aggregate functions are not allowed in GROUP BY');
      return { canon: canon(node), name: uniqueName(defaultName(node), keyTaken), value: aggExpr(node, ctx) };
    });
    keys.forEach((k) => { k.path = keys.length === 1 ? '_id' : '_id.' + k.name; });
    const group = { _id: keys.length === 0 ? null : keys.length === 1 ? keys[0].value : Object.fromEntries(keys.map((k) => [k.name, k.value])) };
    const preGroup = flushPending(ctx, null);

    const aggs = new Map();
    let aggOrder = null; // ORDER BY inside aggregates becomes one $sort before $group
    const fieldTaken = new Set(['_id']);
    const register = (node, preferred) => {
      const c = canon(node);
      if (!aggs.has(c)) {
        const field = uniqueName(preferred || defaultName(node.name === 'ARRAY_AGG_FIRST' ? node.args[0] || node : node), fieldTaken);
        if (node.orderBy && !aggOrder) aggOrder = node.orderBy;
        const { acc, post } = accumulator(node, ctx, aggOrder);
        aggs.set(c, { field, post });
        group[field] = acc;
      }
      return aggs.get(c);
    };
    const gctx = {
      scope: ctx.scope,
      env: ctx.env,
      notes,
      pending: [],
      pendingNames: [],
      fieldOf(node) {
        const k = keys.find((x) => x.canon === canon(node));
        if (k) return k.path;
        if (isAgg(node)) { const a = register(node); return a.post ? null : a.field; }
        if (node.type === 'col') fail(`Column "${node.parts.join('.')}" must appear in GROUP BY or be inside an aggregate function`);
        return null;
      },
      aggRef(node) { const a = register(node); return a.post ? a.post('$' + a.field) : '$' + a.field; },
    };

    // Register select-list aggregates first so their aliases become the field names.
    for (const c of q.columns) if (isAgg(c.expr)) register(c.expr, c.alias);
    const outTaken = new Set(['_id']);
    const outputs = q.columns.map((item) => {
      const k = keys.find((x) => x.canon === canon(item.expr));
      const preferred = item.alias || (k ? k.name : isAgg(item.expr) ? aggs.get(canon(item.expr)).field : defaultName(item.expr));
      return { item, name: uniqueName(preferred, outTaken), value: aggExpr(item.expr, gctx) };
    });

    const having = q.having ? toFilter(q.having, gctx) : null;
    const havingStages = flushPending(gctx, having ? { $match: having } : null);
    const sort = planSort(q, outputs, gctx);
    const selectLookups = flushPending(gctx, null, false);

    stages.push(...preGroup);
    if (aggOrder) {
      const sortBy = {};
      for (const { expr, dir } of aggOrder) {
        const f = ctx.fieldOf(expr);
        if (!f) fail('ORDER BY inside an aggregate must use plain columns');
        sortBy[f] = dir;
      }
      stages.push({ $sort: sortBy });
      notes.push('ORDER BY inside an aggregate → $sort before $group (accumulators keep input order).');
    }
    stages.push({ $group: group });
    notes.push(keys.length
      ? 'GROUP BY → $group; the grouping columns become _id and each aggregate becomes an accumulator ($sum, $avg...).'
      : 'Aggregates without GROUP BY → $group with _id: null (one group for all documents).');
    if (q.distinct && !q.groupBy.length) notes.push('SELECT DISTINCT → $group on the selected columns.');
    if (havingStages.length) {
      stages.push(...havingStages);
      notes.push('HAVING → $match placed after $group.');
    }
    const project = { _id: 0 };
    for (const o of outputs) project[o.name] = o.value === '$' + o.name ? 1 : projValue(o.value);
    finish(stages, { $project: project }, sort, q, selectLookups);
    return outputs.map((o) => o.name);
  }

  // Queries simple enough for find() / countDocuments() / distinct().
  function isSimple(q, env) {
    return q.type === 'select' && !(q.ctes && q.ctes.length) && !q.from.subquery && !isRandomOrder(q) && !env.ctes.has(String(q.from.name).toLowerCase()) &&
      !q.joins.length && !containsSub([q.where, q.having, q.columns, q.orderBy]) && !q.columns.some((c) => !c.star && containsWindow(c.expr));
  }

  function translateQuery(q, env) {
    if (isSimple(q, env)) {
      const scope = makeScope(q.from, [], null);
      const ctx = makeCtx(scope, env);
      const coll = collection(q.from.name);
      const anyAgg = q.columns.some((c) => !c.star && containsAgg(c.expr)) || containsAgg(q.having) || q.orderBy.some((o) => containsAgg(o.expr));
      const grouped = q.groupBy.length > 0 || anyAgg || q.distinct || !!q.having;
      if (!grouped) {
        const found = translateFind(q, scope, ctx, coll);
        if (found) return found;
      } else if (!q.groupBy.length && !q.having) {
        const only = q.columns.length === 1 && !q.columns[0].star ? q.columns[0].expr : null;
        if (only && !q.distinct && isCountAll(only)) {
          env.notes.push('COUNT(*) without GROUP BY → countDocuments().');
          const f = where(q, ctx);
          return `${coll}.countDocuments(${isEmpty(f) ? '' : fmtTop(f)})`;
        }
        if (only && q.distinct && only.type === 'col' && !q.orderBy.length && q.limit == null && q.offset == null) {
          env.notes.push('SELECT DISTINCT on one column → distinct(), which returns an array of the unique values.');
          const f = where(q, ctx);
          return `${coll}.distinct(${args(scope.path(only), isEmpty(f) ? undefined : f)})`;
        }
      }
    }
    const c = compileQuery(q, env);
    if (!c.stages.length) return `${collection(c.coll)}.find()`;
    return `${collection(c.coll)}.aggregate(${fmtPipeline(c.stages)})`;
  }

  function translateFind(q, scope, ctx, coll) {
    const star = q.columns.some((c) => c.star);
    const plain = q.columns.every((c) => c.star || (c.expr.type === 'col' && (!c.alias || c.alias === lastPart(c.expr))));
    if (!plain) return null;
    let sort;
    try { sort = planSort(q, [], ctx); } catch (e) { return null; }
    if (sort.post) return null;

    const filter = where(q, ctx);
    let proj = null;
    if (!star) {
      proj = {};
      let withId = false;
      for (const c of q.columns) {
        const p = scope.path(c.expr);
        if (p === '_id') withId = true; else proj[p] = 1;
      }
      if (!withId) { proj._id = 0; ctx.notes.push('MongoDB always returns _id unless the projection says _id: 0.'); }
      else if (isEmpty(proj)) proj._id = 1;
    }
    ctx.notes.push('SELECT → find(filter, projection); WHERE becomes the filter, the column list becomes the projection.');
    let out = `${coll}.find(${isEmpty(filter) && !proj ? '' : fmtTop(filter)}${proj ? ', ' + fmtTop(proj) : ''})`;
    if (sort.pre) {
      out += `.sort(${fmtTop(sort.pre)})`;
      ctx.notes.push('ORDER BY → sort() with 1 (ASC) / -1 (DESC).');
    }
    if (q.offset != null) out += `.skip(${q.offset})`;
    if (q.limit != null) out += `.limit(${q.limit})`;
    return out;
  }

  // ---------------------------------------------------------------- INSERT / UPDATE / DELETE

  function rowDocs(q) {
    if (!q.columns) fail('INSERT needs a column list, e.g. INSERT INTO users (name, age) VALUES (...) — documents need field names');
    return q.rows.map((row) => {
      if (row.length !== q.columns.length) fail(`Expected ${q.columns.length} values per row but got ${row.length}`);
      const doc = {};
      q.columns.forEach((c, i) => {
        const v = literal(row[i]);
        if (v === NO) fail('Only literal values are supported in INSERT ... VALUES');
        doc[c] = v;
      });
      return doc;
    });
  }

  function translateInsert(q, env) {
    const notes = env.notes;
    const coll = collection(q.table);
    if (q.returning) notes.push('RETURNING: insertOne() / insertMany() return the new _id values (insertedId / insertedIds).');
    if (q.query) {
      if (q.conflict) fail('INSERT ... SELECT ... ON CONFLICT is not supported');
      const c = compileQuery(q.query, withCtes(env, q.ctes));
      const stages = c.stages.slice();
      if (q.columns) {
        if (!c.outputs || c.outputs.length !== q.columns.length) fail('INSERT ... SELECT must select one column per target column');
        stages.push({ $project: Object.fromEntries([['_id', 0], ...q.columns.map((col, i) => [col, '$' + c.outputs[i]])]) });
      } else if (!c.outputs) stages.push({ $unset: '_id' });
      stages.push({ $merge: { into: q.table } });
      notes.push('INSERT ... SELECT → aggregate() ending in $merge, which writes the results into the target collection (MongoDB 4.2+).');
      return `${collection(c.coll)}.aggregate(${fmtPipeline(stages)})`;
    }
    const docs = rowDocs(q);
    if (q.conflict || q.replace) return translateUpsert(q, docs, notes);
    notes.push('Each row becomes a document; MongoDB adds an _id automatically if you don\'t provide one.');
    return docs.length === 1 ? `${coll}.insertOne(${fmtTop(docs[0])})` : `${coll}.insertMany(${fmtTop(docs)})`;
  }

  function translateUpsert(q, docs, notes) {
    const coll = collection(q.table);
    const c = q.replace ? { target: q.columns.includes('_id') ? ['_id'] : q.columns.includes('id') ? ['id'] : null, action: 'replace' } : q.conflict;
    if (!c.target) {
      fail(c.mysql || q.replace
        ? 'MySQL\'s ON DUPLICATE KEY UPDATE / REPLACE don\'t name the key — rewrite it as ON CONFLICT (column) DO UPDATE SET ...'
        : 'ON CONFLICT needs the conflict column(s), e.g. ON CONFLICT (email) DO NOTHING');
    }
    const ops = docs.map((doc) => {
      const filter = {};
      for (const k of c.target) {
        if (!(k in doc)) fail(`Conflict column "${k}" must be one of the inserted columns`);
        filter[k] = doc[k];
      }
      if (c.action === 'replace') return { method: 'replaceOne', filter, update: omit(doc, ['_id']) };
      if (c.action === 'nothing') return { method: 'updateOne', filter, update: { $setOnInsert: omit(doc, c.target) } };
      const set = {}, inc = {};
      const excluded = (n) => {
        if (n.type === 'col' && n.parts.length === 2 && n.parts[0].toUpperCase() === 'EXCLUDED') return { value: doc[n.parts[1]] };
        if (n.type === 'func' && n.name === 'VALUES' && n.args[0] && n.args[0].type === 'col') return { value: doc[lastPart(n.args[0])] };
        const v = literal(n);
        return v === NO ? null : { value: v };
      };
      for (const { column, value } of c.sets) {
        const f = lastPart(column);
        const direct = excluded(value);
        if (direct) { set[f] = direct.value; continue; }
        if (value.type === 'binop' && (value.op === '+' || value.op === '-') && value.left.type === 'col' && lastPart(value.left) === f) {
          const amount = excluded(value.right);
          if (amount && typeof amount.value === 'number') { inc[f] = value.op === '-' ? -amount.value : amount.value; continue; }
        }
        fail('DO UPDATE SET supports EXCLUDED.column, literal values and column + n');
      }
      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(inc).length) update.$inc = inc;
      const onInsert = omit(doc, [...c.target, ...Object.keys(set), ...Object.keys(inc)]);
      if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
      return { method: 'updateOne', filter, update };
    });
    notes.push(c.action === 'replace'
      ? 'REPLACE → replaceOne(..., { upsert: true }).'
      : 'INSERT ... ON CONFLICT → updateOne(filter, update, { upsert: true }): the conflict columns become the filter, $setOnInsert holds the values used only when inserting.');
    if (ops.length === 1) {
      const o = ops[0];
      return `${coll}.${o.method}(${args(o.filter, o.update, { upsert: true })})`;
    }
    notes.push('Several rows → bulkWrite() with one upsert per row.');
    return `${coll}.bulkWrite(${fmtTop(ops.map((o) => ({ [o.method]: o.method === 'replaceOne' ? { filter: o.filter, replacement: o.update, upsert: true } : { filter: o.filter, update: o.update, upsert: true } })))})`;
  }

  // `col = col + n` style assignments map to $inc / $mul.
  function selfArithmetic(value, path, scope) {
    if (value.type !== 'binop' || !['+', '-', '*'].includes(value.op)) return null;
    const isSelf = (n) => n.type === 'col' && scope.path(n) === path;
    const num = (n) => (n.type === 'lit' && typeof n.value === 'number' ? n.value : null);
    let n = null;
    if (isSelf(value.left)) n = num(value.right);
    else if (value.op !== '-' && isSelf(value.right)) n = num(value.left);
    if (n === null) return null;
    if (value.op === '*') return { op: '$mul', n };
    return { op: '$inc', n: value.op === '-' ? -n : n };
  }

  // PostgreSQL array updates on the same column -> $push / $pull.
  function arrayUpdate(value, path, scope) {
    const isSelf = (n) => n && n.type === 'col' && scope.path(n) === path;
    // CASE WHEN v = ANY(arr) THEN arr ELSE ARRAY_APPEND(arr, v) END -> $addToSet
    if (value.type === 'case' && value.whens.length === 1 && value.else) {
      const w = value.whens[0];
      const v = w.when.type === 'any' && isSelf(w.when.array) ? literal(w.when.value) : NO;
      const app = arrayUpdate(value.else, path, scope);
      if (v !== NO && isSelf(w.then) && app && app.op === '$push' && app.n === v) return { op: '$addToSet', n: v };
    }
    if (value.type === 'func' && isSelf(value.args[0]) && value.args[1]) {
      const v = literal(value.args[1]);
      if (v === NO) return null;
      if (value.name === 'ARRAY_APPEND') return { op: '$push', n: v };
      if (value.name === 'ARRAY_REMOVE') return { op: '$pull', n: v };
    }
    if (value.type === 'binop' && value.op === '||' && isSelf(value.left)) {
      const v = literal(value.right);
      if (Array.isArray(v)) return { op: '$push', n: { $each: v } };
    }
    return null;
  }

  function translateUpdate(q, env) {
    const notes = env.notes;
    const scope = makeScope(q.table, [], null);
    const ctx = makeCtx(scope, withCtes(env, q.ctes));
    const filter = where(q, ctx);
    if (ctx.pending.length) fail('Subqueries in UPDATE ... WHERE are not supported — use an aggregation with $merge');
    const ops = {};
    let needsPipeline = false;
    for (const { column, value } of q.sets) {
      const f = scope.path(column);
      const v = literal(value);
      const step = v === NO ? selfArithmetic(value, f, scope) || arrayUpdate(value, f, scope) : null;
      if (v !== NO) (ops.$set = ops.$set || {})[f] = idValue(f, v, notes);
      else if (step) (ops[step.op] = ops[step.op] || {})[f] = step.n;
      else needsPipeline = true;
    }
    if (ops.$push || ops.$pull) notes.push('Array updates (ARRAY_APPEND / || / ARRAY_REMOVE) → $push / $pull.');
    let update = ops;
    if (needsPipeline) {
      update = [{ $set: Object.fromEntries(q.sets.map(({ column, value }) => [scope.path(column), projValue(aggExpr(value, ctx))])) }];
      if (ctx.pending.length) fail('Subqueries in UPDATE ... SET are not supported');
      notes.push('SET with expressions → an update pipeline ([{ $set: ... }]) so values can reference other fields (MongoDB 4.2+).');
    } else {
      if (ops.$set) notes.push('SET column = value → $set.');
      if (ops.$inc) notes.push('SET column = column + n → $inc.');
      if (ops.$mul) notes.push('SET column = column * n → $mul.');
    }
    if (!q.where) notes.push('No WHERE clause: every document is updated.');
    const coll = collection(q.table.name);
    if (q.returning) {
      notes.push('UPDATE ... RETURNING → findOneAndUpdate() returns the document (one at a time; updateMany() returns only counts).');
      return `${coll}.findOneAndUpdate(${args(filter, update, { returnDocument: 'after' })})`;
    }
    const method = q.limit === 1 ? 'updateOne' : 'updateMany';
    notes.push(method === 'updateMany' ? 'SQL UPDATE changes every matching row → updateMany().' : 'LIMIT 1 → updateOne() (changes only the first match).');
    return `${coll}.${method}(${args(filter, update)})`;
  }

  function translateDelete(q, env) {
    const notes = env.notes;
    const ctx = makeCtx(makeScope(q.table, [], null), withCtes(env, q.ctes));
    const filter = where(q, ctx);
    if (ctx.pending.length) fail('Subqueries in DELETE ... WHERE are not supported');
    if (!q.where) notes.push('No WHERE clause: every document is deleted.');
    const coll = collection(q.table.name);
    if (q.returning) {
      notes.push('DELETE ... RETURNING → findOneAndDelete() returns the removed document (one at a time).');
      return `${coll}.findOneAndDelete(${fmtTop(filter)})`;
    }
    const method = q.limit === 1 ? 'deleteOne' : 'deleteMany';
    notes.push(`DELETE → ${method}(filter).`);
    return `${coll}.${method}(${fmtTop(filter)})`;
  }

  // ---------------------------------------------------------------- DDL

  const BSON_TYPES = [
    [/^(INT|INTEGER|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|SERIAL|SMALLSERIAL|YEAR)$/, 'int'],
    [/^(BIGINT|INT8|BIGSERIAL)$/, 'long'],
    [/^(DECIMAL|NUMERIC|MONEY|DEC)$/, 'decimal'],
    [/^(FLOAT|FLOAT4|FLOAT8|REAL|DOUBLE)$/, 'double'],
    [/^(VARCHAR|CHAR|CHARACTER|TEXT|NVARCHAR|NCHAR|STRING|UUID|CLOB|TINYTEXT|MEDIUMTEXT|LONGTEXT|ENUM|CITEXT)$/, 'string'],
    [/^(DATE|TIMESTAMP|DATETIME|TIMESTAMPTZ|TIME)$/, 'date'],
    [/^(BOOLEAN|BOOL|BIT)$/, 'bool'],
    [/^(JSON|JSONB)$/, 'object'],
    [/^(BLOB|BYTEA|BINARY|VARBINARY|LONGBLOB)$/, 'binData'],
  ];

  function bsonType(type) {
    if (type.array) return 'array';
    const hit = BSON_TYPES.find(([re]) => re.test(type.name));
    return hit ? hit[1] : null;
  }

  function columnSchema(col, notes) {
    const t = bsonType(col.type);
    const p = {};
    if (t) p.bsonType = col.notNull || col.pk ? t : [t, 'null'];
    else notes.push(`Type ${col.type.name} has no BSON equivalent, so "${col.name}" is left unconstrained.`);
    if (t === 'array') {
      const item = bsonType({ ...col.type, array: false });
      if (item) p.items = { bsonType: item };
    }
    if (t === 'string' && /CHAR$/.test(col.type.name) && typeof col.type.args[0] === 'number') p.maxLength = col.type.args[0];
    if (col.type.name === 'ENUM' && col.type.args.length) p.enum = col.type.args;
    return p;
  }

  // CHECK (...) rules that $jsonSchema can express: ranges, IN lists and lengths.
  function applyCheck(expr, properties, notes) {
    const items = expr.type === 'and' ? expr.items : [expr];
    const prop = (n) => (n && n.type === 'col' ? properties[lastPart(n)] : null);
    const bounds = { '>=': ['minimum'], '>': ['minimum', 'exclusiveMinimum'], '<=': ['maximum'], '<': ['maximum', 'exclusiveMaximum'] };
    for (const e of items) {
      if (e.type === 'cmp' && bounds[e.op] && typeof literal(e.right) === 'number') {
        const lengthFn = e.left.type === 'func' && ['LENGTH', 'CHAR_LENGTH', 'LEN'].includes(e.left.name);
        const p = prop(lengthFn ? e.left.args[0] : e.left);
        if (p) {
          const [k, exclusive] = bounds[e.op];
          if (lengthFn) p[k === 'minimum' ? 'minLength' : 'maxLength'] = literal(e.right) + (exclusive ? (k === 'minimum' ? 1 : -1) : 0);
          else { p[k] = literal(e.right); if (exclusive) p[exclusive] = true; }
          continue;
        }
      }
      if (e.type === 'between' && !e.not && prop(e.expr) && typeof literal(e.low) === 'number' && typeof literal(e.high) === 'number') {
        Object.assign(prop(e.expr), { minimum: literal(e.low), maximum: literal(e.high) });
        continue;
      }
      if (e.type === 'in' && !e.not && prop(e.expr) && !e.list.map(literal).includes(NO)) {
        const p = prop(e.expr);
        p.enum = e.list.map(literal);
        if (Array.isArray(p.bsonType) && p.bsonType.includes('null')) p.enum.push(null);
        continue;
      }
      notes.push('A CHECK constraint that $jsonSchema can\'t express was skipped (ranges, IN lists and lengths are translated).');
    }
  }

  function translateCreateTable(st, env) {
    const notes = env.notes;
    const required = [];
    const properties = {};
    const indexes = [];
    const pk = st.pk.slice();
    for (const col of st.columns) {
      properties[col.name] = columnSchema(col, notes);
      if ((col.notNull || col.pk) && !col.autoInc) required.push(col.name);
      if (col.pk) pk.push(col.name);
      if (col.unique) indexes.push([col.name]);
      if (col.def !== undefined) notes.push('Column DEFAULT values aren\'t enforced by MongoDB — set them in the insert (or with $setOnInsert).');
      if (col.autoInc) notes.push('Auto-increment / SERIAL columns don\'t exist in MongoDB — the automatic _id (ObjectId) is the usual key.');
      if (col.references) notes.push(`REFERENCES ${col.references}: MongoDB has no foreign keys — store the referenced _id and join with $lookup.`);
    }
    for (const check of [...st.columns.flatMap((c) => c.checks), ...st.checks]) applyCheck(check, properties, notes);
    if (st.columns.some((c) => c.checks.length) || st.checks.length) notes.push('CHECK constraints → $jsonSchema rules (minimum / maximum / enum / minLength).');
    if (st.fks.length) notes.push('FOREIGN KEY: MongoDB has no foreign keys — store the referenced _id and join with $lookup.');
    const schema = { bsonType: 'object' };
    if (required.length) schema.required = required;
    schema.properties = properties;
    const lines = [`db.createCollection(${args(st.name, { validator: { $jsonSchema: schema } })})`];
    notes.push('CREATE TABLE → createCollection() with a $jsonSchema validator; NOT NULL columns become "required", nullable ones also allow "null".');
    if (pk.length && !(pk.length === 1 && pk[0] === '_id')) {
      lines.push(`${collection(st.name)}.createIndex(${args(Object.fromEntries(pk.map((c) => [c, 1])), { unique: true })})`);
      notes.push('PRIMARY KEY → a unique index (every MongoDB document also has its own _id primary key).');
    }
    for (const cols of [...indexes, ...st.uniques]) lines.push(`${collection(st.name)}.createIndex(${args(Object.fromEntries(cols.map((c) => [c, 1])), { unique: true })})`);
    for (const cols of st.indexes) lines.push(`${collection(st.name)}.createIndex(${args(Object.fromEntries(cols.map((c) => [c, 1])))})`);
    return lines.join('\n');
  }

  function translateCreateIndex(st, env) {
    const scope = makeScope({ name: st.table, alias: st.table }, [], null);
    const keys = Object.fromEntries(st.keys.map((k) => [scope.path(k.col), k.dir]));
    const opts = {};
    if (st.name) opts.name = st.name;
    if (st.unique) opts.unique = true;
    if (st.where) {
      opts.partialFilterExpression = toFilter(st.where, makeCtx(scope, env));
      env.notes.push('A partial index (CREATE INDEX ... WHERE) → partialFilterExpression.');
    }
    env.notes.push('CREATE INDEX → createIndex() with 1 (ascending) / -1 (descending) per field.');
    return `${collection(st.table)}.createIndex(${args(keys, Object.keys(opts).length ? opts : undefined)})`;
  }

  function translateAlter(st, env) {
    const notes = env.notes;
    const coll = collection(st.table);
    const lines = [];
    for (const a of st.actions) {
      switch (a.kind) {
        case 'addColumn': {
          const v = a.col.def === undefined ? null : literal(a.col.def);
          lines.push(`${coll}.updateMany(${args({}, { $set: { [a.col.name]: v === NO ? null : v } })})`);
          notes.push('ADD COLUMN: collections have no fixed columns — the field is simply added to existing documents (update the validator if you use one).');
          break;
        }
        case 'dropColumn':
          lines.push(`${coll}.updateMany(${args({}, { $unset: { [a.name]: '' } })})`);
          notes.push('DROP COLUMN → $unset the field from every document.');
          break;
        case 'renameColumn':
          lines.push(`${coll}.updateMany(${args({}, { $rename: { [a.from]: a.to } })})`);
          notes.push('RENAME COLUMN → $rename on every document.');
          break;
        case 'renameTable':
          lines.push(`${coll}.renameCollection(${fmtTop(a.to)})`);
          break;
        case 'unique':
          lines.push(`${coll}.createIndex(${args(Object.fromEntries(a.cols.map((c) => [c, 1])), { unique: true })})`);
          break;
        case 'index':
          lines.push(`${coll}.createIndex(${args(Object.fromEntries(a.cols.map((c) => [c, 1])))})`);
          break;
        case 'alterColumn':
          notes.push('ALTER/MODIFY COLUMN: fields have no declared type in MongoDB — change the $jsonSchema validator with collMod if needed.');
          break;
        case 'constraint':
          notes.push('Foreign-key / CHECK constraints have no MongoDB equivalent (use $jsonSchema validation for checks).');
          break;
      }
    }
    if (!lines.length) lines.push(`// nothing to run in MongoDB for this ALTER TABLE`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- entry point

  function translateMerge(st, env) {
    const scope = makeScope(st.table, [], null);
    const filter = toFilter(st.on, makeCtx(scope, env));
    const update = {};
    const touched = new Set();
    for (const { column, value } of st.sets || []) {
      const f = scope.path(column);
      touched.add(f);
      const v = literal(value);
      const step = v === NO ? selfArithmetic(value, f, scope) : null;
      if (v !== NO) (update.$set = update.$set || {})[f] = v;
      else if (step) (update[step.op] = update[step.op] || {})[f] = step.n;
      else fail('MERGE ... UPDATE SET supports literal values and column + n');
    }
    const coll = collection(st.table.name);
    if (!st.insert) {
      env.notes.push('MERGE with only WHEN MATCHED → updateMany().');
      return `${coll}.updateMany(${args(filter, update)})`;
    }
    const onInsert = {};
    st.insert.columns.forEach((c, i) => {
      const v = literal(st.insert.values[i]);
      if (v === NO) fail('MERGE ... INSERT VALUES must be literal values');
      if (!touched.has(c) && !(c in filter)) onInsert[c] = v;
    });
    if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
    env.notes.push('MERGE (update if found, insert if not) → updateOne(filter, update, { upsert: true }); insert-only values go in $setOnInsert.');
    return `${coll}.updateOne(${args(filter, update, { upsert: true })})`;
  }

  function translateStatement(st, env) {
    const notes = env.notes;
    switch (st.type) {
      case 'explain': {
        const out = translateStatement(st.stmt, env);
        notes.push('EXPLAIN → explain("executionStats") shows the query plan and how many documents were examined.');
        if (/^db\.\S+?\.aggregate\(/.test(out)) return out.replace('.aggregate(', '.explain("executionStats").aggregate(');
        if (/^db\.\S+?\.find\(/.test(out)) return `${out}.explain("executionStats")`;
        fail('EXPLAIN is only supported for queries that become find() or aggregate()');
      }
      case 'use': return `use ${st.name}`;
      case 'show': return `show ${st.what}`;
      case 'merge': return translateMerge(st, env);
      case 'select': case 'union': return translateQuery(st, env);
      case 'insert': return translateInsert(st, env);
      case 'update': return translateUpdate(st, env);
      case 'delete': return translateDelete(st, env);
      case 'createTable': return translateCreateTable(st, env);
      case 'createTableAs': {
        const c = compileQuery(st.query, env);
        notes.push('CREATE TABLE ... AS SELECT → aggregate() ending in $out, which writes the results to a new collection.');
        return `${collection(c.coll)}.aggregate(${fmtPipeline([...c.stages, { $out: st.name }])})`;
      }
      case 'createIndex': return translateCreateIndex(st, env);
      case 'createView': {
        const c = compileQuery(st.query, env);
        notes.push('CREATE VIEW → db.createView(name, source collection, pipeline); the view runs the pipeline on read.');
        return `db.createView(${JSON.stringify(st.name)}, ${JSON.stringify(c.coll)}, ${fmtPipeline(c.stages)})`;
      }
      case 'createDatabase':
        notes.push('Databases are created automatically on first write — "use" just switches to it.');
        return `use ${st.name}`;
      case 'dropTable':
        notes.push('DROP TABLE → drop() removes the collection and its indexes.');
        return st.names.map((n) => `${collection(n)}.drop()`).join('\n');
      case 'dropIndex':
        if (!st.table) fail('DROP INDEX needs the table in MongoDB — write DROP INDEX name ON table');
        return `${collection(st.table)}.dropIndex(${JSON.stringify(st.name)})`;
      case 'dropDatabase':
        return `use ${st.name}\ndb.dropDatabase()`;
      case 'alter': return translateAlter(st, env);
      case 'truncate':
        notes.push('TRUNCATE → deleteMany({}) removes every document but keeps the collection and its indexes.');
        return st.names.map((n) => `${collection(n)}.deleteMany({})`).join('\n');
      case 'tx':
        notes.push('Transactions run on a session: commands inside must use session.getDatabase("<db>") so they join it (replica set or sharded cluster required).');
        if (st.action === 'begin') return 'const session = db.getMongo().startSession()\nsession.startTransaction()';
        return `session.${st.action === 'commit' ? 'commitTransaction' : 'abortTransaction'}()\nsession.endSession()`;
    }
    fail('Unsupported statement');
  }

  const GLOSSARY = [
    [['$project'], 'The SELECT list → $project; computed columns become expressions such as { $toUpper: "$city" }, and "$field" reads a field.'],
    [['$switch'], 'CASE WHEN ... THEN ... ELSE ... END → $switch: each WHEN becomes a branch { case, then }, ELSE becomes default.'],
    [['$cond'], 'CASE WHEN cond THEN a ELSE b END → $cond: { if, then, else }.'],
    [['$toInt', '$toLong', '$toDouble', '$toDecimal', '$toString', '$toDate', '$toBool', '$convert'], 'CAST(x AS type) / x::type → $toInt, $toDouble, $toString, $toDate... (the target type picks the operator).'],
    [['$toUpper', '$toLower'], 'UPPER / LOWER → $toUpper / $toLower.'],
    [['$concat'], 'CONCAT(...) / a || b → $concat with the pieces in an array.'],
    [['$substrCP'], 'SUBSTRING(s, start, len) → $substrCP (0-based start in MongoDB, 1-based in SQL).'],
    [['$strLenCP'], 'LENGTH(s) → $strLenCP.'],
    [['$trim', '$ltrim', '$rtrim'], 'TRIM → $trim.'],
    [['$ifNull'], 'COALESCE(a, b) → $ifNull: [a, b].'],
    [['$round', '$abs', '$ceil', '$floor'], 'Math functions ROUND / ABS / CEIL / FLOOR → $round / $abs / $ceil / $floor.'],
    [['$add', '$subtract', '$multiply', '$divide', '$mod'], 'Arithmetic + - * / % → $add, $subtract, $multiply, $divide, $mod.'],
    [['$year', '$month', '$dayOfMonth', '$hour', '$minute', '$second', '$dayOfWeek', '$week'], 'EXTRACT(YEAR / MONTH / DAY ... FROM date) → $year, $month, $dayOfMonth...'],
    [['$dateTrunc'], 'DATE_TRUNC(unit, date) → $dateTrunc: { date, unit } (MongoDB 5.0+).'],
    [['$dateToString'], 'TO_CHAR(date, format) → $dateToString with a %Y-%m-%d style format.'],
    [['$sort'], 'ORDER BY → $sort with 1 (ASC) / -1 (DESC).'],
    [['$limit'], 'LIMIT → $limit.'],
    [['$skip'], 'OFFSET → $skip.'],
    [['$rank', '$denseRank', '$documentNumber'], 'RANK() / DENSE_RANK() / ROW_NUMBER() → $rank / $denseRank / $documentNumber in $setWindowFields.'],
    [['$shift'], 'LAG(x) / LEAD(x) → $shift with by: -1 / 1 (the previous / next document in sortBy order).'],
    [['$sum', '$avg', '$min', '$max'], 'SUM / AVG / MIN / MAX → $sum / $avg / $min / $max.'],
    [['$inc'], 'column = column + n → $inc.'],
    [['$in'], 'IN (...) → $in.'],
    [['$regex'], 'LIKE / regex patterns → $regex.'],
  ];

  // Explains each operator in the translation that the notes above haven't covered yet.
  function glossaryNotes(text, notes) {
    const pattern = (op) => new RegExp(op.replace('$', '\\$') + '(?!\\w)');
    const extra = [];
    for (const [ops, note] of GLOSSARY) {
      const used = ops.filter((op) => pattern(op).test(text));
      if (used.length && !used.some((op) => notes.some((n) => pattern(op).test(n)))) extra.push(note);
    }
    return extra;
  }

  function translate(src) {
    const stmts = new Parser(tokenize(src)).parseAll();
    if (!stmts.length) fail('Nothing to translate');
    const env = { ctes: new Map(), notes: [], subCount: 0 };
    const output = stmts.map((s) => translateStatement(s, env)).join('\n\n');
    const notes = [...new Set(env.notes)];
    return { output, notes: notes.concat(glossaryNotes(output, notes)) };
  }

  return { translate, TranslateError };
});
