/*
 * MongoDB (mongosh) -> SQL translator.
 * Parses shell commands (queries, aggregation pipelines, writes, indexes, collections, sessions)
 * and emits SQL. Array features use PostgreSQL syntax (ARRAY[...], UNNEST, @>), which the notes point out.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MongoToSql = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class TranslateError extends Error {}
  const fail = (msg) => { throw new TranslateError(msg); };

  // Shell helpers such as ObjectId("...") or new Date().
  class Call { constructor(name, args, isNew) { this.name = name; this.args = args; this.isNew = isNew; } }
  class Regex { constructor(source, flags) { this.source = source; this.flags = flags; } }

  // ---------------------------------------------------------------- tokenizer

  const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', 0: '\0' };

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'" || c === '`') {
        let s = '';
        i++;
        for (;;) {
          if (i >= n) fail('Unterminated string');
          const ch = src[i++];
          if (ch === c) break;
          if (ch === '\\') {
            const e = src[i++];
            if (e === 'u') { s += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; }
            else s += ESCAPES[e] !== undefined ? ESCAPES[e] : e;
            continue;
          }
          s += ch;
        }
        tokens.push({ type: 'string', value: s });
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
        tokens.push({ type: 'number', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
        tokens.push({ type: 'ident', value: m[0] });
        i += m[0].length;
        continue;
      }
      if (c === '/') {
        // Values never contain division, so a lone slash always starts a regex literal.
        let j = i + 1, inClass = false;
        for (; j < n; j++) {
          const ch = src[j];
          if (ch === '\\') { j++; continue; }
          if (ch === '\n') break;
          if (inClass) { if (ch === ']') inClass = false; }
          else if (ch === '[') inClass = true;
          else if (ch === '/') break;
        }
        if (j >= n || src[j] !== '/') fail('Unterminated regular expression');
        const flags = /^[a-z]*/.exec(src.slice(j + 1))[0];
        tokens.push({ type: 'regex', source: src.slice(i + 1, j), flags });
        i = j + 1 + flags.length;
        continue;
      }
      if ('{}[](),:.;-+='.includes(c)) { tokens.push({ type: 'punct', value: c }); i++; continue; }
      fail(`Unexpected character "${c}"`);
    }
    tokens.push({ type: 'eof' });
    return tokens;
  }

  function describe(t) {
    if (t.type === 'eof') return 'end of input';
    if (t.type === 'string') return JSON.stringify(t.value);
    if (t.type === 'regex') return `/${t.source}/`;
    return `"${t.value}"`;
  }

  // ---------------------------------------------------------------- parser

  class Parser {
    constructor(tokens) { this.t = tokens; this.p = 0; }
    peek() { return this.t[this.p]; }
    is(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
    accept(v) { if (this.is('punct', v)) { this.p++; return true; } return false; }
    expect(v) { if (!this.accept(v)) this.fail(`Expected "${v}"`); }
    fail(msg) { fail(`${msg} but found ${describe(this.peek())}`); }
    ident() { if (!this.is('ident')) this.fail('Expected a name'); return this.t[this.p++].value; }
    string() { if (!this.is('string')) this.fail('Expected a string'); return this.t[this.p++].value; }

    program() {
      const out = [];
      while (!this.is('eof')) {
        if (this.accept(';')) continue;
        out.push(this.statement());
      }
      return out;
    }

    statement() {
      if (this.is('ident', 'use')) {
        this.p++;
        return { kind: 'use', name: this.ident() };
      }
      if (this.is('ident', 'show')) {
        this.p++;
        return { kind: 'show', what: this.ident() };
      }
      if (this.is('ident', 'const') || this.is('ident', 'let') || this.is('ident', 'var')) {
        this.p++;
        this.ident();
        this.expect('=');
      }
      if (this.is('ident', 'await')) this.p++;
      const root = this.ident();
      const segs = [];
      for (;;) {
        if (this.accept('.')) segs.push({ prop: this.ident() });
        else if (this.accept('[')) { segs.push({ prop: this.string() }); this.expect(']'); }
        else if (this.accept('(')) segs.push({ args: this.list(')') });
        else break;
      }
      return interpret(root, segs);
    }

    list(close) {
      const items = [];
      while (!this.accept(close)) {
        items.push(this.value());
        if (!this.accept(',')) { this.expect(close); break; }
      }
      return items;
    }

    object() {
      const obj = {};
      while (!this.accept('}')) {
        const t = this.peek();
        if (t.type !== 'ident' && t.type !== 'string' && t.type !== 'number') this.fail('Expected a field name');
        this.p++;
        this.expect(':');
        obj[String(t.value)] = this.value();
        if (!this.accept(',')) { this.expect('}'); break; }
      }
      return obj;
    }

    value() {
      const t = this.peek();
      if (this.accept('{')) return this.object();
      if (this.accept('[')) return this.list(']');
      if (this.accept('-') || this.accept('+')) {
        const v = this.value();
        if (typeof v !== 'number') this.fail('Expected a number');
        return t.value === '-' ? -v : v;
      }
      if (t.type === 'string' || t.type === 'number') { this.p++; return t.value; }
      if (t.type === 'regex') { this.p++; return new Regex(t.source, t.flags); }
      if (t.type === 'ident') {
        this.p++;
        switch (t.value) {
          case 'true': return true;
          case 'false': return false;
          case 'null': case 'undefined': return null;
          case 'Infinity': return Infinity;
        }
        let name = t.value, isNew = false;
        if (name === 'new') { isNew = true; name = this.ident(); }
        if (this.accept('(')) return new Call(name, this.list(')'), isNew);
        fail(`Unknown name "${t.value}" — variables are not supported, use literal values`);
      }
      this.fail('Expected a value');
    }
  }

  const DB_METHODS = new Set(['createCollection', 'createView', 'dropDatabase', 'getCollectionNames', 'runCommand']);

  // Turns a parsed chain such as db.users.find(...).sort(...) into a statement.
  function interpret(root, segs) {
    if (root === 'session') {
      const m = segs[0] && segs[0].prop;
      if (!m || !segs[1] || !segs[1].args) fail('Expected a session method such as session.startTransaction()');
      return { kind: 'session', method: m };
    }
    if (root !== 'db') fail('Expected a command starting with db.<collection>');
    if (segs.some((s) => s.prop === 'startSession')) return { kind: 'noop' };
    let i = 0;
    let coll = null;
    if (segs[0] && segs[0].prop && segs[1] && segs[1].args) {
      const name = segs[0].prop;
      if (name === 'getCollection') {
        coll = segs[1].args[0];
        if (typeof coll !== 'string') fail('getCollection() expects a collection name');
        i = 2;
      } else if (DB_METHODS.has(name)) {
        if (segs.length > 2) fail(`.${segs[2].prop || '()'} cannot be chained after db.${name}()`);
        return { kind: 'db', name, args: segs[1].args };
      } else fail(`db.${name}() is not supported`);
    } else {
      // Collection names may contain dots (db.app.logs.find()).
      const names = [];
      while (segs[i] && segs[i].prop && !(segs[i + 1] && segs[i + 1].args)) names.push(segs[i++].prop);
      coll = names.join('.');
      if (!coll) fail('Expected db.<collection>.<method>(...)');
    }
    const calls = [];
    while (i < segs.length) {
      const name = segs[i] && segs[i].prop, call = segs[i + 1];
      if (!name || !call || !call.args) fail(`Expected a method call such as db.${coll}.find()`);
      calls.push({ name, args: call.args });
      i += 2;
    }
    if (!calls.length) fail(`Expected a method call such as db.${coll}.find()`);
    return { kind: 'coll', coll, calls };
  }

  // ---------------------------------------------------------------- SQL helpers

  const SQL_RESERVED = new Set((
    'SELECT FROM WHERE GROUP ORDER BY HAVING LIMIT OFFSET JOIN ON AND OR NOT IN IS NULL LIKE BETWEEN AS SET ' +
    'VALUES INTO INSERT UPDATE DELETE DISTINCT TABLE USER KEY INDEX DESC ASC CASE WHEN THEN ELSE END ALL UNION ' +
    'CHECK DEFAULT PRIMARY REFERENCES UNIQUE ORDER COLUMN CREATE DROP ALTER GRANT TO WITH'
  ).split(' '));

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Call) && !(v instanceof Regex);
  const isOperatorObject = (v) => isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
  const indent = (s) => s.split('\n').map((l) => '  ' + l).join('\n');

  function ident(name) {
    return String(name).split('.').map((p) =>
      (/^[A-Za-z_]\w*$/.test(p) && !SQL_RESERVED.has(p.toUpperCase()) ? p : '"' + p.replace(/"/g, '""') + '"')).join('.');
  }

  const selectItem = (sql, name) => (sql === ident(name) ? sql : `${sql} AS ${ident(name)}`);

  function toJson(v) {
    if (v instanceof Call) return v.args.length ? toJson(v.args[0]) : null;
    if (v instanceof Regex) return `/${v.source}/${v.flags}`;
    if (Array.isArray(v)) return v.map(toJson);
    if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
    return v;
  }

  const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || v instanceof Call;

  function sqlValue(v, notes) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : "'Infinity'";
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Call) return callValue(v, notes);
    if (v instanceof Regex) fail('A regular expression can only be used as a match condition');
    if (Array.isArray(v) && v.every(isScalar)) {
      notes.push('Arrays → PostgreSQL arrays (ARRAY[...]); other databases usually model them as a separate table or a JSON column.');
      return v.length ? `ARRAY[${v.map((x) => sqlValue(x, notes)).join(', ')}]` : "'{}'";
    }
    notes.push('Embedded documents have no plain SQL column type, so they are written as JSON text here.');
    return sqlValue(JSON.stringify(toJson(v)), notes);
  }

  function callValue(c, notes) {
    const arg = c.args[0];
    switch (c.name) {
      case 'ObjectId': case 'ObjectID': case 'UUID':
        if (arg === undefined) fail(`${c.name}() without a value generates a new id — pass the id you want to use`);
        return sqlValue(arg, notes);
      case 'NumberInt': case 'NumberLong': case 'NumberDecimal': case 'Int32': case 'Long': case 'Decimal128': case 'Double':
        if (arg === undefined) fail(`${c.name}() needs a value`);
        return typeof arg === 'string' && arg.trim() !== '' && !isNaN(arg) ? String(Number(arg)) : sqlValue(arg, notes);
      case 'ISODate': case 'Date':
        if (arg === undefined) return 'CURRENT_TIMESTAMP';
        return typeof arg === 'string' ? `TIMESTAMP ${sqlValue(arg, notes)}` : sqlValue(arg, notes);
      default:
        fail(`Unsupported function ${c.name}()`);
    }
  }

  // Conditions are kept as a small tree so AND/OR get parentheses only where needed.
  const atom = (sql) => ({ atom: sql });
  function and(items) {
    const list = items.filter(Boolean).flatMap((c) => c.and || [c]);
    return list.length === 0 ? null : list.length === 1 ? list[0] : { and: list };
  }
  function or(items) {
    const list = items.filter(Boolean).flatMap((c) => c.or || [c]);
    return list.length === 0 ? null : list.length === 1 ? list[0] : { or: list };
  }
  const not = (c) => (c.not ? c.not : { not: c });

  function render(c, parent = 0) {
    if (c.atom) return c.atom;
    if (c.not) return 'NOT (' + render(c.not) + ')';
    if (c.and) { const s = c.and.map((x) => render(x, 2)).join(' AND '); return parent > 2 ? `(${s})` : s; }
    const s = c.or.map((x) => render(x, 1)).join(' OR ');
    return parent > 1 ? `(${s})` : s;
  }

  const arr = (v, op) => (Array.isArray(v) ? v : fail(`${op} expects an array`));
  const num = (v, what) => (typeof v === 'number' ? v : fail(`${what} expects a number`));

  // ---------------------------------------------------------------- query filter -> WHERE

  const CMP = { $eq: '=', $ne: '<>', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

  function filterCond(filter, ctx) {
    if (!isPlain(filter)) fail('A query filter must be an object, e.g. { age: 30 }');
    const parts = [];
    for (const [k, v] of Object.entries(filter)) {
      switch (k) {
        case '$and': parts.push(and(arr(v, k).map((f) => filterCond(f, ctx)))); break;
        case '$or': parts.push(or(arr(v, k).map((f) => filterCond(f, ctx)))); break;
        case '$nor': parts.push(not(or(arr(v, k).map((f) => filterCond(f, ctx))))); break;
        case '$expr': parts.push(exprCond(v, ctx)); break;
        case '$text': {
          if (!isPlain(v) || typeof v.$search !== 'string') fail('$text expects { $search: "words" }');
          ctx.notes.push('$text → PostgreSQL full-text search; replace "document" with the text column(s) of your text index.');
          parts.push(atom(`to_tsvector(document) @@ plainto_tsquery(${sqlValue(v.$search, ctx.notes)})`));
          break;
        }
        case '$comment': break;
        default:
          if (k.startsWith('$')) fail(k === '$where' ? '$where runs JavaScript — there is no SQL equivalent' : `Unsupported query operator ${k}`);
          parts.push(fieldCond(k, v, ctx));
      }
    }
    return and(parts);
  }

  function fieldCond(field, v, ctx) {
    const col = ctx.ref(field);
    if (v === null) return atom(`${col} IS NULL`);
    if (v instanceof Regex) return regexCond(col, v.source, v.flags, false, ctx);
    if (isOperatorObject(v)) return operatorCond(col, v, ctx);
    return atom(`${col} = ${sqlValue(v, ctx.notes)}`);
  }

  function operatorCond(col, ops, ctx) {
    const val = (x) => sqlValue(x, ctx.notes);
    const keys = Object.keys(ops);
    if (keys.length === 2 && '$gte' in ops && '$lte' in ops) {
      ctx.notes.push('$gte + $lte on the same field → BETWEEN (inclusive on both ends).');
      return atom(`${col} BETWEEN ${val(ops.$gte)} AND ${val(ops.$lte)}`);
    }
    const parts = [];
    for (const [op, x] of Object.entries(ops)) {
      switch (op) {
        case '$eq':
          parts.push(x === null ? atom(`${col} IS NULL`) : x instanceof Regex ? regexCond(col, x.source, x.flags, false, ctx) : atom(`${col} = ${val(x)}`));
          break;
        case '$ne':
          parts.push(x === null ? atom(`${col} IS NOT NULL`) : atom(`${col} <> ${val(x)}`));
          break;
        case '$gt': case '$gte': case '$lt': case '$lte':
          parts.push(atom(`${col} ${CMP[op]} ${val(x)}`));
          break;
        case '$in': case '$nin':
          parts.push(inCond(col, x, op === '$nin', ctx));
          break;
        case '$exists':
          ctx.notes.push('$exists → IS [NOT] NULL: every SQL row has every column, so "missing" and NULL are the same thing.');
          parts.push(atom(`${col} IS ${x ? 'NOT ' : ''}NULL`));
          break;
        case '$regex': {
          const source = x instanceof Regex ? x.source : String(x);
          const flags = (x instanceof Regex ? x.flags : '') + (typeof ops.$options === 'string' ? ops.$options : '');
          parts.push(regexCond(col, source, flags, false, ctx));
          break;
        }
        case '$options':
          if (!('$regex' in ops)) fail('$options only works together with $regex');
          break;
        case '$not':
          if (x instanceof Regex) parts.push(regexCond(col, x.source, x.flags, true, ctx));
          else if (isOperatorObject(x)) parts.push(not(operatorCond(col, x, ctx)));
          else fail('$not expects an operator object or a regular expression');
          break;
        case '$mod':
          if (!Array.isArray(x) || x.length !== 2) fail('$mod expects [divisor, remainder]');
          parts.push(atom(`MOD(${col}, ${val(x[0])}) = ${val(x[1])}`));
          break;
        case '$all':
          ctx.notes.push('$all → PostgreSQL array containment (array @> ARRAY[...]).');
          parts.push(atom(`${col} @> ARRAY[${arr(x, op).map(val).join(', ')}]`));
          break;
        case '$size':
          ctx.notes.push('$size → CARDINALITY(array) (PostgreSQL arrays).');
          parts.push(atom(`CARDINALITY(${col}) = ${val(num(x, '$size'))}`));
          break;
        case '$elemMatch': {
          const inner = isOperatorObject(x)
            ? operatorCond('elem', x, ctx)
            : filterCond(x, { ...ctx, ref: (p) => `elem.${ident(p)}` });
          ctx.notes.push('$elemMatch → EXISTS over UNNEST(array): at least one element must match every condition (PostgreSQL).');
          parts.push(atom(`EXISTS (SELECT 1 FROM UNNEST(${col}) AS elem WHERE ${render(inner)})`));
          break;
        }
        case '$type':
          fail('$type checks BSON types — SQL columns have one fixed type, so there is nothing to translate');
        case '$geoWithin': case '$geoIntersects': case '$near': case '$nearSphere':
          fail(`${op} is a geospatial query — use PostGIS functions such as ST_Within / ST_DWithin`);
        default:
          fail(`Unsupported operator ${op}`);
      }
    }
    return and(parts);
  }

  function inCond(col, list, negate, ctx) {
    arr(list, negate ? '$nin' : '$in');
    const vals = list.filter((x) => x !== null && !(x instanceof Regex));
    const regexes = list.filter((x) => x instanceof Regex);
    const parts = [];
    if (vals.length) parts.push(atom(`${col} ${negate ? 'NOT IN' : 'IN'} (${vals.map((x) => sqlValue(x, ctx.notes)).join(', ')})`));
    for (const re of regexes) parts.push(regexCond(col, re.source, re.flags, negate, ctx));
    if (list.includes(null)) parts.push(atom(`${col} IS ${negate ? 'NOT ' : ''}NULL`));
    if (!parts.length) return atom(negate ? '1 = 1' : '1 = 0');
    return negate ? and(parts) : or(parts);
  }

  // Converts a regex to a LIKE pattern when it only uses anchors, literals, . and .*
  function regexToLike(src) {
    let body = src, start = false, end = false;
    if (body.startsWith('^')) { start = true; body = body.slice(1); }
    if (/(^|[^\\])\$$/.test(body)) { end = true; body = body.slice(0, -1); }
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '\\') {
        const nx = body[++i];
        if (nx === undefined || /[A-Za-z0-9%_]/.test(nx)) return null; // \d, \w, backrefs...
        out += nx;
        continue;
      }
      if (ch === '.') {
        if (body[i + 1] === '*') { out += '%'; i++; }
        else if (body[i + 1] === '+') { out += '_%'; i++; }
        else out += '_';
        continue;
      }
      if ('*+?()[]{}|^$%_'.includes(ch)) return null;
      out += ch;
    }
    if (!start) out = '%' + out;
    if (!end) out += '%';
    return out.replace(/%+/g, '%');
  }

  function regexCond(col, source, flags, negate, ctx) {
    const ci = flags.includes('i');
    const like = regexToLike(source);
    if (like !== null) {
      ctx.notes.push(`Regex /${source}/ → LIKE '${like}' (% = any characters, _ = exactly one).`);
      if (ci) ctx.notes.push('Case-insensitive regex (i flag) → ILIKE (PostgreSQL). In MySQL, LIKE is usually case-insensitive already.');
      return atom(`${col} ${negate ? 'NOT ' : ''}${ci ? 'ILIKE' : 'LIKE'} ${sqlValue(like, ctx.notes)}`);
    }
    ctx.notes.push(`Regex /${source}/ has no LIKE equivalent → REGEXP_LIKE (MySQL 8, Oracle, PostgreSQL 15+).`);
    const sql = `REGEXP_LIKE(${col}, ${sqlValue(source, ctx.notes)}${ci ? ", 'i'" : ''})`;
    return atom(negate ? 'NOT ' + sql : sql);
  }

  // ---------------------------------------------------------------- aggregation expressions -> SQL

  const ARITH = { $add: '+', $subtract: '-', $multiply: '*', $divide: '/' };
  const FUNCS = {
    $toUpper: 'UPPER', $toLower: 'LOWER', $strLenCP: 'LENGTH', $strLenBytes: 'LENGTH', $abs: 'ABS', $ceil: 'CEIL',
    $floor: 'FLOOR', $sqrt: 'SQRT', $concat: 'CONCAT', $round: 'ROUND', $trunc: 'TRUNC', $ifNull: 'COALESCE',
    $mod: 'MOD', $pow: 'POWER', $ln: 'LN', $log10: 'LOG10', $exp: 'EXP',
  };
  const DATE_PARTS = {
    $year: 'YEAR', $month: 'MONTH', $dayOfMonth: 'DAY', $hour: 'HOUR', $minute: 'MINUTE', $second: 'SECOND',
    $dayOfYear: 'DOY', $week: 'WEEK', $millisecond: 'MILLISECONDS',
  };
  const CASTS = {
    $toInt: 'INTEGER', $toLong: 'BIGINT', $toDouble: 'DOUBLE PRECISION', $toDecimal: 'DECIMAL', $toString: 'VARCHAR',
    $toDate: 'TIMESTAMP', $toBool: 'BOOLEAN', $toObjectId: 'CHAR(24)',
  };
  const CONVERT_TYPES = { int: '$toInt', long: '$toLong', double: '$toDouble', decimal: '$toDecimal', string: '$toString', date: '$toDate', bool: '$toBool', objectId: '$toObjectId' };
  const SECONDS = { week: 604800, day: 86400, hour: 3600, minute: 60, second: 1 };

  function exprCond(e, ctx) {
    if (isPlain(e) && Object.keys(e).length === 1) {
      const [op] = Object.keys(e), a = e[op];
      if (op === '$and') return and(arr(a, op).map((x) => exprCond(x, ctx)));
      if (op === '$or') return or(arr(a, op).map((x) => exprCond(x, ctx)));
      if (op === '$not') return not(exprCond(Array.isArray(a) ? a[0] : a, ctx));
    }
    return atom(exprSql(e, ctx));
  }

  function pgDateFormat(f) {
    const map = { '%Y': 'YYYY', '%m': 'MM', '%d': 'DD', '%H': 'HH24', '%M': 'MI', '%S': 'SS', '%L': 'MS', '%j': 'DDD', '%%': '%' };
    return String(f).replace(/%[YmdHMSLj%]/g, (m) => map[m]);
  }

  function interval(amount, unit, ctx) {
    if (typeof amount === 'number') return `INTERVAL '${amount} ${unit}'`;
    return `${exprSql(amount, ctx)} * INTERVAL '1 ${unit}'`;
  }

  function exprSql(e, ctx) {
    if (typeof e === 'string') {
      if (e === '$$NOW') return 'CURRENT_TIMESTAMP';
      if (e.startsWith('$$')) {
        const name = e.slice(2).split('.')[0];
        if (ctx.vars && name in ctx.vars) return ctx.vars[name] + (e.includes('.') ? '.' + ident(e.slice(3 + name.length)) : '');
        fail(`Variable ${e} is not supported here`);
      }
      if (e.startsWith('$')) return ctx.ref(e.slice(1));
      return sqlValue(e, ctx.notes);
    }
    if (Array.isArray(e)) return `ARRAY[${e.map((x) => exprSql(x, ctx)).join(', ')}]`;
    if (!isPlain(e)) return sqlValue(e, ctx.notes);
    const keys = Object.keys(e);
    if (keys.length !== 1 || !keys[0].startsWith('$')) fail('Embedded documents are not supported inside expressions');
    const op = keys[0], a = e[op];
    const args = Array.isArray(a) ? a : [a];
    const sub = (x) => exprSql(x, ctx);
    const arg = (x) => (isPlain(x) && Object.keys(x)[0] in ARITH ? `(${sub(x)})` : sub(x));

    if (op in ARITH) return args.map(arg).join(` ${ARITH[op]} `);
    if (op in CMP) {
      if (args.length !== 2) fail(`${op} expects two arguments`);
      const [l, r] = args;
      if (r === null && (op === '$eq' || op === '$ne')) return `${sub(l)} IS ${op === '$ne' ? 'NOT ' : ''}NULL`;
      return `${arg(l)} ${CMP[op]} ${arg(r)}`;
    }
    if (op in CASTS) return `CAST(${sub(a)} AS ${CASTS[op]})`;
    if (op in DATE_PARTS) return `EXTRACT(${DATE_PARTS[op]} FROM ${sub(isPlain(a) && 'date' in a ? a.date : a)})`;
    switch (op) {
      case '$and': case '$or': case '$not':
        return render(exprCond(e, ctx));
      case '$in': {
        const [x, list] = args;
        if (Array.isArray(list)) return `${sub(x)} IN (${list.map(sub).join(', ')})`;
        ctx.notes.push('$in against an array field → = ANY(array) (PostgreSQL).');
        return `${sub(x)} = ANY(${sub(list)})`;
      }
      case '$cond': {
        const [c, t, f] = Array.isArray(a) ? a : [a.if, a.then, a.else];
        return `CASE WHEN ${render(exprCond(c, ctx))} THEN ${sub(t)} ELSE ${sub(f)} END`;
      }
      case '$switch': {
        const whens = arr(a.branches, '$switch.branches').map((b) => `WHEN ${render(exprCond(b.case, ctx))} THEN ${sub(b.then)}`);
        return `CASE ${whens.join(' ')}${a.default !== undefined ? ` ELSE ${sub(a.default)}` : ''} END`;
      }
      case '$literal':
        return sqlValue(a, ctx.notes);
      case '$convert': {
        const castOp = CONVERT_TYPES[a.to];
        if (!castOp) fail(`$convert to "${a.to}" is not supported`);
        return `CAST(${sub(a.input)} AS ${CASTS[castOp]})`;
      }
      case '$substr': case '$substrCP': case '$substrBytes': {
        const [s, start, len] = args;
        return `SUBSTRING(${sub(s)}, ${typeof start === 'number' ? start + 1 : `${arg(start)} + 1`}, ${sub(len)})`;
      }
      case '$trim': case '$ltrim': case '$rtrim':
        return `${{ $trim: 'TRIM', $ltrim: 'LTRIM', $rtrim: 'RTRIM' }[op]}(${sub(a.input)})`;
      case '$replaceAll': case '$replaceOne':
        return `REPLACE(${sub(a.input)}, ${sub(a.find)}, ${sub(a.replacement)})`;
      case '$indexOfCP': case '$indexOfBytes':
        return `POSITION(${sub(args[1])} IN ${sub(args[0])}) - 1`;
      case '$dayOfWeek':
        return `EXTRACT(DOW FROM ${sub(isPlain(a) && 'date' in a ? a.date : a)}) + 1`;
      case '$dateToString':
        ctx.notes.push('$dateToString → TO_CHAR (PostgreSQL / Oracle); MySQL uses DATE_FORMAT.');
        return `TO_CHAR(${sub(a.date)}, ${sqlValue(pgDateFormat(a.format || '%Y-%m-%dT%H:%M:%S.%LZ'), ctx.notes)})`;
      case '$dateTrunc':
        return `DATE_TRUNC(${sqlValue(a.unit, ctx.notes)}, ${sub(a.date)})`;
      case '$dateAdd': case '$dateSubtract':
        return `${sub(a.startDate)} ${op === '$dateAdd' ? '+' : '-'} ${interval(a.amount, a.unit, ctx)}`;
      case '$dateDiff': {
        const secs = SECONDS[a.unit];
        if (!secs) fail(`$dateDiff in "${a.unit}" units is not supported — use day, hour, minute, second or week`);
        ctx.notes.push('$dateDiff → difference in seconds divided by the unit length (PostgreSQL EXTRACT(EPOCH ...)).');
        return `FLOOR(EXTRACT(EPOCH FROM (${sub(a.endDate)} - ${sub(a.startDate)})) / ${secs})`;
      }
      case '$size': {
        const inner = sub(args[0]);
        // { $size: "$x" } where x was built with $push / $addToSet -> COUNT
        const m = /^ARRAY_AGG\((.*?)( ORDER BY .*)?\)$/.exec(inner);
        if (m) return `COUNT(${m[1]})`;
        return `CARDINALITY(${inner})`;
      }
      case '$reduce': {
        // The string-join idiom: $reduce over a $push-ed array, concatenating with a separator.
        const parts = isPlain(a.in) && Array.isArray(a.in.$concat) ? a.in.$concat : null;
        const cond = parts && parts.length === 3 && isPlain(parts[1]) && Array.isArray(parts[1].$cond) ? parts[1].$cond : null;
        const m = cond && a.initialValue === '' && parts[0] === '$$value' && typeof cond[2] === 'string'
          ? /^ARRAY_AGG\((.*?)( ORDER BY .*)?\)$/.exec(sub(a.input)) : null;
        if (!m) fail('$reduce is only supported for joining strings (the STRING_AGG pattern)');
        ctx.notes.push('$reduce joining the values of a $push → STRING_AGG (PostgreSQL / SQL Server; MySQL: GROUP_CONCAT).');
        return `STRING_AGG(${m[1]}, ${sqlValue(cond[2], ctx.notes)}${m[2] || ''})`;
      }
      case '$arrayElemAt': {
        const [list, idx] = args;
        return `${sub(list)}[${typeof idx === 'number' ? idx + 1 : `${arg(idx)} + 1`}]`;
      }
      case '$first': return `${sub(a)}[1]`;
      case '$last': return `${sub(a)}[CARDINALITY(${sub(a)})]`;
      case '$max': case '$min':
        if (args.length < 2) fail(`${op} on a single array is not supported`);
        return `${op === '$max' ? 'GREATEST' : 'LEAST'}(${args.map(sub).join(', ')})`;
      case '$log': return `LOG(${sub(args[1])}, ${sub(args[0])})`;
      case '$rand': return 'RANDOM()';
      case '$regexMatch': {
        const re = a.regex instanceof Regex ? a.regex : new Regex(String(a.regex), '');
        return render(regexCond(sub(a.input), re.source, re.flags + (a.options || ''), false, ctx));
      }
    }
    if (op in FUNCS) return `${FUNCS[op]}(${args.map(sub).join(', ')})`;
    fail(`Unsupported expression operator ${op}`);
  }

  // ---------------------------------------------------------------- SELECT building

  // A SELECT under construction. `fields` maps document field names to SQL expressions
  // once stages reshape documents; once `closed`, only those fields exist.
  function newQuery(from, alias) {
    return {
      from, alias, distinct: false, columns: ['*'], joins: [], where: [], groupBy: [], having: [], orderBy: [],
      limit: null, offset: null, fields: new Map(), closed: false, grouped: false, limited: false, windowed: false,
      unwinds: [], rootPrefix: null, joinAliases: new Set(),
    };
  }

  function renderSelect(q) {
    const lines = [`SELECT ${q.distinct ? 'DISTINCT ' : ''}${q.columns.join(', ')}`, `FROM ${q.from}`];
    lines.push(...q.joins);
    const where = and(q.where), having = and(q.having);
    if (where) lines.push('WHERE ' + render(where));
    if (q.groupBy.length) lines.push('GROUP BY ' + q.groupBy.join(', '));
    if (having) lines.push('HAVING ' + render(having));
    if (q.orderBy.length) lines.push('ORDER BY ' + q.orderBy.join(', '));
    if (q.limit != null) lines.push('LIMIT ' + q.limit);
    if (q.offset) lines.push('OFFSET ' + q.offset);
    return lines.join('\n');
  }

  const outName = (k, f) => String(f.alias || k).split('.').pop();

  // A new query reading from `inner` (as a subquery, CTE or union), with field names carried over.
  function derived(inner, from, alias) {
    const q = newQuery(from, alias);
    for (const [k, f] of inner.fields) { const n = outName(k, f); q.fields.set(k, { sql: ident(n), alias: n }); }
    q.closed = inner.closed;
    q.unwinds = inner.closed ? [] : inner.unwinds.map((u) => ({ path: u.path, alias: u.alias }));
    return q;
  }

  function sortList(spec, refFn) {
    if (!isPlain(spec)) fail('sort expects an object, e.g. { name: 1 }');
    return Object.entries(spec).map(([k, d]) => {
      if (isPlain(d) && d.$meta) fail('Sorting by $meta (text score) is not supported');
      return `${refFn(k)} ${d === -1 || d === 'desc' || d === 'descending' ? 'DESC' : 'ASC'}`;
    });
  }

  class Builder {
    constructor(coll, notes, vars, counter) {
      this.coll = coll;
      this.notes = notes;
      this.counter = counter || { n: 0 };
      this.q = newQuery(ident(coll), coll);
      this.ctx = { ref: (p) => this.ref(p), notes, vars: vars || {} };
    }

    ref(path) {
      const q = this.q;
      for (const u of q.unwinds) {
        if (path === u.path) return ident(u.alias);
        if (path.startsWith(u.path + '.')) return `${ident(u.alias)}.${ident(path.slice(u.path.length + 1))}`;
      }
      if (q.fields.has(path)) return q.fields.get(path).sql;
      if (q.joinAliases.has(path.split('.')[0])) return ident(path);
      if (q.closed) fail(`Field "${path}" does not exist at this point of the pipeline`);
      return q.rootPrefix ? `${ident(q.rootPrefix)}.${ident(path)}` : ident(path);
    }

    sortRef(path) {
      const f = this.q.fields.get(path);
      return f && f.alias && !this.q.unwinds.some((u) => u.path === path) ? ident(f.alias) : this.ref(path);
    }

    // Qualifies a bare column with the current table so it stays unambiguous next to joined tables.
    qualified(path) {
      const sql = this.ref(path);
      return /^("[^"]+"|[A-Za-z_]\w*)$/.test(sql) && !path.includes('.') ? `${ident(this.q.alias)}.${sql}` : sql;
    }

    wrap() {
      const alias = `t${++this.counter.n}`;
      this.q = derived(this.q, `(\n${indent(renderSelect(this.q))}\n) AS ${alias}`, alias);
      this.notes.push('Stages SQL can\'t express in one SELECT (e.g. $match after $limit, a second $group) → the query so far becomes a subquery: FROM (...) AS t1.');
    }
  }

  const simpleCtx = (notes) => ({ ref: ident, notes, vars: {} });

  function projectionColumns(proj, ctx) {
    if (proj == null) return ['*'];
    if (!isPlain(proj)) fail('A projection must be an object, e.g. { name: 1, _id: 0 }');
    const entries = Object.entries(proj);
    const isOff = (v) => v === 0 || v === false;
    const isOn = (v) => v === 1 || v === true;
    const others = entries.filter(([k]) => k !== '_id');
    if (others.length && others.every(([, v]) => isOff(v))) {
      ctx.notes.push('Exclusion projections ({ field: 0 }) have no SQL equivalent — SELECT * returns every column; list the ones you want instead.');
      return ['*'];
    }
    const cols = [];
    if (!('_id' in proj) && others.length) {
      cols.push(ident('_id'));
      ctx.notes.push('MongoDB returns _id unless the projection says _id: 0, so it is selected here too.');
    }
    for (const [k, v] of entries) {
      if (isOff(v)) continue;
      if (isPlain(v) && ('$slice' in v || '$elemMatch' in v)) fail('Array projections ($slice / $elemMatch) are not supported');
      cols.push(isOn(v) ? ctx.ref(k) : `${exprSql(v, ctx)} AS ${ident(k)}`);
    }
    return cols.length ? cols : ['*'];
  }

  function noChain(st) {
    const extra = st.calls.slice(1).filter((c) => c.name !== 'pretty' && c.name !== 'toArray');
    if (extra.length) fail(`.${extra[0].name}() cannot be chained after ${st.calls[0].name}()`);
  }

  function translateFind(st, notes) {
    const [first, ...chain] = st.calls;
    const ctx = simpleCtx(notes);
    const q = newQuery(ident(st.coll), st.coll);
    const [filter = {}, proj] = first.args;
    q.where.push(filterCond(filter, ctx));
    q.columns = projectionColumns(proj, ctx);
    if (first.name === 'findOne') { q.limit = 1; notes.push('findOne() → LIMIT 1.'); }
    let explain = false;
    for (const c of chain) {
      const a = c.args[0];
      switch (c.name) {
        case 'sort': q.orderBy = sortList(a, ident); notes.push('sort({ field: 1 / -1 }) → ORDER BY field ASC / DESC.'); break;
        case 'limit': { const n = num(a, 'limit()'); q.limit = n === 0 ? null : Math.abs(n); break; }
        case 'skip': q.offset = num(a, 'skip()'); notes.push('skip(n) → OFFSET n.'); break;
        case 'projection': q.columns = projectionColumns(a, ctx); break;
        case 'count': case 'itcount': case 'size':
          q.columns = ['COUNT(*)'];
          q.orderBy = [];
          if (c.name === 'count') { q.limit = null; q.offset = null; }
          break;
        case 'explain': explain = true; notes.push('explain() → EXPLAIN shows the query plan.'); break;
        case 'collation': notes.push('collation() → COLLATE clauses in SQL (database-specific).'); break;
        case 'pretty': case 'toArray': case 'hint': case 'batchSize': case 'maxTimeMS': case 'allowDiskUse': break;
        default: fail(`Unsupported cursor method .${c.name}()`);
      }
    }
    if (q.where[0]) notes.push('The find() filter becomes the WHERE clause; fields listed together are combined with AND.');
    return (explain ? 'EXPLAIN\n' : '') + renderSelect(q) + ';';
  }

  function translateCount(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const q = newQuery(ident(st.coll), st.coll);
    q.columns = ['COUNT(*)'];
    if (name !== 'estimatedDocumentCount') q.where.push(filterCond(args[0] || {}, simpleCtx(notes)));
    notes.push(`${name}() → SELECT COUNT(*).`);
    return renderSelect(q) + ';';
  }

  function translateDistinct(st, notes) {
    noChain(st);
    const [field, filter = {}] = st.calls[0].args;
    if (typeof field !== 'string') fail('distinct() expects a field name, e.g. distinct("city")');
    const q = newQuery(ident(st.coll), st.coll);
    q.distinct = true;
    q.columns = [ident(field)];
    q.where.push(filterCond(filter, simpleCtx(notes)));
    notes.push('distinct(field) → SELECT DISTINCT field.');
    return renderSelect(q) + ';';
  }

  // ---------------------------------------------------------------- aggregate()

  function translateAggregate(st, notes) {
    noChain(st);
    const stages = st.calls[0].args[0];
    if (!Array.isArray(stages)) fail('aggregate() expects an array of stages');
    const b = new Builder(st.coll, notes);
    const result = runPipeline(b, stages);
    return result || renderSelect(b.q) + ';';
  }

  // Applies the stages to the builder. Returns a finished SQL string when a terminal stage
  // ($facet, $out, $merge) produced one, otherwise null.
  function runPipeline(b, stages) {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!isPlain(stage) || Object.keys(stage).length !== 1) fail(`Stage ${i + 1} must be an object with exactly one $stage key`);
      const [op] = Object.keys(stage), a = stage[op];
      const terminal = ['$facet', '$out', '$merge'].includes(op);
      if (terminal && i !== stages.length - 1) fail(`${op} must be the last stage`);
      const q = b.q;
      switch (op) {
        case '$match': {
          if (q.limited || q.windowed) b.wrap();
          const c = filterCond(a, b.ctx);
          if (b.q.grouped) { b.q.having.push(c); b.notes.push('$match after $group → HAVING (filters groups, not rows).'); }
          else { b.q.where.push(c); b.notes.push('$match → WHERE.'); }
          break;
        }
        case '$group':
          if (q.grouped || q.limited || q.windowed) b.wrap();
          if (!isPlain(a) || !('_id' in a)) fail('$group needs an _id (use _id: null for one group)');
          if (a._id === '$$ROOT' && Object.keys(a).length === 1) {
            // { $group: { _id: "$$ROOT" } } + { $replaceRoot: { newRoot: "$_id" } } removes duplicate documents.
            const nx = stages[i + 1];
            if (nx && isPlain(nx.$replaceRoot) && nx.$replaceRoot.newRoot === '$_id') i++;
            b.q.distinct = true;
            b.notes.push('$group on $$ROOT (whole documents) removes duplicates → SELECT DISTINCT.');
            break;
          }
          groupStage(b, groupKeys(b, a._id), omitId(a));
          b.notes.push('$group → GROUP BY; _id is the grouping key and each accumulator becomes an aggregate function.');
          break;
        case '$sortByCount':
          if (q.grouped || q.limited || q.windowed) b.wrap();
          groupStage(b, groupKeys(b, a), { count: { $sum: 1 } });
          b.q.orderBy = ['count DESC'];
          b.notes.push('$sortByCount → GROUP BY + COUNT(*) + ORDER BY count DESC.');
          break;
        case '$bucket':
          if (q.grouped || q.limited || q.windowed) b.wrap();
          bucketStage(b, a);
          break;
        case '$project': projectStage(b, a); break;
        case '$addFields': case '$set': addFieldsStage(b, a, op); break;
        case '$unset': excludeFields(b, [].concat(a)); break;
        case '$sort':
          if (q.limited) b.wrap();
          b.q.orderBy = sortList(a, (p) => b.sortRef(p));
          b.notes.push('$sort → ORDER BY.');
          break;
        case '$limit': {
          const n = num(a, '$limit');
          q.limit = q.limit == null ? n : Math.min(q.limit, n);
          q.limited = true;
          break;
        }
        case '$skip': {
          const n = num(a, '$skip');
          if (q.limit != null) q.limit = Math.max(0, q.limit - n);
          q.offset = (q.offset || 0) + n;
          q.limited = true;
          b.notes.push('$skip → OFFSET.');
          break;
        }
        case '$sample':
          if (q.limited) b.wrap();
          b.q.orderBy = ['RANDOM()'];
          b.q.limit = num(a && a.size, '$sample.size');
          b.q.limited = true;
          b.notes.push('$sample → ORDER BY RANDOM() LIMIT n (RAND() in MySQL).');
          break;
        case '$count': {
          if (q.grouped || q.limited || q.windowed || q.distinct) b.wrap();
          if (typeof a !== 'string') fail('$count expects the name of the output field');
          b.q.columns = [`COUNT(*) AS ${ident(a)}`];
          b.q.fields = new Map([[a, { sql: 'COUNT(*)', alias: a }]]);
          b.q.closed = b.q.grouped = true;
          b.notes.push('$count → SELECT COUNT(*).');
          break;
        }
        case '$lookup':
          if (q.grouped || q.limited || q.windowed) b.wrap();
          if (lookupStage(b, a, stages[i + 1])) i++;
          break;
        case '$unwind':
          if (q.grouped || q.limited) b.wrap();
          unwindStage(b, a);
          break;
        case '$replaceRoot': case '$replaceWith': {
          const root = op === '$replaceRoot' ? a && a.newRoot : a;
          const alias = typeof root === 'string' && root.startsWith('$') ? root.slice(1) : null;
          if (!alias || !b.q.joinAliases.has(alias)) fail(`${op} is only supported for promoting a joined ($lookup) document`);
          b.q.columns = [`${ident(alias)}.*`];
          b.q.fields = new Map();
          b.q.closed = false;
          b.q.rootPrefix = alias;
          b.notes.push(`${op} with a joined document → SELECT ${alias}.*.`);
          break;
        }
        case '$setWindowFields':
          if (q.grouped || q.limited) b.wrap();
          windowStage(b, a);
          break;
        case '$unionWith': {
          const spec = typeof a === 'string' ? { coll: a } : a;
          const other = new Builder(spec.coll, b.notes, b.ctx.vars, b.counter);
          const done = runPipeline(other, spec.pipeline || []);
          if (done) fail('$facet / $out / $merge inside $unionWith are not supported');
          const alias = `t${++b.counter.n}`;
          b.q = derived(b.q, `(\n${indent(renderSelect(b.q))}\n  UNION ALL\n${indent(renderSelect(other.q))}\n) AS ${alias}`, alias);
          b.notes.push('$unionWith → UNION ALL. SQL needs both sides to have the same columns in the same order.');
          break;
        }
        case '$facet': {
          if (!isPlain(a)) fail('$facet expects an object of named pipelines');
          b.notes.push('$facet runs several pipelines over the same input → one query per facet, sharing the input as a CTE (WITH base AS ...).');
          const base = renderSelect(b.q);
          return Object.entries(a).map(([name, pipeline]) => {
            const fb = new Builder(b.coll, b.notes, b.ctx.vars, b.counter);
            fb.q = derived(b.q, 'base', 'base');
            if (runPipeline(fb, arr(pipeline, `$facet.${name}`))) fail('Nested $facet / $out / $merge are not supported');
            return `-- facet: ${name}\nWITH base AS (\n${indent(base)}\n)\n${renderSelect(fb.q)};`;
          }).join('\n\n');
        }
        case '$out': {
          const target = typeof a === 'string' ? a : a && a.coll;
          if (!target) fail('$out expects a collection name');
          b.notes.push('$out replaces the target collection with the results → CREATE TABLE ... AS SELECT (drop the old table first).');
          return `CREATE TABLE ${ident(target)} AS\n${renderSelect(b.q)};`;
        }
        case '$merge': {
          const target = typeof a === 'string' ? a : a && (typeof a.into === 'string' ? a.into : a.into && a.into.coll);
          if (!target) fail('$merge expects { into: "collection" }');
          b.notes.push('$merge writes the results into another collection → INSERT INTO ... SELECT. Matching rows (whenMatched) need MERGE or INSERT ... ON CONFLICT.');
          return `INSERT INTO ${ident(target)}\n${renderSelect(b.q)};`;
        }
        case '$graphLookup': fail('$graphLookup (recursive lookups) corresponds to WITH RECURSIVE — not supported yet');
        case '$geoNear': fail('$geoNear is a geospatial stage — use PostGIS (ST_Distance / ORDER BY <->)');
        case '$redact': case '$densify': case '$fill': case '$bucketAuto': case '$documents': case '$changeStream':
          fail(`${op} has no SQL equivalent here`);
        default: fail(`Unsupported stage ${op}`);
      }
    }
    return null;
  }

  const omitId = (spec) => Object.fromEntries(Object.entries(spec).filter(([k]) => k !== '_id'));

  // Group keys from a $group _id: [{ key: field path after grouping, sql, alias }]
  function groupKeys(b, id) {
    const ctx = b.ctx;
    if (isPlain(id) && Object.keys(id).length && !Object.keys(id).some((k) => k.startsWith('$'))) {
      return Object.entries(id).map(([k, v]) => ({ key: '_id.' + k, sql: exprSql(v, ctx), alias: k }));
    }
    if (typeof id === 'string' ? id.startsWith('$') : isPlain(id)) {
      return [{ key: '_id', sql: exprSql(id, ctx), alias: typeof id === 'string' ? id.slice(1).split('.').pop() : '_id' }];
    }
    return []; // a constant _id (usually null): one group for everything
  }

  const isCountPattern = (a) =>
    isPlain(a) && Array.isArray(a.$cond) && isPlain(a.$cond[0]) && Array.isArray(a.$cond[0].$eq) &&
    isPlain(a.$cond[0].$eq[0]) && Array.isArray(a.$cond[0].$eq[0].$ifNull) && a.$cond[1] === 0 && a.$cond[2] === 1;

  function groupStage(b, keys, accs) {
    const ctx = b.ctx;
    const q = b.q;
    const priorOrder = q.orderBy.slice();
    const next = new Map();
    const cols = [];
    q.groupBy = [];
    for (const k of keys) {
      q.groupBy.push(k.sql);
      next.set(k.key, { sql: k.sql, alias: k.alias });
      cols.push(selectItem(k.sql, k.alias));
    }
    for (const [name, acc] of Object.entries(accs)) {
      if (!isPlain(acc) || Object.keys(acc).length !== 1) fail(`Accumulator "${name}" must look like { $sum: "$field" }`);
      const [op] = Object.keys(acc), a = acc[op];
      const x = () => exprSql(a, ctx);
      let sql;
      switch (op) {
        case '$sum':
          if (a === 1) sql = 'COUNT(*)';
          else if (isCountPattern(a)) sql = `COUNT(${exprSql(a.$cond[0].$eq[0].$ifNull[0], ctx)})`;
          else sql = `SUM(${x()})`;
          break;
        case '$count': sql = 'COUNT(*)'; break;
        case '$avg': sql = `AVG(${x()})`; break;
        case '$min': sql = `MIN(${x()})`; break;
        case '$max': sql = `MAX(${x()})`; break;
        case '$stdDevPop': sql = `STDDEV_POP(${x()})`; break;
        case '$stdDevSamp': sql = `STDDEV_SAMP(${x()})`; break;
        case '$push': case '$addToSet':
          sql = `ARRAY_AGG(${op === '$addToSet' ? 'DISTINCT ' : ''}${x()}${op === '$push' && priorOrder.length ? ' ORDER BY ' + priorOrder.join(', ') : ''})`;
          b.notes.push('$push / $addToSet collect arrays → ARRAY_AGG (PostgreSQL); wrapped in $size they become COUNT.');
          break;
        case '$first': case '$last': {
          const order = op === '$first' ? priorOrder : priorOrder.map((o) => (o.endsWith(' DESC') ? o.slice(0, -5) + ' ASC' : o.replace(/ ASC$/, ' DESC')));
          sql = `(ARRAY_AGG(${x()}${order.length ? ' ORDER BY ' + order.join(', ') : ''}))[1]`;
          b.notes.push(priorOrder.length
            ? `${op} after $sort → (ARRAY_AGG(x ORDER BY ...))[1] (PostgreSQL), the ${op === '$first' ? 'first' : 'last'} value in sort order.`
            : `${op} without a preceding $sort picks an arbitrary document's value — the SQL version is just as arbitrary.`);
          break;
        }
        default: fail(`Unsupported accumulator ${op}`);
      }
      next.set(name, { sql, alias: name });
      cols.push(`${sql} AS ${ident(name)}`);
    }
    q.columns = cols.length ? cols : ['COUNT(*)'];
    q.orderBy = [];
    q.fields = next;
    q.closed = q.grouped = true;
    q.unwinds = [];
  }

  function bucketStage(b, a) {
    const { groupBy, boundaries, output } = a || {};
    if (!groupBy || !Array.isArray(boundaries) || boundaries.length < 2) fail('$bucket needs groupBy and at least two boundaries');
    const x = exprSql(groupBy, b.ctx);
    const v = (val) => sqlValue(val, b.notes);
    const whens = boundaries.slice(0, -1).map((lo, i) => `WHEN ${x} >= ${v(lo)} AND ${x} < ${v(boundaries[i + 1])} THEN ${v(lo)}`);
    const key = `CASE ${whens.join(' ')}${a.default !== undefined ? ' ELSE ' + v(a.default) : ''} END`;
    groupStage(b, [{ key: '_id', sql: key, alias: 'bucket' }], output || { count: { $sum: 1 } });
    b.notes.push('$bucket → GROUP BY a CASE expression that maps each value to its bucket\'s lower boundary.');
  }

  function projectStage(b, spec) {
    if (!isPlain(spec)) fail('$project expects an object');
    const ctx = b.ctx;
    const q = b.q;
    const entries = Object.entries(spec);
    const isOff = (v) => v === 0 || v === false;
    const isOn = (v) => v === 1 || v === true;
    const others = entries.filter(([k]) => k !== '_id');
    if (others.some(([, v]) => isOff(v))) {
      if (!others.every(([, v]) => isOff(v))) fail('$project cannot mix including and excluding fields (except _id)');
      excludeFields(b, entries.filter(([, v]) => isOff(v)).map(([k]) => k));
      return;
    }
    const next = new Map();
    const cols = [];
    const idSpec = spec._id;
    if (idSpec === undefined || isOn(idSpec)) {
      if (q.closed) {
        for (const [k, f] of q.fields) {
          if (k === '_id' || k.startsWith('_id.')) { cols.push(selectItem(f.sql, f.alias)); next.set(k, f); }
        }
      } else {
        const sql = b.ref('_id');
        cols.push(selectItem(sql, '_id'));
        next.set('_id', { sql, alias: '_id' });
      }
    }
    for (const [k, v] of entries) {
      if (k === '_id' && (isOn(v) || isOff(v))) continue;
      const sql = isOn(v) ? b.ref(k) : exprSql(v, ctx);
      cols.push(selectItem(sql, k));
      next.set(k, { sql, alias: k });
    }
    q.columns = cols.length ? cols : ['*'];
    q.fields = next;
    q.closed = true;
    q.unwinds = [];
    b.notes.push('$project → the SELECT column list.');
  }

  function excludeFields(b, names) {
    const q = b.q;
    if (!q.closed) {
      b.notes.push('Excluding fields ($project with 0 / $unset) has no SQL equivalent — SELECT * returns every column; list the ones you want instead.');
      return;
    }
    for (const n of names) q.fields.delete(n);
    q.columns = [...q.fields].map(([k, f]) => selectItem(f.sql, outName(k, f)));
    if (!q.columns.length) q.columns = ['*'];
  }

  function addFieldsStage(b, spec, op) {
    if (!isPlain(spec)) fail(`${op} expects an object`);
    const q = b.q;
    if (q.limited) b.wrap();
    const added = Object.entries(spec).map(([k, v]) => [k, exprSql(v, b.ctx)]);
    for (const [k, sql] of added) {
      if (b.q.fields.has(k) && b.q.closed) b.q.columns = b.q.columns.filter((c) => c !== selectItem(b.q.fields.get(k).sql, k));
      b.q.columns.push(selectItem(sql, k));
      b.q.fields.set(k, { sql, alias: k });
    }
    b.notes.push(`${op} → extra computed columns in SELECT.`);
  }

  function lookupStage(b, a, next) {
    const { from, localField, foreignField, as } = a || {};
    if (!from || !as) fail('$lookup needs from and as');
    const unwind = next && next.$unwind;
    const unwindPath = typeof unwind === 'string' ? unwind : unwind && unwind.path;
    const consumed = unwindPath === '$' + as;
    const preserve = consumed && isPlain(unwind) && unwind.preserveNullAndEmptyArrays;
    const q = b.q;
    if (a.pipeline || a.let) {
      const vars = {};
      for (const [k, v] of Object.entries(a.let || {})) {
        vars[k] = typeof v === 'string' && v.startsWith('$') && !v.startsWith('$$') ? b.qualified(v.slice(1)) : exprSql(v, b.ctx);
      }
      const inner = new Builder(from, b.notes, vars, b.counter);
      if (localField && foreignField) inner.q.where.push(atom(`${ident(foreignField)} = ${b.qualified(localField)}`));
      if (runPipeline(inner, a.pipeline || [])) fail('$facet / $out / $merge inside $lookup are not supported');
      const body = `(\n${indent(renderSelect(inner.q))}\n) AS ${ident(as)}`;
      q.joins.push(consumed && !preserve ? `CROSS JOIN LATERAL ${body}` : `LEFT JOIN LATERAL ${body} ON TRUE`);
      b.notes.push('$lookup with let / pipeline → a LATERAL subquery join ($$variables become references to the outer row). LATERAL works in PostgreSQL and MySQL 8.');
    } else {
      if (!localField || !foreignField) fail('$lookup needs localField and foreignField (or a pipeline)');
      const kind = consumed && !preserve ? 'INNER' : 'LEFT';
      q.joins.push(`${kind} JOIN ${ident(from)}${as !== from ? ' AS ' + ident(as) : ''} ON ${b.qualified(localField)} = ${ident(as)}.${ident(foreignField)}`);
      b.notes.push(consumed
        ? `$lookup + $unwind → ${kind} JOIN (one row per match${kind === 'LEFT' ? ', unmatched rows kept' : ''}).`
        : '$lookup → LEFT JOIN.');
    }
    if (!consumed) b.notes.push(`$lookup alone returns the matches as an array field "${as}"; SQL returns one row per match instead.`);
    q.joinAliases.add(as);
    return consumed;
  }

  function unwindStage(b, a) {
    const spec = typeof a === 'string' ? { path: a } : a;
    if (!spec || typeof spec.path !== 'string' || !spec.path.startsWith('$')) fail('$unwind expects "$field" or { path: "$field" }');
    const path = spec.path.slice(1);
    const q = b.q;
    if (q.joinAliases.has(path)) return; // already one row per match
    const arraySql = b.ref(path);
    const last = path.split('.').pop();
    const alias = last.length > 3 && last.endsWith('s') && !last.endsWith('ss') ? last.slice(0, -1) : `${last}_item`;
    const idx = spec.includeArrayIndex;
    const fn = `UNNEST(${arraySql})${idx ? ' WITH ORDINALITY' : ''} AS ${ident(alias)}${idx ? `(${ident(alias)}, ${ident(idx)})` : ''}`;
    q.joins.push(spec.preserveNullAndEmptyArrays ? `LEFT JOIN ${fn} ON TRUE` : `CROSS JOIN ${fn}`);
    q.unwinds.push({ path, alias });
    if (idx) q.fields.set(idx, { sql: `${ident(idx)} - 1`, alias: idx });
    b.notes.push(`$unwind → ${spec.preserveNullAndEmptyArrays ? 'LEFT JOIN ... ON TRUE' : 'CROSS JOIN'} UNNEST(array): one row per element (PostgreSQL arrays; JSON arrays use jsonb_array_elements).`);
  }

  function frameSql(w) {
    if (w.unit) fail('Time-based window ranges (unit) are not supported');
    const mode = w.range ? 'RANGE' : 'ROWS';
    const [s, e] = w.documents || w.range;
    const bound = (x, start) => {
      if (x === 'unbounded') return start ? 'UNBOUNDED PRECEDING' : 'UNBOUNDED FOLLOWING';
      if (x === 'current' || x === 0) return 'CURRENT ROW';
      return x < 0 ? `${-x} PRECEDING` : `${x} FOLLOWING`;
    };
    return `${mode} BETWEEN ${bound(s, true)} AND ${bound(e, false)}`;
  }

  function windowStage(b, a) {
    if (!isPlain(a) || !isPlain(a.output)) fail('$setWindowFields needs an output object');
    const ctx = b.ctx;
    const part = a.partitionBy === undefined ? []
      : isPlain(a.partitionBy) && !Object.keys(a.partitionBy).some((k) => k.startsWith('$')) ? Object.values(a.partitionBy) : [a.partitionBy];
    const over = [];
    if (part.length) over.push('PARTITION BY ' + part.map((p) => exprSql(p, ctx)).join(', '));
    if (a.sortBy) over.push('ORDER BY ' + sortList(a.sortBy, (p) => b.ref(p)).join(', '));
    const added = [];
    for (const [name, spec] of Object.entries(a.output)) {
      const { window, ...rest } = spec;
      const [fop] = Object.keys(rest), arg = rest[fop];
      const x = () => exprSql(arg, ctx);
      let fn, cumulative = true;
      switch (fop) {
        case '$rank': fn = 'RANK()'; cumulative = false; break;
        case '$denseRank': fn = 'DENSE_RANK()'; cumulative = false; break;
        case '$documentNumber': fn = 'ROW_NUMBER()'; cumulative = false; break;
        case '$shift': {
          const by = num(arg.by, '$shift.by');
          const def = arg.default !== undefined && arg.default !== null ? ', ' + sqlValue(arg.default, b.notes) : '';
          fn = `${by < 0 ? 'LAG' : 'LEAD'}(${exprSql(arg.output, ctx)}, ${Math.abs(by)}${def})`;
          cumulative = false;
          break;
        }
        case '$sum': fn = arg === 1 ? 'COUNT(*)' : `SUM(${x()})`; break;
        case '$avg': fn = `AVG(${x()})`; break;
        case '$min': fn = `MIN(${x()})`; break;
        case '$max': fn = `MAX(${x()})`; break;
        case '$count': fn = 'COUNT(*)'; break;
        case '$first': fn = `FIRST_VALUE(${x()})`; break;
        case '$last': fn = `LAST_VALUE(${x()})`; break;
        case '$push': fn = `ARRAY_AGG(${x()})`; break;
        case '$stdDevPop': fn = `STDDEV_POP(${x()})`; break;
        case '$stdDevSamp': fn = `STDDEV_SAMP(${x()})`; break;
        default: fail(`Window operator ${fop} is not supported`);
      }
      const parts = over.slice();
      // MongoDB's default window is the whole partition; SQL's default (with ORDER BY) is a running total.
      if (window) parts.push(frameSql(window));
      else if (cumulative && a.sortBy) parts.push('ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING');
      added.push([name, `${fn} OVER (${parts.join(' ')})`]);
    }
    for (const [k, sql] of added) {
      b.q.columns.push(selectItem(sql, k));
      b.q.fields.set(k, { sql, alias: k });
    }
    b.q.windowed = true;
    b.notes.push('$setWindowFields → window functions: partitionBy → PARTITION BY, sortBy → ORDER BY, window → ROWS/RANGE BETWEEN.');
  }

  // ---------------------------------------------------------------- writes

  function translateInsert(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    let docs = args[0];
    if (name === 'insertOne' && !isPlain(docs)) fail('insertOne() expects a document');
    if (name === 'insertMany' && !Array.isArray(docs)) fail('insertMany() expects an array of documents');
    if (!Array.isArray(docs)) docs = [docs];
    if (!docs.length) fail('Nothing to insert');
    docs.forEach((d) => isPlain(d) || fail('Each inserted value must be a document'));
    const cols = [...new Set(docs.flatMap((d) => Object.keys(d)))];
    if (docs.some((d) => cols.some((c) => !(c in d)))) notes.push('The documents have different fields — missing ones become NULL.');
    notes.push('Each document becomes a row; its field names become the column list.');
    const rows = docs.map((d) => '(' + cols.map((c) => (c in d ? sqlValue(d[c], notes) : 'NULL')).join(', ') + ')');
    const head = `INSERT INTO ${ident(st.coll)} (${cols.map(ident).join(', ')})`;
    return rows.length === 1 ? `${head}\nVALUES ${rows[0]};` : `${head}\nVALUES\n  ${rows.join(',\n  ')};`;
  }

  // Builds the SET list plus the values a new row would get (for upserts).
  function updateParts(update, name, ctx) {
    const notes = ctx.notes;
    const sets = [];
    const inserts = new Map();
    const renames = [];
    const val = (v) => sqlValue(v, notes);
    if (name === 'replaceOne' || name === 'findOneAndReplace') {
      if (!isPlain(update)) fail(`${name}() expects a replacement document`);
      for (const [k, v] of Object.entries(update)) if (k !== '_id') { sets.push(`${ident(k)} = ${val(v)}`); inserts.set(k, val(v)); }
      notes.push(`${name}() replaces the whole document; this UPDATE only sets the listed columns.`);
      return { sets, inserts, renames };
    }
    if (Array.isArray(update)) {
      for (const stage of update) {
        const [op, ...more] = Object.keys(stage || {});
        if (more.length || !['$set', '$addFields', '$unset', '$project'].includes(op)) fail('Only $set / $addFields / $unset stages are supported in update pipelines');
        if (op === '$unset') for (const f of [].concat(stage.$unset)) sets.push(`${ident(f)} = NULL`);
        else if (op === '$project') fail('$project in an update pipeline is not supported');
        else for (const [k, v] of Object.entries(stage[op])) sets.push(`${ident(k)} = ${exprSql(v, ctx)}`);
      }
      notes.push('An update pipeline → SET column = expression (values can use other columns).');
      return { sets, inserts, renames };
    }
    if (!isPlain(update)) fail(`${name}() expects a filter and an update document`);
    for (const [op, spec] of Object.entries(update)) {
      if (!op.startsWith('$')) fail('Update documents need operators such as $set — use replaceOne() to replace a whole document');
      if (!isPlain(spec)) fail(`${op} expects an object`);
      for (const [k, v] of Object.entries(spec)) {
        const col = ident(k);
        switch (op) {
          case '$set': sets.push(`${col} = ${val(v)}`); inserts.set(k, val(v)); break;
          case '$setOnInsert': inserts.set(k, val(v)); break;
          case '$unset': sets.push(`${col} = NULL`); notes.push('$unset removes a field; the SQL equivalent is setting the column to NULL.'); break;
          case '$inc':
            sets.push(typeof v === 'number' && v < 0 ? `${col} = ${col} - ${-v}` : `${col} = ${col} + ${val(v)}`);
            inserts.set(k, val(v));
            notes.push('$inc → SET column = column + n.');
            break;
          case '$mul': sets.push(`${col} = ${col} * ${val(v)}`); inserts.set(k, '0'); break;
          case '$min': sets.push(`${col} = LEAST(${col}, ${val(v)})`); inserts.set(k, val(v)); break;
          case '$max': sets.push(`${col} = GREATEST(${col}, ${val(v)})`); inserts.set(k, val(v)); break;
          case '$currentDate': sets.push(`${col} = CURRENT_TIMESTAMP`); inserts.set(k, 'CURRENT_TIMESTAMP'); break;
          case '$rename': renames.push([k, v]); break;
          case '$push': case '$addToSet': {
            const each = isPlain(v) && '$each' in v ? arr(v.$each, '$each') : null;
            if (isPlain(v) && !each) fail(`${op} modifiers other than $each are not supported`);
            if (op === '$push') sets.push(each ? `${col} = ${col} || ${val(each)}` : `${col} = ARRAY_APPEND(${col}, ${val(v)})`);
            else if (each) sets.push(`${col} = ARRAY(SELECT DISTINCT UNNEST(${col} || ${val(each)}))`);
            else sets.push(`${col} = CASE WHEN ${val(v)} = ANY(${col}) THEN ${col} ELSE ARRAY_APPEND(${col}, ${val(v)}) END`);
            inserts.set(k, each ? val(each) : `ARRAY[${val(v)}]`);
            notes.push(`${op} → PostgreSQL array functions (ARRAY_APPEND, ||, = ANY).`);
            break;
          }
          case '$pull':
            if (isPlain(v) || v instanceof Regex) fail('$pull with a condition is not supported — only exact values');
            sets.push(`${col} = ARRAY_REMOVE(${col}, ${val(v)})`);
            notes.push('$pull → ARRAY_REMOVE (PostgreSQL).');
            break;
          case '$pullAll':
            sets.push(`${col} = ARRAY(SELECT x FROM UNNEST(${col}) AS x WHERE x <> ALL(${val(arr(v, '$pullAll'))}))`);
            break;
          case '$pop':
            sets.push(v === -1 ? `${col} = ${col}[2:CARDINALITY(${col})]` : `${col} = ${col}[1:CARDINALITY(${col}) - 1]`);
            notes.push('$pop → an array slice (PostgreSQL).');
            break;
          default: fail(`Unsupported update operator ${op}`);
        }
      }
    }
    return { sets, inserts, renames };
  }

  // Equality fields of a filter, which an upsert copies into the new document.
  function filterInserts(filter, notes) {
    const out = new Map();
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('$')) continue;
      if (isOperatorObject(v)) { if ('$eq' in v) out.set(k, sqlValue(v.$eq, notes)); }
      else if (!(v instanceof Regex)) out.set(k, sqlValue(v, notes));
    }
    return out;
  }

  function translateUpdate(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const [filter = {}, update, options = {}] = args;
    const ctx = simpleCtx(notes);
    const { sets, inserts, renames } = updateParts(update, name, ctx);
    const where = filterCond(filter, ctx);
    const out = [];
    const table = ident(st.coll);
    const opts = isPlain(options) ? options : {};
    if (opts.upsert) {
      const cols = new Map([...filterInserts(filter, notes), ...inserts]);
      const lines = [`MERGE INTO ${table}`, 'USING (SELECT 1) AS src', `ON ${where ? render(where) : 'TRUE'}`];
      if (sets.length) lines.push(`WHEN MATCHED THEN\n  UPDATE SET ${sets.join(',\n             ')}`);
      lines.push(`WHEN NOT MATCHED THEN\n  INSERT (${[...cols.keys()].map(ident).join(', ')})\n  VALUES (${[...cols.values()].join(', ')})`);
      out.push(lines.join('\n') + ';');
      notes.push('upsert → MERGE (SQL standard: PostgreSQL 15+, SQL Server, Oracle). PostgreSQL/SQLite can also use INSERT ... ON CONFLICT, MySQL INSERT ... ON DUPLICATE KEY UPDATE.');
    } else if (sets.length) {
      const one = name === 'updateOne' || name === 'replaceOne' || (name === 'update' && !opts.multi);
      const returning = name.startsWith('findOneAnd');
      let sql = `UPDATE ${table}\nSET ${sets.join(',\n    ')}`;
      if (where) sql += `\nWHERE ${render(where)}`;
      else notes.push('Empty filter: every row is updated.');
      if (one) sql += '\nLIMIT 1';
      if (returning) sql += '\nRETURNING *';
      out.push(sql + ';');
      if (one) notes.push(`${name}() changes only the first match. LIMIT 1 on UPDATE is MySQL syntax; standard SQL updates every matching row.`);
      else if (returning) notes.push(`${name}() → UPDATE ... RETURNING * (PostgreSQL). It changes one document in MongoDB but every matching row here — filter on a unique key.`);
      else notes.push(`${name}() → UPDATE, which changes every matching row.`);
    }
    for (const [from, to] of renames) {
      out.push(`ALTER TABLE ${table} RENAME COLUMN ${ident(from)} TO ${ident(to)};`);
      notes.push('$rename renames a field per document; in SQL renaming a column changes the table for every row (ALTER TABLE).');
    }
    if (!out.length) fail('Nothing to update');
    return out.join('\n\n');
  }

  function translateDelete(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const [filter = {}, opt] = args;
    const one = name === 'deleteOne' || (name === 'remove' && (opt === true || (isPlain(opt) && opt.justOne)));
    const where = filterCond(filter, simpleCtx(notes));
    let sql = `DELETE FROM ${ident(st.coll)}`;
    if (where) sql += `\nWHERE ${render(where)}`;
    else notes.push('Empty filter: every row is deleted!');
    if (one) {
      sql += '\nLIMIT 1';
      notes.push('deleteOne() removes only the first match. LIMIT 1 on DELETE is MySQL syntax.');
    }
    if (name === 'findOneAndDelete') {
      sql += '\nRETURNING *';
      notes.push('findOneAndDelete() → DELETE ... RETURNING * (PostgreSQL). It removes one document in MongoDB but every matching row here — filter on a unique key.');
    }
    return sql + ';';
  }

  function translateBulkWrite(st, notes) {
    noChain(st);
    const ops = arr(st.calls[0].args[0], 'bulkWrite()');
    notes.push('bulkWrite() → one SQL statement per operation (wrap them in BEGIN / COMMIT if they must succeed together).');
    return ops.map((op) => {
      const [kind] = Object.keys(op || {});
      const spec = op[kind] || {};
      const call = (name, callArgs) => translateCollection({ kind: 'coll', coll: st.coll, calls: [{ name, args: callArgs }] }, notes);
      switch (kind) {
        case 'insertOne': return call('insertOne', [spec.document]);
        case 'updateOne': case 'updateMany': return call(kind, [spec.filter, spec.update, { upsert: spec.upsert }]);
        case 'replaceOne': return call('replaceOne', [spec.filter, spec.replacement, { upsert: spec.upsert }]);
        case 'deleteOne': case 'deleteMany': return call(kind, [spec.filter]);
        default: fail(`Unsupported bulkWrite operation ${kind}`);
      }
    }).join('\n\n');
  }

  // ---------------------------------------------------------------- indexes and collections

  function indexSql(coll, keys, opts, notes) {
    if (!isPlain(keys) || !Object.keys(keys).length) fail('createIndex() expects a key document, e.g. { email: 1 }');
    const o = isPlain(opts) ? opts : {};
    const entries = Object.entries(keys);
    const name = o.name || `${coll}_${entries.map(([k]) => k).join('_')}_idx`.replace(/\W/g, '_');
    let using = '';
    let cols;
    if (entries.some(([, d]) => d === 'text')) {
      using = ' USING GIN';
      cols = [`to_tsvector('english', ${entries.map(([k]) => `COALESCE(${ident(k)}, '')`).join(" || ' ' || ")})`];
      notes.push('A text index → a PostgreSQL GIN index on to_tsvector(...) for full-text search.');
    } else if (entries.some(([, d]) => d === 'hashed')) {
      using = ' USING HASH';
      cols = entries.map(([k]) => ident(k));
    } else if (entries.some(([, d]) => typeof d === 'string')) {
      fail('Geospatial indexes (2d / 2dsphere) need PostGIS — not supported');
    } else cols = entries.map(([k, d]) => `${ident(k)}${d === -1 ? ' DESC' : ''}`);
    let sql = `CREATE ${o.unique ? 'UNIQUE ' : ''}INDEX ${ident(name)} ON ${ident(coll)}${using} (${cols.join(', ')})`;
    if (o.partialFilterExpression) {
      sql += `\nWHERE ${render(filterCond(o.partialFilterExpression, simpleCtx(notes)))}`;
      notes.push('partialFilterExpression → a partial index (CREATE INDEX ... WHERE), PostgreSQL / SQLite.');
    }
    if (o.expireAfterSeconds !== undefined) notes.push('TTL indexes (expireAfterSeconds) have no SQL equivalent — schedule a DELETE of old rows instead.');
    if (o.sparse) notes.push('sparse indexes ≈ a partial index WHERE column IS NOT NULL.');
    notes.push('createIndex({ field: 1 / -1 }) → CREATE INDEX ... (field ASC / DESC).');
    return sql + ';';
  }

  function translateIndexes(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const table = ident(st.coll);
    switch (name) {
      case 'createIndex': case 'ensureIndex': return indexSql(st.coll, args[0], args[1], notes);
      case 'createIndexes': return arr(args[0], 'createIndexes()').map((spec) => indexSql(st.coll, spec.key || spec, spec.key ? spec : args[1], notes)).join('\n');
      case 'dropIndex': {
        const n = typeof args[0] === 'string' ? args[0] : isPlain(args[0]) ? `${st.coll}_${Object.keys(args[0]).join('_')}_idx` : fail('dropIndex() expects an index name');
        notes.push('DROP INDEX name ON table is MySQL syntax; PostgreSQL index names are global, so it\'s just DROP INDEX name.');
        return `DROP INDEX ${ident(n)} ON ${table};`;
      }
      case 'dropIndexes':
        fail('dropIndexes() drops every index — list them and use DROP INDEX name for each');
      case 'getIndexes':
        notes.push('getIndexes() → PostgreSQL\'s pg_indexes catalog view (MySQL: SHOW INDEX FROM table).');
        return `SELECT indexname, indexdef\nFROM pg_indexes\nWHERE tablename = ${sqlValue(st.coll, notes)};`;
    }
  }

  const SQL_TYPES = {
    string: 'TEXT', int: 'INTEGER', long: 'BIGINT', double: 'DOUBLE PRECISION', decimal: 'DECIMAL', number: 'NUMERIC',
    bool: 'BOOLEAN', date: 'TIMESTAMP', timestamp: 'TIMESTAMP', objectId: 'CHAR(24)', object: 'JSONB', binData: 'BYTEA',
  };

  function columnType(p) {
    const types = [].concat(p.bsonType || p.type || []).filter((t) => t !== 'null');
    const t = types[0];
    if (t === 'string' && p.maxLength) return `VARCHAR(${p.maxLength})`;
    if (t === 'array') {
      const it = p.items && [].concat(p.items.bsonType || p.items.type || [])[0];
      return it && SQL_TYPES[it] && it !== 'object' ? `${SQL_TYPES[it]}[]` : 'JSONB';
    }
    return SQL_TYPES[t] || 'TEXT';
  }

  function createTableSql(name, opts, notes) {
    const schema = isPlain(opts) && isPlain(opts.validator) && opts.validator.$jsonSchema;
    if (isPlain(opts) && opts.capped) notes.push('Capped collections have no SQL equivalent.');
    if (!schema) {
      notes.push('A collection without a $jsonSchema validator has no fixed columns — add them to the table as needed.');
      return `CREATE TABLE ${ident(name)} (\n  _id CHAR(24) PRIMARY KEY\n);`;
    }
    const props = schema.properties || {};
    const required = schema.required || [];
    const cols = [];
    if (!('_id' in props)) cols.push('_id CHAR(24) PRIMARY KEY');
    for (const [k, p] of Object.entries(props)) {
      const types = [].concat(p.bsonType || p.type || []);
      const nullable = types.includes('null') || !required.includes(k);
      const checks = [];
      const c = ident(k);
      if (Array.isArray(p.enum)) checks.push(`${c} IN (${p.enum.filter((x) => x !== null).map((x) => sqlValue(x, notes)).join(', ')})`);
      if (p.minimum !== undefined) checks.push(`${c} >= ${p.minimum}`);
      if (p.maximum !== undefined) checks.push(`${c} <= ${p.maximum}`);
      if (p.minLength !== undefined) checks.push(`LENGTH(${c}) >= ${p.minLength}`);
      if (p.pattern !== undefined) checks.push(`${c} ~ ${sqlValue(p.pattern, notes)}`);
      cols.push(`${c} ${columnType(p)}${k === '_id' ? ' PRIMARY KEY' : nullable ? '' : ' NOT NULL'}${checks.length ? ` CHECK (${checks.join(' AND ')})` : ''}`);
    }
    notes.push('createCollection() with $jsonSchema → CREATE TABLE: bsonType → column type, required → NOT NULL, enum / minimum / maximum → CHECK.');
    return `CREATE TABLE ${ident(name)} (\n  ${cols.join(',\n  ')}\n);`;
  }

  function translateDb(st, notes) {
    const a = st.args;
    switch (st.name) {
      case 'createCollection':
        if (typeof a[0] !== 'string') fail('createCollection() expects a name');
        return createTableSql(a[0], a[1], notes);
      case 'createView': {
        const [name, source, pipeline = []] = a;
        if (typeof name !== 'string' || typeof source !== 'string') fail('createView() expects (name, source collection, pipeline)');
        const b = new Builder(source, notes);
        if (runPipeline(b, arr(pipeline, 'createView() pipeline'))) fail('$facet / $out / $merge are not allowed in a view');
        notes.push('db.createView() → CREATE VIEW ... AS SELECT.');
        return `CREATE VIEW ${ident(name)} AS\n${renderSelect(b.q)};`;
      }
      case 'dropDatabase':
        notes.push('dropDatabase() drops the current database; SQL needs its name.');
        return 'DROP DATABASE current_database;';
      case 'getCollectionNames':
        return "SELECT table_name\nFROM information_schema.tables\nWHERE table_schema = 'public';";
      default:
        fail(`db.${st.name}() is not supported`);
    }
  }

  // ---------------------------------------------------------------- entry point

  function translateCollection(st, notes) {
    const m = st.calls[0].name;
    switch (m) {
      case 'find': case 'findOne': return translateFind(st, notes);
      case 'count': case 'countDocuments': case 'estimatedDocumentCount': return translateCount(st, notes);
      case 'distinct': return translateDistinct(st, notes);
      case 'aggregate': return translateAggregate(st, notes);
      case 'insertOne': case 'insertMany': case 'insert': return translateInsert(st, notes);
      case 'updateOne': case 'updateMany': case 'update': case 'replaceOne': case 'findOneAndUpdate': case 'findOneAndReplace':
        return translateUpdate(st, notes);
      case 'deleteOne': case 'deleteMany': case 'remove': case 'findOneAndDelete': return translateDelete(st, notes);
      case 'bulkWrite': return translateBulkWrite(st, notes);
      case 'createIndex': case 'ensureIndex': case 'createIndexes': case 'dropIndex': case 'dropIndexes': case 'getIndexes':
        return translateIndexes(st, notes);
      case 'drop': noChain(st); return `DROP TABLE ${ident(st.coll)};`;
      case 'renameCollection': noChain(st); return `ALTER TABLE ${ident(st.coll)} RENAME TO ${ident(st.calls[0].args[0])};`;
      default: fail(`Unsupported method ${m}() — try find, aggregate, insertOne, updateMany, deleteMany or createIndex`);
    }
  }

  function translateStatement(st, notes) {
    switch (st.kind) {
      case 'coll': return translateCollection(st, notes);
      case 'db': return translateDb(st, notes);
      case 'use':
        notes.push('use <db> → USE (MySQL / SQL Server); in PostgreSQL you connect to the database instead (\\c name).');
        return `USE ${ident(st.name)};`;
      case 'show':
        if (st.what === 'collections' || st.what === 'tables') return 'SHOW TABLES;';
        if (st.what === 'dbs' || st.what === 'databases') return 'SHOW DATABASES;';
        fail(`show ${st.what} is not supported`);
      case 'noop': return null;
      case 'session':
        switch (st.method) {
          case 'startTransaction':
            notes.push('Session transactions → BEGIN / COMMIT / ROLLBACK.');
            return 'BEGIN;';
          case 'commitTransaction': return 'COMMIT;';
          case 'abortTransaction': return 'ROLLBACK;';
          case 'endSession': return null;
          default: fail(`session.${st.method}() is not supported`);
        }
    }
  }

  function translate(src) {
    const stmts = new Parser(tokenize(src)).program();
    if (!stmts.length) fail('Nothing to translate');
    const notes = [];
    const output = stmts.map((st) => translateStatement(st, notes)).filter((s) => s !== null).join('\n\n');
    return { output, notes: [...new Set(notes)] };
  }

  return { translate, TranslateError };
});
