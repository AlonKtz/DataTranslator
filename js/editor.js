// Code editor for the input pane: syntax highlighting drawn under a transparent textarea,
// plus optional light completion (closing brackets/quotes, auto-indent, finishing the word being typed).
(function () {
  'use strict';

  const SQL_KEYWORDS = (
    'SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN INNER LEFT RIGHT CROSS OUTER FULL ON USING AS ' +
    'AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS DISTINCT UNION ALL ANY INSERT INTO VALUES UPDATE SET DELETE ' +
    'CREATE TABLE INDEX VIEW DROP ALTER ADD COLUMN RENAME TO PRIMARY KEY UNIQUE CHECK DEFAULT REFERENCES ' +
    'WITH CASE WHEN THEN ELSE END ASC DESC OVER PARTITION ROWS RANGE PRECEDING FOLLOWING UNBOUNDED CURRENT ROW ' +
    'RETURNING CONFLICT DO NOTHING MERGE MATCHED LATERAL TRUE FALSE INTERVAL BEGIN COMMIT ROLLBACK TRANSACTION ' +
    'EXPLAIN TRUNCATE SHOW TABLES USE FETCH FIRST NEXT ONLY TOP REGEXP AGAINST MATCH ORDINALITY EXCLUDED ' +
    'SERIAL INT INTEGER BIGINT SMALLINT VARCHAR CHAR TEXT BOOLEAN TIMESTAMP DATE NUMERIC DECIMAL FLOAT REAL ARRAY JSONB'
  ).split(' ');
  const SQL_FUNCTIONS = (
    'COUNT SUM AVG MIN MAX COALESCE NULLIF CAST EXTRACT DATE_TRUNC NOW UPPER LOWER LENGTH SUBSTRING TRIM CONCAT ' +
    'ROUND ABS CEIL FLOOR ROW_NUMBER RANK DENSE_RANK LAG LEAD STRING_AGG ARRAY_AGG GROUP_CONCAT CARDINALITY ' +
    'GREATEST LEAST TO_CHAR REPLACE POSITION ARRAY_APPEND ARRAY_REMOVE RANDOM UNNEST REGEXP_LIKE TO_TSVECTOR PLAINTO_TSQUERY'
  ).split(' ');
  const MONGO_METHODS = (
    'find findOne aggregate countDocuments distinct insertOne insertMany updateOne updateMany replaceOne ' +
    'deleteOne deleteMany findOneAndUpdate findOneAndDelete findOneAndReplace bulkWrite createIndex dropIndex ' +
    'drop createCollection createView renameCollection sort limit skip project explain getCollection ' +
    'startSession startTransaction commitTransaction abortTransaction endSession'
  ).split(' ');
  const MONGO_OPERATORS = (
    '$match $group $project $sort $limit $skip $lookup $unwind $addFields $set $unset $count $facet $bucket ' +
    '$sortByCount $sample $unionWith $out $merge $replaceRoot $replaceWith $setWindowFields ' +
    '$eq $ne $gt $gte $lt $lte $in $nin $and $or $nor $not $exists $type $regex $options $elemMatch $size $all ' +
    '$text $search $expr $inc $mul $min $max $rename $push $addToSet $pull $pop $each $setOnInsert $currentDate ' +
    '$sum $avg $first $last $concat $cond $ifNull $switch $toUpper $toLower $substrCP $round $dateTrunc ' +
    '$year $month $dayOfMonth $dateToString $map $filter $reduce $arrayElemAt $toInt $toString $toDouble ' +
    '$dateAdd $dateSubtract $multiply $divide $add $subtract'
  ).split(' ');
  const MONGO_GLOBALS = 'db use show const let var new true false null ISODate ObjectId NumberDecimal NumberLong session'.split(' ');

  const SQL_KW_SET = new Set(SQL_KEYWORDS);
  const SQL_FN_SET = new Set(SQL_FUNCTIONS);
  const MONGO_KW_SET = new Set(['db', 'use', 'show', 'const', 'let', 'var', 'new', 'true', 'false', 'null']);

  const PAIRS = { '(': ')', '[': ']', '{': '}', "'": "'", '"': '"', '`': '`' };
  const CLOSERS = new Set([')', ']', '}']);

  const TOKEN = /(--[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^'\\]|\\[\s\S]|'')*'?|"(?:[^"\\]|\\[\s\S])*"?|`(?:[^`\\]|\\[\s\S])*`?)|(\b\d+(?:\.\d+)?\b)|(\$\$?[A-Za-z_][\w.]*)|([A-Za-z_]\w*)/g;

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, text) => `<span class="tok-${cls}">${escapeHtml(text)}</span>`;

  function wordClass(src, word, start, end, lang) {
    const after = src.slice(end).match(/^\s*(.)?/)[1];
    if (lang === 'sql') {
      const up = word.toUpperCase();
      if (SQL_FN_SET.has(up) && after === '(') return 'fn';
      if (SQL_KW_SET.has(up)) return 'kw';
      return after === '(' ? 'fn' : null;
    }
    if (MONGO_KW_SET.has(word)) return 'kw';
    if (after === '(') return 'fn';
    if (after === ':') return 'key';
    return null;
  }

  // Returns HTML for `src` with tokens wrapped in <span class="tok-*">.
  function highlight(src, lang) {
    let html = '', last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src))) {
      html += escapeHtml(src.slice(last, m.index));
      const [text, comment, str, num, op, word] = m;
      if (comment && (lang === 'sql' ? !text.startsWith('//') : !text.startsWith('--'))) html += span('com', text);
      else if (comment) html += escapeHtml(text);
      else if (str) html += span(lang === 'mongo' && /^\s*:/.test(src.slice(m.index + text.length)) ? 'key' : 'str', text);
      else if (num) html += span('num', text);
      else if (op) html += span('op', text);
      else {
        const cls = wordClass(src, word, m.index, m.index + text.length, lang);
        html += cls ? span(cls, text) : escapeHtml(text);
      }
      last = m.index + text.length;
    }
    return html + escapeHtml(src.slice(last));
  }

  // The rest of the word being typed, or '' when there's nothing worth suggesting.
  function completionFor(before, lang) {
    const m = before.match(/(\$?[A-Za-z_]\w*)$/);
    if (!m || m[1].length < 2) return '';
    const prefix = m[1];
    const prev = before.charAt(before.length - prefix.length - 1);
    let words, caseless = false;
    if (lang === 'mongo') {
      if (prefix.startsWith('$')) words = MONGO_OPERATORS;
      else if (prev === '.') words = MONGO_METHODS;
      else words = MONGO_GLOBALS;
    } else {
      if (prefix.startsWith('$') || prev === '.') return '';
      words = SQL_KEYWORDS.concat(SQL_FUNCTIONS);
      caseless = true;
    }
    const norm = (w) => (caseless ? w.toUpperCase() : w);
    const p = norm(prefix);
    if (words.some((w) => norm(w) === p)) return '';
    const best = words.filter((w) => norm(w).startsWith(p)).sort((a, b) => a.length - b.length)[0];
    if (!best) return '';
    const rest = best.slice(prefix.length);
    if (!caseless) return rest;
    return prefix === prefix.toLowerCase() ? rest.toLowerCase() : rest.toUpperCase();
  }

  function attach(textarea, opts) {
    const getLang = opts.getLang;
    const wrap = document.createElement('div');
    wrap.className = 'editor';
    const layer = document.createElement('pre');
    layer.className = 'hl';
    layer.setAttribute('aria-hidden', 'true');
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.append(layer, textarea);

    let completion = !!opts.completion;
    let ghost = '';

    function render() {
      const v = textarea.value, lang = getLang();
      if (ghost) {
        const at = textarea.selectionStart;
        layer.innerHTML = highlight(v.slice(0, at), lang) + `<span class="ghost">${escapeHtml(ghost)}</span>` +
          highlight(v.slice(at), lang) + '\n ';
      } else {
        layer.innerHTML = highlight(v, lang) + '\n ';
      }
      syncScroll();
    }
    function syncScroll() {
      layer.scrollTop = textarea.scrollTop;
      layer.scrollLeft = textarea.scrollLeft;
    }
    function updateGhost() {
      const at = textarea.selectionStart;
      const atWordEnd = textarea.selectionEnd === at && !/\w/.test(textarea.value.charAt(at));
      ghost = completion && atWordEnd ? completionFor(textarea.value.slice(0, at), getLang()) : '';
    }
    function clearGhost() {
      if (!ghost) return;
      ghost = '';
      render();
    }

    // execCommand keeps the browser's undo history; setRangeText is the fallback.
    function insert(text) {
      if (!document.execCommand('insertText', false, text)) {
        textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input'));
      }
    }
    function moveCaret(by) {
      const at = textarea.selectionStart + by;
      textarea.setSelectionRange(at, at);
    }

    textarea.addEventListener('input', () => { updateGhost(); render(); });
    textarea.addEventListener('scroll', syncScroll);
    textarea.addEventListener('blur', clearGhost);
    textarea.addEventListener('mousedown', clearGhost);

    textarea.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const { selectionStart: start, selectionEnd: end, value } = textarea;
      const prev = value.charAt(start - 1), next = value.charAt(end);

      if (ghost && (e.key === 'Tab' || e.key === 'ArrowRight') && !e.shiftKey) {
        e.preventDefault();
        const text = ghost;
        ghost = '';
        insert(text);
        return;
      }
      if (e.key === 'Escape' && ghost) { e.preventDefault(); clearGhost(); return; }
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') { clearGhost(); return; }

      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); insert('  '); return; }
      if (!completion) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const indent = value.slice(value.lastIndexOf('\n', start - 1) + 1, start).match(/^[ \t]*/)[0];
        if (PAIRS[prev] && PAIRS[prev] === next && CLOSERS.has(next)) {
          insert('\n' + indent + '  ' + '\n' + indent);
          moveCaret(-(indent.length + 1));
        } else {
          insert('\n' + indent + (/[([{]$/.test(prev) ? '  ' : ''));
        }
        return;
      }
      if (e.key === 'Backspace' && start === end && PAIRS[prev] && PAIRS[prev] === next) {
        e.preventDefault();
        textarea.setSelectionRange(start - 1, start + 1);
        insert('');
        return;
      }
      if (start !== end || e.key.length !== 1) return;
      // Typing a closer that's already there just steps over it.
      if ((CLOSERS.has(e.key) || e.key in PAIRS && PAIRS[e.key] === e.key) && next === e.key) {
        e.preventDefault();
        moveCaret(1);
        clearGhost();
        return;
      }
      if (e.key in PAIRS) {
        const isQuote = PAIRS[e.key] === e.key;
        const nextFree = next === '' || /[\s)\]},;:]/.test(next);
        if (!nextFree || (isQuote && /\w/.test(prev))) return;
        e.preventDefault();
        insert(e.key + PAIRS[e.key]);
        moveCaret(-1);
      }
    });

    render();
    return {
      refresh() { ghost = ''; render(); },
      setCompletion(on) { completion = on; ghost = ''; render(); },
    };
  }

  window.Editor = { highlight, attach, completionFor };
})();
