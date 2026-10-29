/*
 * MongoDB (mongosh) -> SQL translator.
 * Parses shell commands like db.users.find({...}).sort({...}) and emits standard-ish SQL.
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
      if ('{}[](),:.;-+'.includes(c)) { tokens.push({ type: 'punct', value: c }); i++; continue; }
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
      if (!this.is('ident', 'db')) this.fail('Expected a command starting with db.<collection>');
      this.p++;
      let coll;
      if (this.accept('[')) { coll = this.string(); this.expect(']'); }
      else {
        this.expect('.');
        const name = this.ident();
        if (name === 'getCollection' && this.accept('(')) { coll = this.string(); this.expect(')'); }
        else coll = name;
      }
      const calls = [];
      while (this.accept('.')) {
        const name = this.ident();
        this.expect('(');
        calls.push({ name, args: this.list(')') });
      }
      if (!calls.length) this.fail(`Expected a method call such as db.${coll}.find()`);
      return { coll, calls };
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
        }
        let name = t.value, isNew = false;
        if (name === 'new') { isNew = true; name = this.ident(); }
        if (this.accept('(')) return new Call(name, this.list(')'), isNew);
        fail(`Unknown name "${t.value}" — variables are not supported, use literal values`);
      }
      this.fail('Expected a value');
    }
  }

  // ---------------------------------------------------------------- SQL helpers

  const SQL_RESERVED = new Set((
    'SELECT FROM WHERE GROUP ORDER BY HAVING LIMIT OFFSET JOIN ON AND OR NOT IN IS NULL LIKE BETWEEN AS SET ' +
    'VALUES INTO INSERT UPDATE DELETE DISTINCT TABLE USER KEY INDEX DESC ASC CASE WHEN THEN ELSE END ALL UNION'
  ).split(' '));

  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Call) && !(v instanceof Regex);
  const isOperatorObject = (v) => isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));

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

  function sqlValue(v, notes) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Call) return callValue(v, notes);
    if (v instanceof Regex) fail('A regular expression can only be used as a match condition');
    notes.push('Arrays and embedded documents have no plain SQL column type, so they are written as a JSON string here.');
    return sqlValue(JSON.stringify(toJson(v)), notes);
  }

  function callValue(c, notes) {
    const arg = c.args[0];
    switch (c.name) {
      case 'ObjectId': case 'ObjectID': case 'UUID':
        if (arg === undefined) fail(`${c.name}() without a value generates a new id — pass the id you want to match`);
        return sqlValue(arg, notes);
      case 'NumberInt': case 'NumberLong': case 'NumberDecimal': case 'Int32': case 'Long': case 'Decimal128': case 'Double':
        if (arg === undefined) fail(`${c.name}() needs a value`);
        return typeof arg === 'string' && arg.trim() !== '' && !isNaN(arg) ? String(Number(arg)) : sqlValue(arg, notes);
      case 'ISODate': case 'Date':
        if (arg === undefined) return 'CURRENT_TIMESTAMP';
        return sqlValue(arg, notes);
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
        default:
          if (k.startsWith('$')) fail(k === '$text' ? '$text search has no portable SQL equivalent' : `Unsupported query operator ${k}`);
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
        case '$size': case '$all': case '$elemMatch':
          fail(`${op} works on arrays, which plain SQL columns don't have`);
        default:
          fail(`Unsupported operator ${op}`);
      }
    }
    return and(parts);
  }

  function inCond(col, list, negate, ctx) {
    arr(list, negate ? '$nin' : '$in');
    const vals = list.filter((x) => x !== null);
    const parts = [];
    if (vals.length) parts.push(atom(`${col} ${negate ? 'NOT IN' : 'IN'} (${vals.map((x) => sqlValue(x, ctx.notes)).join(', ')})`));
    if (vals.length < list.length) parts.push(atom(`${col} IS ${negate ? 'NOT ' : ''}NULL`));
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
    $floor: 'FLOOR', $sqrt: 'SQRT', $year: 'YEAR', $month: 'MONTH', $dayOfMonth: 'DAY', $concat: 'CONCAT',
    $round: 'ROUND', $ifNull: 'COALESCE', $mod: 'MOD', $pow: 'POWER',
  };

  function exprCond(e, ctx) {
    if (isPlain(e) && Object.keys(e).length === 1) {
      const [op] = Object.keys(e), a = e[op];
      if (op === '$and') return and(arr(a, op).map((x) => exprCond(x, ctx)));
      if (op === '$or') return or(arr(a, op).map((x) => exprCond(x, ctx)));
      if (op === '$not') return not(exprCond(Array.isArray(a) ? a[0] : a, ctx));
    }
    return atom(exprSql(e, ctx));
  }

  function exprSql(e, ctx) {
    if (typeof e === 'string') {
      if (e === '$$NOW') return 'CURRENT_TIMESTAMP';
      if (e.startsWith('$$')) fail(`Variable ${e} is not supported`);
      if (e.startsWith('$')) return ctx.ref(e.slice(1));
      return sqlValue(e, ctx.notes);
    }
    if (Array.isArray(e)) fail('Array values are not supported inside expressions');
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
    switch (op) {
      case '$and': case '$or': case '$not':
        return render(exprCond(e, ctx));
      case '$in': {
        const [x, list] = args;
        return `${sub(x)} IN (${arr(list, op).map(sub).join(', ')})`;
      }
      case '$cond': {
        const [c, t, f] = Array.isArray(a) ? a : [a.if, a.then, a.else];
        return `CASE WHEN ${render(exprCond(c, ctx))} THEN ${sub(t)} ELSE ${sub(f)} END`;
      }
      case '$literal':
        return sqlValue(a, ctx.notes);
      case '$substr': case '$substrCP': case '$substrBytes': {
        const [s, start, len] = args;
        return `SUBSTRING(${sub(s)}, ${typeof start === 'number' ? start + 1 : `${arg(start)} + 1`}, ${sub(len)})`;
      }
      case '$trim': case '$ltrim': case '$rtrim':
        return `${{ $trim: 'TRIM', $ltrim: 'LTRIM', $rtrim: 'RTRIM' }[op]}(${sub(a.input)})`;
      case '$size': {
        // { $size: "$x" } where x was built with $push / $addToSet -> COUNT
        const inner = sub(args[0]);
        const m = /^ARRAY_AGG\((.*)\)$/.exec(inner);
        if (m) return `COUNT(${m[1]})`;
        fail('$size works on arrays, which plain SQL columns don\'t have');
      }
      case '$regexMatch': {
        const re = a.regex instanceof Regex ? a.regex : new Regex(String(a.regex), '');
        return render(regexCond(sub(a.input), re.source, re.flags + (a.options || ''), false, ctx));
      }
    }
    if (op in FUNCS) return `${FUNCS[op]}(${args.map(sub).join(', ')})`;
    fail(`Unsupported expression operator ${op}`);
  }

  // ---------------------------------------------------------------- SELECT building

  function newSelect(from) {
    return { from, distinct: false, columns: ['*'], joins: [], where: [], groupBy: [], having: [], orderBy: [], limit: null, offset: null };
  }

  function renderSelect(s) {
    const lines = [`SELECT ${s.distinct ? 'DISTINCT ' : ''}${s.columns.join(', ')}`, `FROM ${ident(s.from)}`];
    for (const j of s.joins) lines.push(`${j.kind} JOIN ${ident(j.table)}${j.alias !== j.table ? ' AS ' + ident(j.alias) : ''} ON ${j.on}`);
    const where = and(s.where), having = and(s.having);
    if (where) lines.push('WHERE ' + render(where));
    if (s.groupBy.length) lines.push('GROUP BY ' + s.groupBy.join(', '));
    if (having) lines.push('HAVING ' + render(having));
    if (s.orderBy.length) lines.push('ORDER BY ' + s.orderBy.join(', '));
    if (s.limit != null) lines.push('LIMIT ' + s.limit);
    if (s.offset) lines.push('OFFSET ' + s.offset);
    return lines.join('\n') + ';';
  }

  function sortList(spec, refFn) {
    if (!isPlain(spec)) fail('sort expects an object, e.g. { name: 1 }');
    return Object.entries(spec).map(([k, d]) => `${refFn(k)} ${d === -1 || d === 'desc' || d === 'descending' ? 'DESC' : 'ASC'}`);
  }

  const simpleCtx = (notes) => ({ ref: ident, notes });

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
    const s = newSelect(st.coll);
    const [filter = {}, proj] = first.args;
    s.where.push(filterCond(filter, ctx));
    s.columns = projectionColumns(proj, ctx);
    if (first.name === 'findOne') { s.limit = 1; notes.push('findOne() → LIMIT 1.'); }
    for (const c of chain) {
      const a = c.args[0];
      switch (c.name) {
        case 'sort': s.orderBy = sortList(a, ident); notes.push('sort({ field: 1 / -1 }) → ORDER BY field ASC / DESC.'); break;
        case 'limit': { const n = num(a, 'limit()'); s.limit = n === 0 ? null : Math.abs(n); break; }
        case 'skip': s.offset = num(a, 'skip()'); notes.push('skip(n) → OFFSET n.'); break;
        case 'projection': s.columns = projectionColumns(a, ctx); break;
        case 'count': case 'itcount':
          s.columns = ['COUNT(*)']; s.orderBy = []; s.limit = null; s.offset = null;
          break;
        case 'pretty': case 'toArray': case 'hint': case 'batchSize': break;
        default: fail(`Unsupported cursor method .${c.name}()`);
      }
    }
    if (s.where[0]) notes.push('The find() filter becomes the WHERE clause; fields listed together are combined with AND.');
    return renderSelect(s);
  }

  function translateCount(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const s = newSelect(st.coll);
    s.columns = ['COUNT(*)'];
    if (name !== 'estimatedDocumentCount') s.where.push(filterCond(args[0] || {}, simpleCtx(notes)));
    notes.push(`${name}() → SELECT COUNT(*).`);
    return renderSelect(s);
  }

  function translateDistinct(st, notes) {
    noChain(st);
    const [field, filter = {}] = st.calls[0].args;
    if (typeof field !== 'string') fail('distinct() expects a field name, e.g. distinct("city")');
    const s = newSelect(st.coll);
    s.distinct = true;
    s.columns = [ident(field)];
    s.where.push(filterCond(filter, simpleCtx(notes)));
    notes.push('distinct(field) → SELECT DISTINCT field.');
    return renderSelect(s);
  }

  // ---------------------------------------------------------------- aggregate()

  function translateAggregate(st, notes) {
    noChain(st);
    const stages = st.calls[0].args[0];
    if (!Array.isArray(stages)) fail('aggregate() expects an array of stages');
    const s = newSelect(st.coll);
    // Fields that $group / $project / $addFields defined: name -> { sql, alias }.
    // Once `closed`, only these fields exist (as after $group or $project).
    let fields = new Map();
    let closed = false, grouped = false, limited = false;
    const joinAliases = new Set();

    const ref = (path) => {
      if (fields.has(path)) return fields.get(path).sql;
      if (closed) fail(`Field "${path}" does not exist at this point of the pipeline`);
      return ident(path);
    };
    const sortRef = (path) => (fields.has(path) && fields.get(path).alias ? ident(fields.get(path).alias) : ref(path));
    const ctx = { ref, notes };

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!isPlain(stage) || Object.keys(stage).length !== 1) fail(`Stage ${i + 1} must be an object with exactly one $stage key`);
      const [op] = Object.keys(stage), a = stage[op];
      if (limited && op !== '$limit' && op !== '$skip') fail(`${op} after $limit / $skip would need a subquery — not supported`);
      switch (op) {
        case '$match': {
          const c = filterCond(a, ctx);
          if (grouped) { s.having.push(c); notes.push('$match after $group → HAVING (filters groups, not rows).'); }
          else { s.where.push(c); notes.push('$match → WHERE.'); }
          break;
        }
        case '$group': {
          if (grouped) fail('A second $group would need a subquery — not supported');
          if (!isPlain(a) || !('_id' in a)) fail('$group needs an _id (use _id: null for one group)');
          fields = groupFields(a, s, ref, ctx);
          s.orderBy = [];
          closed = grouped = true;
          notes.push('$group → GROUP BY; _id is the grouping key and each accumulator becomes an aggregate function.');
          break;
        }
        case '$project': {
          const next = projectFields(a, fields, closed, ref, ctx, s);
          if (next) { fields = next; closed = true; }
          notes.push('$project → the SELECT column list.');
          break;
        }
        case '$addFields': case '$set': {
          if (!isPlain(a)) fail(`${op} expects an object`);
          const added = Object.entries(a).map(([k, v]) => [k, exprSql(v, ctx)]);
          for (const [k, sql] of added) { s.columns.push(selectItem(sql, k)); fields.set(k, { sql, alias: k }); }
          notes.push(`${op} → extra computed columns in SELECT.`);
          break;
        }
        case '$sort':
          s.orderBy = sortList(a, sortRef);
          notes.push('$sort → ORDER BY.');
          break;
        case '$limit': {
          const n = num(a, '$limit');
          s.limit = s.limit == null ? n : Math.min(s.limit, n);
          limited = true;
          break;
        }
        case '$skip': {
          const n = num(a, '$skip');
          if (s.limit != null) s.limit = Math.max(0, s.limit - n);
          s.offset = (s.offset || 0) + n;
          limited = true;
          notes.push('$skip → OFFSET.');
          break;
        }
        case '$count': {
          if (grouped) fail('$count after $group would need a subquery — not supported');
          if (typeof a !== 'string') fail('$count expects the name of the output field');
          s.columns = [`COUNT(*) AS ${ident(a)}`];
          fields = new Map([[a, { sql: 'COUNT(*)', alias: a }]]);
          closed = grouped = true;
          notes.push('$count → SELECT COUNT(*).');
          break;
        }
        case '$lookup': {
          const { from, localField, foreignField, as } = a || {};
          if (!from || !localField || !foreignField || !as) fail('Only the $lookup form with from / localField / foreignField / as is supported');
          let kind = 'LEFT';
          const unwind = stages[i + 1] && stages[i + 1].$unwind;
          const unwindPath = typeof unwind === 'string' ? unwind : unwind && unwind.path;
          if (unwindPath === '$' + as) {
            kind = unwind.preserveNullAndEmptyArrays ? 'LEFT' : 'INNER';
            i++;
            notes.push(`$lookup + $unwind → ${kind} JOIN (one row per match${kind === 'LEFT' ? ', unmatched rows kept' : ''}).`);
          } else {
            notes.push(`$lookup alone returns the matches as an array field "${as}"; SQL returns one row per match instead.`);
          }
          const qualified = localField.includes('.') && joinAliases.has(localField.split('.')[0]);
          const local = qualified ? ref(localField) : `${ident(st.coll)}.${ident(localField)}`;
          s.joins.push({ kind, table: from, alias: as, on: `${local} = ${ident(as)}.${ident(foreignField)}` });
          joinAliases.add(as);
          break;
        }
        case '$unwind':
          fail('$unwind flattens arrays — it is only supported right after a $lookup');
        default:
          fail(`Unsupported stage ${op}`);
      }
    }
    return renderSelect(s);
  }

  function groupFields(spec, s, ref, ctx) {
    const next = new Map();
    const cols = [];
    const id = spec._id;
    const isKeyObject = isPlain(id) && Object.keys(id).length > 0 && !Object.keys(id).some((k) => k.startsWith('$'));
    if (isKeyObject) {
      for (const [k, v] of Object.entries(id)) {
        const sql = exprSql(v, ctx);
        s.groupBy.push(sql);
        next.set('_id.' + k, { sql, alias: k });
        cols.push(selectItem(sql, k));
      }
    } else if (typeof id === 'string' ? id.startsWith('$') : isPlain(id)) {
      const sql = exprSql(id, ctx);
      const name = typeof id === 'string' ? id.slice(1).split('.').pop() : '_id';
      s.groupBy.push(sql);
      next.set('_id', { sql, alias: name });
      cols.push(selectItem(sql, name));
    } // otherwise a constant _id (usually null): one group for everything

    for (const [k, acc] of Object.entries(spec)) {
      if (k === '_id') continue;
      if (!isPlain(acc) || Object.keys(acc).length !== 1) fail(`Accumulator "${k}" must look like { $sum: "$field" }`);
      const [op] = Object.keys(acc), a = acc[op];
      let sql;
      switch (op) {
        case '$sum': sql = a === 1 ? 'COUNT(*)' : `SUM(${exprSql(a, ctx)})`; break;
        case '$count': sql = 'COUNT(*)'; break;
        case '$avg': sql = `AVG(${exprSql(a, ctx)})`; break;
        case '$min': sql = `MIN(${exprSql(a, ctx)})`; break;
        case '$max': sql = `MAX(${exprSql(a, ctx)})`; break;
        case '$push': case '$addToSet':
          sql = `ARRAY_AGG(${op === '$addToSet' ? 'DISTINCT ' : ''}${exprSql(a, ctx)})`;
          ctx.notes.push('$push / $addToSet collect arrays → ARRAY_AGG (PostgreSQL); wrapped in $size they become COUNT.');
          break;
        case '$first': case '$last':
          fail(`${op} depends on document order — SQL needs window functions for that`);
        default:
          fail(`Unsupported accumulator ${op}`);
      }
      next.set(k, { sql, alias: k });
      cols.push(`${sql} AS ${ident(k)}`);
    }
    s.columns = cols.length ? cols : ['COUNT(*)'];
    return next;
  }

  function projectFields(spec, fields, closed, ref, ctx, s) {
    if (!isPlain(spec)) fail('$project expects an object');
    const entries = Object.entries(spec);
    const isOff = (v) => v === 0 || v === false;
    const isOn = (v) => v === 1 || v === true;
    const others = entries.filter(([k]) => k !== '_id');
    if (others.some(([, v]) => isOff(v))) {
      if (others.every(([, v]) => isOff(v))) {
        ctx.notes.push('Exclusion projections ({ field: 0 }) have no SQL equivalent — list the columns you want instead.');
        return null;
      }
      fail('$project cannot mix including and excluding fields (except _id)');
    }
    const next = new Map();
    const cols = [];
    const idSpec = spec._id;
    if (idSpec === undefined || isOn(idSpec)) {
      if (closed) {
        for (const [k, f] of fields) {
          if (k === '_id' || k.startsWith('_id.')) { cols.push(selectItem(f.sql, f.alias)); next.set(k, f); }
        }
      } else {
        cols.push(ident('_id'));
        next.set('_id', { sql: ident('_id'), alias: '_id' });
      }
    }
    for (const [k, v] of entries) {
      if (k === '_id' && (isOn(v) || isOff(v))) continue;
      const sql = isOn(v) ? ref(k) : exprSql(v, ctx);
      cols.push(selectItem(sql, k));
      next.set(k, { sql, alias: k });
    }
    s.columns = cols.length ? cols : ['*'];
    return next;
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

  function updateSets(update, name, ctx) {
    const sets = [];
    const notes = ctx.notes;
    if (name === 'replaceOne') {
      if (!isPlain(update)) fail('replaceOne() expects a replacement document');
      for (const [k, v] of Object.entries(update)) if (k !== '_id') sets.push(`${ident(k)} = ${sqlValue(v, notes)}`);
      notes.push('replaceOne() replaces the whole document; this UPDATE only sets the listed columns.');
      return sets;
    }
    if (Array.isArray(update)) {
      for (const stage of update) {
        const [op, ...more] = Object.keys(stage || {});
        if (more.length || !['$set', '$addFields', '$unset'].includes(op)) fail('Only $set / $addFields / $unset stages are supported in update pipelines');
        if (op === '$unset') for (const f of [].concat(stage.$unset)) sets.push(`${ident(f)} = NULL`);
        else for (const [k, v] of Object.entries(stage[op])) sets.push(`${ident(k)} = ${exprSql(v, ctx)}`);
      }
      return sets;
    }
    if (!isPlain(update)) fail(`${name}() expects a filter and an update document`);
    for (const [op, spec] of Object.entries(update)) {
      if (!op.startsWith('$')) fail('Update documents need operators such as $set — use replaceOne() to replace a whole document');
      if (!isPlain(spec)) fail(`${op} expects an object`);
      for (const [k, v] of Object.entries(spec)) {
        const col = ident(k);
        switch (op) {
          case '$set': sets.push(`${col} = ${sqlValue(v, notes)}`); break;
          case '$unset': sets.push(`${col} = NULL`); notes.push('$unset removes a field; the SQL equivalent is setting the column to NULL.'); break;
          case '$inc':
            sets.push(typeof v === 'number' && v < 0 ? `${col} = ${col} - ${-v}` : `${col} = ${col} + ${sqlValue(v, notes)}`);
            notes.push('$inc → SET column = column + n.');
            break;
          case '$mul': sets.push(`${col} = ${col} * ${sqlValue(v, notes)}`); break;
          case '$min': sets.push(`${col} = LEAST(${col}, ${sqlValue(v, notes)})`); break;
          case '$max': sets.push(`${col} = GREATEST(${col}, ${sqlValue(v, notes)})`); break;
          case '$currentDate': sets.push(`${col} = CURRENT_TIMESTAMP`); break;
          case '$setOnInsert': notes.push('$setOnInsert only applies to upserts and is ignored here.'); break;
          case '$rename': fail('$rename changes the schema — in SQL that is ALTER TABLE ... RENAME COLUMN');
          case '$push': case '$pull': case '$addToSet': case '$pop': case '$pullAll':
            fail(`${op} modifies arrays, which plain SQL columns don't have`);
          default: fail(`Unsupported update operator ${op}`);
        }
      }
    }
    return sets;
  }

  function translateUpdate(st, notes) {
    noChain(st);
    const { name, args } = st.calls[0];
    const [filter = {}, update, options = {}] = args;
    const ctx = simpleCtx(notes);
    const sets = updateSets(update, name, ctx);
    if (!sets.length) fail('Nothing to update');
    const where = filterCond(filter, ctx);
    const one = name === 'updateOne' || name === 'replaceOne' || (name === 'update' && !(isPlain(options) && options.multi));
    if (isPlain(options) && options.upsert) notes.push('upsert has no single standard SQL form — see INSERT ... ON CONFLICT (PostgreSQL) or ON DUPLICATE KEY UPDATE (MySQL).');
    if (one) notes.push(`${name}() changes only the first match. LIMIT 1 on UPDATE is MySQL syntax; standard SQL updates every matching row.`);
    else notes.push(`${name}() → UPDATE, which changes every matching row.`);
    let sql = `UPDATE ${ident(st.coll)}\nSET ${sets.join(',\n    ')}`;
    if (where) sql += `\nWHERE ${render(where)}`;
    else notes.push('Empty filter: every row is updated.');
    if (one) sql += '\nLIMIT 1';
    return sql + ';';
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
    return sql + ';';
  }

  // ---------------------------------------------------------------- entry point

  function translateStatement(st, notes) {
    const m = st.calls[0].name;
    switch (m) {
      case 'find': case 'findOne': return translateFind(st, notes);
      case 'count': case 'countDocuments': case 'estimatedDocumentCount': return translateCount(st, notes);
      case 'distinct': return translateDistinct(st, notes);
      case 'aggregate': return translateAggregate(st, notes);
      case 'insertOne': case 'insertMany': case 'insert': return translateInsert(st, notes);
      case 'updateOne': case 'updateMany': case 'update': case 'replaceOne': return translateUpdate(st, notes);
      case 'deleteOne': case 'deleteMany': case 'remove': return translateDelete(st, notes);
      case 'drop': noChain(st); return `DROP TABLE ${ident(st.coll)};`;
      default: fail(`Unsupported method ${m}() — try find, aggregate, insertOne, updateMany or deleteMany`);
    }
  }

  function translate(src) {
    const stmts = new Parser(tokenize(src)).program();
    if (!stmts.length) fail('Nothing to translate');
    const notes = [];
    const output = stmts.map((st) => translateStatement(st, notes)).join('\n\n');
    return { output, notes: [...new Set(notes)] };
  }

  return { translate, TranslateError };
});
