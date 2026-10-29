/*
 * SQL -> MongoDB (mongosh) translator.
 * Parses a practical subset of SQL (SELECT / INSERT / UPDATE / DELETE) and emits shell syntax.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlToMongo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class TranslateError extends Error {}
  const fail = (msg) => { throw new TranslateError(msg); };

  const RESERVED = new Set((
    'SELECT FROM WHERE GROUP ORDER BY HAVING LIMIT OFFSET FETCH JOIN INNER LEFT RIGHT FULL OUTER CROSS ' +
    'ON AND OR NOT IN IS NULL LIKE ILIKE REGEXP RLIKE BETWEEN AS SET VALUES INTO INSERT UPDATE DELETE ' +
    'DISTINCT ALL UNION ASC DESC TRUE FALSE CASE WHEN THEN ELSE END TOP'
  ).split(' '));

  // ---------------------------------------------------------------- tokenizer

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
      if (c === "'") {
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
      const two = src.substr(i, 2);
      if (['<=', '>=', '<>', '!=', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
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

  class Parser {
    constructor(tokens) { this.t = tokens; this.p = 0; }
    peek(o = 0) { return this.t[Math.min(this.p + o, this.t.length - 1)]; }
    next() { return this.t[this.p++]; }
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

    parseAll() {
      const stmts = [];
      while (this.peek().type !== 'eof') {
        if (this.acceptOp(';')) continue;
        stmts.push(this.statement());
        if (this.peek().type !== 'eof' && !this.isOp(';')) this.fail('Expected end of statement');
      }
      return stmts;
    }

    statement() {
      if (this.isKw('SELECT')) return this.select();
      if (this.isKw('INSERT')) return this.insert();
      if (this.isKw('UPDATE')) return this.update();
      if (this.isKw('DELETE')) return this.del();
      this.fail('Expected SELECT, INSERT, UPDATE or DELETE');
    }

    qualifiedName() {
      let name = this.ident();
      while (this.acceptOp('.')) name = this.ident(); // schema.table -> table
      return name;
    }

    tableRef() {
      const name = this.qualifiedName();
      let alias = null;
      if (this.acceptKw('AS')) alias = this.ident();
      else if (this.isName()) alias = this.ident();
      return { name, alias: alias || name };
    }

    select() {
      this.expectKw('SELECT');
      const q = { type: 'select', distinct: false, columns: [], joins: [], where: null, groupBy: [], having: null, orderBy: [], limit: null, offset: null };
      if (this.acceptKw('DISTINCT')) q.distinct = true;
      else this.acceptKw('ALL');
      if (this.acceptKw('TOP')) q.limit = this.intValue();
      do q.columns.push(this.selectItem()); while (this.acceptOp(','));
      this.expectKw('FROM');
      q.from = this.tableRef();
      for (;;) {
        let kind;
        if (this.acceptKw('JOIN') || this.acceptKw('INNER', 'JOIN')) kind = 'inner';
        else if (this.acceptKw('LEFT', 'JOIN') || this.acceptKw('LEFT', 'OUTER', 'JOIN')) kind = 'left';
        else if (this.isKw('RIGHT') || this.isKw('FULL') || this.isKw('CROSS')) fail(`${this.peek().value.toUpperCase()} JOIN is not supported — only INNER and LEFT joins map to $lookup`);
        else if (this.isOp(',')) fail('Comma-separated tables are not supported — use JOIN ... ON');
        else break;
        const table = this.tableRef();
        this.expectKw('ON');
        q.joins.push({ kind, table, on: this.expr() });
      }
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('GROUP', 'BY')) { do q.groupBy.push(this.expr()); while (this.acceptOp(',')); }
      if (this.acceptKw('HAVING')) q.having = this.expr();
      if (this.acceptKw('ORDER', 'BY')) {
        do {
          const expr = this.expr();
          let dir = 1;
          if (this.acceptKw('DESC')) dir = -1;
          else this.acceptKw('ASC');
          q.orderBy.push({ expr, dir });
        } while (this.acceptOp(','));
      }
      if (this.acceptKw('LIMIT')) {
        const a = this.intValue();
        if (this.acceptOp(',')) { q.offset = a; q.limit = this.intValue(); } else q.limit = a;
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
      return q;
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

    insert() {
      this.expectKw('INSERT');
      this.expectKw('INTO');
      const table = this.qualifiedName();
      let columns = null;
      if (this.acceptOp('(')) {
        columns = [];
        do columns.push(this.ident()); while (this.acceptOp(','));
        this.expectOp(')');
      }
      if (this.isKw('SELECT')) fail('INSERT ... SELECT is not supported');
      this.expectKw('VALUES');
      const rows = [];
      do {
        this.expectOp('(');
        const row = [];
        do row.push(this.expr()); while (this.acceptOp(','));
        this.expectOp(')');
        rows.push(row);
      } while (this.acceptOp(','));
      return { type: 'insert', table, columns, rows };
    }

    update() {
      this.expectKw('UPDATE');
      const table = this.tableRef();
      this.expectKw('SET');
      const sets = [];
      do {
        const parts = [this.ident()];
        while (this.acceptOp('.')) parts.push(this.ident());
        this.expectOp('=');
        sets.push({ column: { type: 'col', parts }, value: this.expr() });
      } while (this.acceptOp(','));
      const q = { type: 'update', table, sets, where: null, limit: null };
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('LIMIT')) q.limit = this.intValue();
      return q;
    }

    del() {
      this.expectKw('DELETE');
      this.expectKw('FROM');
      const q = { type: 'delete', table: this.tableRef(), where: null, limit: null };
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('LIMIT')) q.limit = this.intValue();
      return q;
    }

    // Expressions, lowest precedence first.
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
        this.expectKw('NULL');
        return { type: 'isnull', expr: left, not };
      }
      const not = this.acceptKw('NOT');
      if (this.acceptKw('IN')) {
        this.expectOp('(');
        if (this.isKw('SELECT')) fail('Subqueries are not supported');
        const list = [];
        do list.push(this.additive()); while (this.acceptOp(','));
        this.expectOp(')');
        return { type: 'in', expr: left, list, not };
      }
      if (this.acceptKw('BETWEEN')) {
        const low = this.additive();
        this.expectKw('AND');
        return { type: 'between', expr: left, low, high: this.additive(), not };
      }
      if (this.isKw('LIKE') || this.isKw('ILIKE')) {
        const ci = this.next().value.toUpperCase() === 'ILIKE';
        return { type: 'like', expr: left, pattern: this.additive(), not, ci };
      }
      if (this.acceptKw('REGEXP') || this.acceptKw('RLIKE')) {
        return { type: 'regex', expr: left, pattern: this.additive(), flags: '', not };
      }
      if (not) this.fail('Expected IN, BETWEEN or LIKE after NOT');
      const t = this.peek();
      if (t.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
        this.p++;
        return { type: 'cmp', op: t.value === '<>' ? '!=' : t.value, left, right: this.additive() };
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
      return this.primary();
    }

    primary() {
      const t = this.peek();
      if (t.type === 'number' || t.type === 'string') { this.p++; return { type: 'lit', value: t.value }; }
      if (this.acceptOp('(')) {
        if (this.isKw('SELECT')) fail('Subqueries are not supported');
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
          if (kw === 'CASE') fail('CASE expressions are not supported yet');
          if (this.isOp('(', 1)) return this.funcCall();
          if (kw === 'CURRENT_TIMESTAMP' || kw === 'CURRENT_DATE') { this.p++; return { type: 'func', name: kw, args: [], distinct: false }; }
          if (RESERVED.has(kw)) this.fail('Expected an expression');
        }
        const parts = [this.next().value];
        while (this.acceptOp('.')) parts.push(this.ident());
        return { type: 'col', parts };
      }
      this.fail('Expected an expression');
    }

    funcCall() {
      const node = { type: 'func', name: this.next().value.toUpperCase(), args: [], distinct: false };
      this.expectOp('(');
      if (this.acceptOp('*')) { node.star = true; this.expectOp(')'); return node; }
      if (this.acceptOp(')')) return node;
      if (this.acceptKw('DISTINCT')) node.distinct = true;
      do node.args.push(this.expr()); while (this.acceptOp(','));
      this.expectOp(')');
      return node;
    }
  }

  // ---------------------------------------------------------------- mongosh printer

  class Raw { constructor(code) { this.code = code; } }

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
  function fmt(v, indent = 0) {
    const f = flat(v);
    if (indent + f.length <= WIDTH || !(Array.isArray(v) || isPlain(v))) return f;
    const pad = ' '.repeat(indent), inner = ' '.repeat(indent + 2);
    if (Array.isArray(v)) return '[\n' + v.map((x) => inner + fmt(x, indent + 2)).join(',\n') + '\n' + pad + ']';
    return '{\n' + Object.entries(v).map(([k, x]) => inner + key(k) + ': ' + fmt(x, indent + 2)).join(',\n') + '\n' + pad + '}';
  }

  const fmtPipeline = (stages) => '[\n' + stages.map((s) => '  ' + fmt(s, 2)).join(',\n') + '\n]';
  const collection = (name) => (/^[A-Za-z_][\w]*$/.test(name) ? 'db.' + name : `db.getCollection(${JSON.stringify(name)})`);

  // ---------------------------------------------------------------- shared helpers

  const AGGREGATES = { COUNT: '$sum', SUM: '$sum', AVG: '$avg', MIN: '$min', MAX: '$max' };
  const isAgg = (n) => !!n && n.type === 'func' && n.name in AGGREGATES;
  const CMP = { '=': '$eq', '!=': '$ne', '<': '$lt', '<=': '$lte', '>': '$gt', '>=': '$gte' };
  const FLIP = { '=': '=', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
  const BINOPS = { '+': '$add', '-': '$subtract', '*': '$multiply', '/': '$divide', '%': '$mod', '||': '$concat' };
  const NOW_FUNCS = new Set(['NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'SYSDATE', 'GETDATE']);
  const NO = Symbol('not-a-literal');

  function containsAgg(node) {
    if (!node || typeof node !== 'object') return false;
    if (isAgg(node)) return true;
    return Object.values(node).some((v) => (Array.isArray(v) ? v.some(containsAgg) : containsAgg(v)));
  }

  function literal(node) {
    if (node.type === 'lit') return node.value;
    if (node.type === 'func' && NOW_FUNCS.has(node.name) && !node.args.length) return new Raw('new Date()');
    return NO;
  }

  const lastPart = (col) => col.parts[col.parts.length - 1];

  function defaultName(node) {
    if (node.type === 'col') return lastPart(node);
    if (node.type === 'func') {
      const fn = node.name.toLowerCase();
      const a = node.args[0];
      return a && a.type === 'col' ? `${fn}_${lastPart(a)}` : fn;
    }
    return 'expr';
  }

  function uniqueName(base, taken) {
    const name = String(base).replace(/\./g, '_').replace(/^\$+/, '') || 'field';
    let n = name;
    for (let i = 2; taken.has(n); i++) n = `${name}_${i}`;
    taken.add(n);
    return n;
  }

  function makeScope(from, joins) {
    const main = new Set([from.alias.toLowerCase(), from.name.toLowerCase()]);
    const joined = new Map(joins.map((j) => [j.table.alias.toLowerCase(), j.table.alias]));
    const scope = {
      joinTouched: false,
      // Column reference -> document path. Main-table qualifiers are dropped; joined aliases stay as a prefix.
      path(col) {
        const [head, ...rest] = col.parts;
        if (rest.length) {
          const h = head.toLowerCase();
          if (joined.has(h)) { scope.joinTouched = true; return joined.get(h) + '.' + rest.join('.'); }
          if (main.has(h)) return rest.join('.');
        }
        return col.parts.join('.');
      },
      canon(node) { return JSON.stringify(node, (k, v) => (v && v.type === 'col' ? scope.path(v) : v)); },
    };
    return scope;
  }

  const baseContext = (scope, notes) => ({ scope, notes, fieldOf: (n) => (n.type === 'col' ? scope.path(n) : null) });

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

  // ---------------------------------------------------------------- WHERE -> query filter

  function toFilter(node, ctx) {
    switch (node.type) {
      case 'and': return mergeAnd(node.items.map((n) => toFilter(n, ctx)));
      case 'or': return { $or: node.items.flatMap((n) => { const f = toFilter(n, ctx); return isOnly(f, '$or') ? f.$or : [f]; }) };
      case 'not': return negate(toFilter(node.expr, ctx));
      case 'cmp': return cmpFilter(node, ctx);
      case 'in': {
        const f = ctx.fieldOf(node.expr), vals = node.list.map(literal);
        if (f && !vals.includes(NO)) return { [f]: { [node.not ? '$nin' : '$in']: vals } };
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

  function cmpFilter(node, ctx) {
    let op = node.op;
    let f = ctx.fieldOf(node.left), v = literal(node.right);
    if (!f || v === NO) {
      const f2 = ctx.fieldOf(node.right), v2 = literal(node.left);
      if (!f2 || v2 === NO) return { $expr: aggExpr(node, ctx) };
      f = f2; v = v2; op = FLIP[op];
    }
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

  // ---------------------------------------------------------------- expressions -> aggregation expressions

  const unary = (op) => (a, name) => {
    if (a.length !== 1) fail(`${name}() takes exactly one argument`);
    return { [op]: a[0] };
  };

  const SCALAR = {
    UPPER: unary('$toUpper'), UCASE: unary('$toUpper'),
    LOWER: unary('$toLower'), LCASE: unary('$toLower'),
    LENGTH: unary('$strLenCP'), CHAR_LENGTH: unary('$strLenCP'), LEN: unary('$strLenCP'),
    ABS: unary('$abs'), CEIL: unary('$ceil'), CEILING: unary('$ceil'), FLOOR: unary('$floor'), SQRT: unary('$sqrt'),
    YEAR: unary('$year'), MONTH: unary('$month'), DAY: unary('$dayOfMonth'), DAYOFMONTH: unary('$dayOfMonth'),
    TRIM: (a) => ({ $trim: { input: a[0] } }),
    LTRIM: (a) => ({ $ltrim: { input: a[0] } }),
    RTRIM: (a) => ({ $rtrim: { input: a[0] } }),
    CONCAT: (a) => ({ $concat: a }),
    ROUND: (a) => ({ $round: a }),
    MOD: (a) => ({ $mod: a }),
    POWER: (a) => ({ $pow: a }), POW: (a) => ({ $pow: a }),
    COALESCE: (a) => ({ $ifNull: a }), IFNULL: (a) => ({ $ifNull: a }), NVL: (a) => ({ $ifNull: a }),
    SUBSTRING: substr, SUBSTR: substr,
  };
  for (const f of NOW_FUNCS) SCALAR[f] = () => '$$NOW';

  function substr(a) {
    if (a.length < 2) fail('SUBSTRING() needs at least a string and a start position');
    const start = typeof a[1] === 'number' ? a[1] - 1 : { $subtract: [a[1], 1] };
    return { $substrCP: [a[0], start, a.length > 2 ? a[2] : { $strLenCP: a[0] }] };
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
      case 'func': {
        const fn = SCALAR[node.name];
        if (!fn) fail(`Function ${node.name}() is not supported`);
        return fn(node.args.map(sub), node.name);
      }
      case 'binop': {
        const op = BINOPS[node.op];
        const assoc = op === '$add' || op === '$multiply' || op === '$concat';
        return { [op]: [node.left, node.right].flatMap((n) => { const v = sub(n); return assoc && isOnly(v, op) ? v[op] : [v]; }) };
      }
      case 'cmp': return { [CMP[node.op]]: [sub(node.left), sub(node.right)] };
      case 'and': return { $and: node.items.map(sub) };
      case 'or': return { $or: node.items.map(sub) };
      case 'not': return { $not: [sub(node.expr)] };
      case 'in': return wrapNot({ $in: [sub(node.expr), node.list.map(sub)] }, node.not);
      case 'between': {
        const x = sub(node.expr);
        return wrapNot({ $and: [{ $gte: [x, sub(node.low)] }, { $lte: [x, sub(node.high)] }] }, node.not);
      }
      case 'isnull': return { [node.not ? '$ne' : '$eq']: [sub(node.expr), null] };
      case 'like':
      case 'regex': {
        const p = literal(node.pattern);
        if (typeof p !== 'string') fail('LIKE / REGEXP patterns must be string literals');
        const regex = node.type === 'like' ? likeToRegex(p, node.ci) : makeRegex(p, node.flags);
        return wrapNot({ $regexMatch: { input: sub(node.expr), regex } }, node.not);
      }
    }
    fail('This expression is not supported');
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

  function translateSelect(q, notes) {
    const scope = makeScope(q.from, q.joins);
    const base = baseContext(scope, notes);
    const coll = collection(q.from.name);
    const anyAgg = q.columns.some((c) => !c.star && containsAgg(c.expr)) || containsAgg(q.having) || q.orderBy.some((o) => containsAgg(o.expr));
    const grouped = q.groupBy.length > 0 || anyAgg || q.distinct || !!q.having;
    const noJoins = q.joins.length === 0;

    if (!grouped && noJoins) {
      const found = translateFind(q, scope, base, coll, notes);
      if (found) return found;
    }
    if (grouped && noJoins && !q.groupBy.length && !q.having) {
      const only = q.columns.length === 1 && !q.columns[0].star ? q.columns[0].expr : null;
      if (only && !q.distinct && isCountAll(only)) {
        notes.push('COUNT(*) without GROUP BY → countDocuments().');
        const f = where(q, base);
        return `${coll}.countDocuments(${isEmpty(f) ? '' : fmt(f)})`;
      }
      if (only && q.distinct && only.type === 'col' && !q.orderBy.length && q.limit == null && q.offset == null) {
        notes.push('SELECT DISTINCT on one column → distinct(), which returns an array of the unique values.');
        const f = where(q, base);
        return `${coll}.distinct(${fmt(scope.path(only))}${isEmpty(f) ? '' : ', ' + fmt(f)})`;
      }
    }
    return translatePipeline(q, scope, base, coll, grouped, notes);
  }

  function translateFind(q, scope, base, coll, notes) {
    const star = q.columns.some((c) => c.star);
    const plain = q.columns.every((c) => c.star || (c.expr.type === 'col' && (!c.alias || c.alias === lastPart(c.expr))));
    if (!plain) return null;
    let sort;
    try { sort = planSort(q, [], base); } catch (e) { return null; }
    if (sort.post) return null;

    const filter = where(q, base);
    let proj = null;
    if (!star) {
      proj = {};
      let withId = false;
      for (const c of q.columns) {
        const p = scope.path(c.expr);
        if (p === '_id') withId = true; else proj[p] = 1;
      }
      if (!withId) { proj._id = 0; notes.push('MongoDB always returns _id unless the projection says _id: 0.'); }
      else if (isEmpty(proj)) proj._id = 1;
    }
    notes.push('SELECT → find(filter, projection); WHERE becomes the filter, the column list becomes the projection.');
    let out = `${coll}.find(${isEmpty(filter) && !proj ? '' : fmt(filter)}${proj ? ', ' + fmt(proj) : ''})`;
    if (sort.pre) out += `.sort(${fmt(sort.pre)})`;
    if (q.offset != null) out += `.skip(${q.offset})`;
    if (q.limit != null) out += `.limit(${q.limit})`;
    return out;
  }

  function lookupStages(j, scope) {
    const on = j.on;
    if (on.type !== 'cmp' || on.op !== '=' || on.left.type !== 'col' || on.right.type !== 'col') {
      fail('JOIN ... ON must be a single equality between two columns, e.g. o.user_id = u.id');
    }
    const alias = j.table.alias;
    const isJoinSide = (c) => c.parts.length > 1 && c.parts[0].toLowerCase() === alias.toLowerCase();
    let local, foreign;
    if (isJoinSide(on.right) && !isJoinSide(on.left)) { local = on.left; foreign = on.right; }
    else if (isJoinSide(on.left) && !isJoinSide(on.right)) { local = on.right; foreign = on.left; }
    else fail(`Cannot tell which side of the ON condition belongs to "${alias}" — qualify both columns with their table`);
    return [
      { $lookup: { from: j.table.name, localField: scope.path(local), foreignField: foreign.parts.slice(1).join('.'), as: alias } },
      { $unwind: j.kind === 'left' ? { path: '$' + alias, preserveNullAndEmptyArrays: true } : '$' + alias },
    ];
  }

  function translatePipeline(q, scope, base, coll, grouped, notes) {
    const pipeline = [];
    scope.joinTouched = false;
    const filter = q.where ? toFilter(q.where, base) : null;
    const filterNeedsJoin = scope.joinTouched;
    if (filter && !filterNeedsJoin) pipeline.push({ $match: filter });
    for (const j of q.joins) pipeline.push(...lookupStages(j, scope));
    if (q.joins.length) notes.push('JOIN → $lookup, then $unwind to get one document per match (like SQL rows). LEFT JOIN keeps unmatched documents via preserveNullAndEmptyArrays.');
    if (filter && filterNeedsJoin) pipeline.push({ $match: filter });
    if (filter) notes.push('WHERE → $match.');

    if (grouped) groupStages(q, scope, base, pipeline, notes);
    else projectStages(q, base, pipeline);
    return `${coll}.aggregate(${fmtPipeline(pipeline)})`;
  }

  function finish(pipeline, shape, sort, q) {
    if (sort.pre) pipeline.push({ $sort: sort.pre });
    if (sort.post) {
      if (shape) pipeline.push(shape);
      shape = null;
      pipeline.push({ $sort: sort.post });
    }
    if (q.offset != null) pipeline.push({ $skip: q.offset });
    if (q.limit != null) pipeline.push({ $limit: q.limit });
    if (shape) pipeline.push(shape);
  }

  function projectStages(q, base, pipeline) {
    const star = q.columns.some((c) => c.star);
    const taken = new Set();
    const outputs = [];
    let withId = false;
    for (const item of q.columns) {
      if (item.star) continue;
      const e = item.expr;
      if (e.type === 'col') {
        const p = base.fieldOf(e);
        if (!item.alias || item.alias === p) {
          if (p === '_id') withId = true;
          taken.add(p);
          outputs.push({ item, name: p, value: 1, plain: true });
        } else {
          outputs.push({ item, name: uniqueName(item.alias, taken), value: '$' + p });
        }
        continue;
      }
      outputs.push({ item, name: uniqueName(item.alias || defaultName(e), taken), value: aggExpr(e, base) });
    }
    const sort = planSort(q, outputs, base);
    let shape = null;
    if (!star) {
      shape = { $project: Object.fromEntries(outputs.map((o) => [o.name, o.value])) };
      if (!withId) shape.$project._id = 0;
    } else {
      const computed = outputs.filter((o) => !o.plain);
      if (computed.length) shape = { $addFields: Object.fromEntries(computed.map((o) => [o.name, o.value])) };
    }
    finish(pipeline, shape, sort, q);
  }

  function accumulator(node, base) {
    const arg = node.args[0];
    if (node.name === 'COUNT') {
      if (node.distinct) return { $addToSet: aggExpr(arg, base) };
      if (isCountAll(node)) return { $sum: 1 };
      return { $sum: { $cond: [{ $eq: [{ $ifNull: [aggExpr(arg, base), null] }, null] }, 0, 1] } };
    }
    if (node.distinct) fail(`${node.name}(DISTINCT ...) is not supported`);
    if (node.star || node.args.length !== 1) fail(`${node.name}() takes exactly one argument`);
    return { [AGGREGATES[node.name]]: aggExpr(arg, base) };
  }

  function groupStages(q, scope, base, pipeline, notes) {
    if (q.columns.some((c) => c.star)) fail('SELECT * cannot be combined with GROUP BY, DISTINCT or aggregate functions');
    const canon = scope.canon;
    const keyNodes = (q.groupBy.length ? q.groupBy : q.distinct ? q.columns.map((c) => c.expr) : [])
      .map((k) => { const t = selectTarget(q, k); return t ? t.expr : k; });

    const keyTaken = new Set();
    const keys = keyNodes.map((node) => {
      if (containsAgg(node)) fail('Aggregate functions are not allowed in GROUP BY');
      return { canon: canon(node), name: uniqueName(defaultName(node), keyTaken), value: aggExpr(node, base) };
    });
    keys.forEach((k) => { k.path = keys.length === 1 ? '_id' : '_id.' + k.name; });
    const group = { _id: keys.length === 0 ? null : keys.length === 1 ? keys[0].value : Object.fromEntries(keys.map((k) => [k.name, k.value])) };

    const aggs = new Map();
    const fieldTaken = new Set(['_id']);
    const register = (node, preferred) => {
      const c = canon(node);
      if (!aggs.has(c)) {
        const field = uniqueName(preferred || defaultName(node), fieldTaken);
        aggs.set(c, field);
        group[field] = accumulator(node, base);
      }
      return aggs.get(c);
    };
    const isCountDistinct = (n) => n.name === 'COUNT' && n.distinct;
    const gctx = {
      scope,
      notes,
      fieldOf(node) {
        const key = keys.find((k) => k.canon === canon(node));
        if (key) return key.path;
        if (isAgg(node)) return isCountDistinct(node) ? null : register(node);
        if (node.type === 'col') fail(`Column "${node.parts.join('.')}" must appear in GROUP BY or be inside an aggregate function`);
        return null;
      },
      aggRef(node) { return { $size: '$' + register(node) }; }, // only reached for COUNT(DISTINCT ...)
    };

    // Register select-list aggregates first so their aliases become the field names.
    for (const c of q.columns) if (isAgg(c.expr)) register(c.expr, c.alias);
    const outTaken = new Set(['_id']);
    const outputs = q.columns.map((item) => {
      const key = keys.find((k) => k.canon === canon(item.expr));
      const preferred = item.alias || (key ? key.name : isAgg(item.expr) ? aggs.get(canon(item.expr)) : defaultName(item.expr));
      return { item, name: uniqueName(preferred, outTaken), value: aggExpr(item.expr, gctx) };
    });

    const having = q.having ? toFilter(q.having, gctx) : null;
    const sort = planSort(q, outputs, gctx);

    pipeline.push({ $group: group });
    notes.push(keys.length
      ? 'GROUP BY → $group; the grouping columns become _id and each aggregate becomes an accumulator ($sum, $avg...).'
      : 'Aggregates without GROUP BY → $group with _id: null (one group for all documents).');
    if (having) {
      pipeline.push({ $match: having });
      notes.push('HAVING → $match placed after $group.');
    }
    const project = { _id: 0 };
    for (const o of outputs) project[o.name] = o.value === '$' + o.name ? 1 : o.value;
    finish(pipeline, { $project: project }, sort, q);
  }

  // ---------------------------------------------------------------- INSERT / UPDATE / DELETE

  function translateInsert(q, notes) {
    if (!q.columns) fail('INSERT needs a column list, e.g. INSERT INTO users (name, age) VALUES (...) — documents need field names');
    const docs = q.rows.map((row) => {
      if (row.length !== q.columns.length) fail(`Expected ${q.columns.length} values per row but got ${row.length}`);
      const doc = {};
      q.columns.forEach((c, i) => {
        const v = literal(row[i]);
        if (v === NO) fail('Only literal values are supported in INSERT ... VALUES');
        doc[c] = v;
      });
      return doc;
    });
    notes.push('Each row becomes a document; MongoDB adds an _id automatically if you don\'t provide one.');
    const coll = collection(q.table);
    return docs.length === 1 ? `${coll}.insertOne(${fmt(docs[0])})` : `${coll}.insertMany(${fmt(docs)})`;
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

  function translateUpdate(q, notes) {
    const scope = makeScope(q.table, []);
    const base = baseContext(scope, notes);
    const filter = where(q, base);
    const ops = {};
    let needsPipeline = false;
    for (const { column, value } of q.sets) {
      const f = scope.path(column);
      const v = literal(value);
      const step = v === NO ? selfArithmetic(value, f, scope) : null;
      if (v !== NO) (ops.$set = ops.$set || {})[f] = v;
      else if (step) (ops[step.op] = ops[step.op] || {})[f] = step.n;
      else needsPipeline = true;
    }
    let update = ops;
    if (needsPipeline) {
      update = [{ $set: Object.fromEntries(q.sets.map(({ column, value }) => [scope.path(column), aggExpr(value, base)])) }];
      notes.push('SET with expressions → an update pipeline ([{ $set: ... }]) so values can reference other fields.');
    } else {
      if (ops.$set) notes.push('SET column = value → $set.');
      if (ops.$inc) notes.push('SET column = column + n → $inc.');
    }
    const method = q.limit === 1 ? 'updateOne' : 'updateMany';
    notes.push(method === 'updateMany' ? 'SQL UPDATE changes every matching row → updateMany().' : 'LIMIT 1 → updateOne() (changes only the first match).');
    if (!q.where) notes.push('No WHERE clause: every document is updated.');
    return `${collection(q.table.name)}.${method}(${fmt(filter)}, ${fmt(update)})`;
  }

  function translateDelete(q, notes) {
    const base = baseContext(makeScope(q.table, []), notes);
    const filter = where(q, base);
    if (!q.where) notes.push('No WHERE clause: every document is deleted.');
    const method = q.limit === 1 ? 'deleteOne' : 'deleteMany';
    notes.push(`DELETE → ${method}(filter).`);
    return `${collection(q.table.name)}.${method}(${fmt(filter)})`;
  }

  // ---------------------------------------------------------------- entry point

  function translateStatement(stmt, notes) {
    switch (stmt.type) {
      case 'select': return translateSelect(stmt, notes);
      case 'insert': return translateInsert(stmt, notes);
      case 'update': return translateUpdate(stmt, notes);
      case 'delete': return translateDelete(stmt, notes);
    }
  }

  function translate(src) {
    const stmts = new Parser(tokenize(src)).parseAll();
    if (!stmts.length) fail('Nothing to translate');
    const notes = [];
    const output = stmts.map((s) => translateStatement(s, notes)).join('\n\n');
    return { output, notes: [...new Set(notes)] };
  }

  return { translate, TranslateError };
});
