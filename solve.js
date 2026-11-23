// makefun-site 1.0.0 compatible static-site builder, written from scratch.
// run(input) returns exactly what the reference build() returns: a JSON
// object mapping every output path to its file text, byte for byte.
// Optimised for CPU time: single-pass parsers, run-based inline rendering
// (plain text is sliced verbatim instead of escaped char by char), cached
// slugification, and memoised renders of templates that only depend on the
// build-constant site/tags/recent values.

// ---------------------------------------------------------------- text ----

const ESCAPE_TABLE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

function escapeHtml(s) {
  // Fast path: most strings contain no escapable char at all.
  if (!ESCAPE_TEST.test(s)) return s;
  return s.replace(ESCAPE_RE, (c) => ESCAPE_TABLE[c]);
}

const slugCache = new Map();

function slugify(s) {
  const cached = slugCache.get(s);
  if (cached !== undefined) return cached;
  let out = '';
  let i = 0;
  const n = s.length;
  // ASCII fast path: no normalisation or mark removal needed.
  let ascii = true;
  for (let j = 0; j < n; j++) { if (s.charCodeAt(j) > 127) { ascii = false; break; } }
  if (ascii) {
    let pendingDash = false;
    for (; i < n; i++) {
      const c = s.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        if (pendingDash && out !== '') out += '-';
        pendingDash = false;
        out += s[i];
      } else if (c >= 65 && c <= 90) {
        if (pendingDash && out !== '') out += '-';
        pendingDash = false;
        out += s[i].toLowerCase();
      } else {
        pendingDash = true;
      }
    }
  } else {
    const norm = s.normalize('NFKD').replace(/\p{M}/gu, '');
    const m = norm.length;
    let pendingDash = false;
    for (let j = 0; j < m; j++) {
      const c = norm.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        if (pendingDash && out !== '') out += '-';
        pendingDash = false;
        out += norm[j];
      } else if (c >= 65 && c <= 90) {
        if (pendingDash && out !== '') out += '-';
        pendingDash = false;
        out += norm[j].toLowerCase();
      } else {
        pendingDash = true;
      }
    }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63); // trailing '-' at the cut
  }
  if (out === '') out = 'untitled';
  slugCache.set(s, out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function longDate(d) {
  // d is a validated 'YYYY-MM-DD' string.
  const day = (d.charCodeAt(8) - 48) * 10 + (d.charCodeAt(9) - 48);
  const month = (d.charCodeAt(5) - 48) * 10 + (d.charCodeAt(6) - 48);
  return `${day} ${MONTHS[month - 1]} ${d.slice(0, 4)}`;
}

// Exact JavaScript \s semantics: the whitespace code points \s matches.
function isWsCode(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
    c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F ||
    c === 0x3000 || c === 0xFEFF;
}

function wordsOf(s) {
  // Count runs of non-whitespace, exactly like s.match(/\S+/g).length.
  // ASCII fast path inside the loop: for ASCII the whitespace set is just
  // 9-13 and 32; only non-ASCII chars take the full \s test.
  let count = 0;
  let inWord = false;
  for (let i = 0, n = s.length; i < n; i++) {
    const c = s.charCodeAt(i);
    const ws = c <= 32 ? (c === 32 || (c >= 9 && c <= 13)) : (c > 127 ? isWsCode(c) : false);
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let k = 2;
  while (taken.has(`${slug}-${k}`)) k++;
  const out = `${slug}-${k}`;
  taken.add(out);
  return out;
}

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------- front matter ----

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isDigit(c) { return c >= 48 && c <= 57; }

function parseStringValue(raw) {
  // Returns {value} or {error} with the reference's exact reason text.
  if (raw.charCodeAt(0) === 34) { // '"'
    const n = raw.length;
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let run = 1;
    for (let i = 1; i < n - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) { // backslash
        if (i + 1 === n - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        const e = raw.charCodeAt(i + 1);
        if (e !== 34 && e !== 92) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        if (i > run) out += raw.slice(run, i);
        out += raw[i + 1];
        i++;
        run = i + 1;
      } else if (c === 34) {
        return { error: 'a quoted string holds a stray quote' };
      }
    }
    if (run < n - 1) out += raw.slice(run, n - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function parseDateValue(raw) {
  if (raw.length !== 10) return null;
  const y = raw.slice(0, 4), m = raw.slice(5, 7), d = raw.slice(8, 10);
  if (raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return null;
  for (let i = 0; i < 4; i++) if (!isDigit(y.charCodeAt(i))) return null;
  for (let i = 0; i < 2; i++) if (!isDigit(m.charCodeAt(i)) || !isDigit(d.charCodeAt(i))) return null;
  const year = (y.charCodeAt(0) - 48) * 1000 + (y.charCodeAt(1) - 48) * 100 +
    (y.charCodeAt(2) - 48) * 10 + (y.charCodeAt(3) - 48);
  const month = (m.charCodeAt(0) - 48) * 10 + (m.charCodeAt(1) - 48);
  const day = (d.charCodeAt(0) - 48) * 10 + (d.charCodeAt(1) - 48);
  if (year < 1970 || year > 2099 || month < 1 || month > 12 || day < 1) return null;
  let maxDay = DAYS_IN[month - 1];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) maxDay = 29;
  if (day > maxDay) return null;
  return raw;
}

function parseTagsValue(raw) {
  const n = raw.length;
  if (n < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return null;
  const inner = raw.slice(1, n - 1).trim();
  if (inner === '') return [];
  const parts = raw.slice(1, n - 1).split(',');
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return null;
    out.push(t);
  }
  return out;
}

function parseLayoutValue(raw) {
  if (raw === '') return null;
  for (let i = 0, n = raw.length; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return raw;
}

function parseSlugValue(raw) {
  const n = raw.length;
  if (n === 0 || n > 64) return null;
  // [a-z0-9]+(-[a-z0-9]+)* : no leading/trailing '-', no '--', lowercase/digits only.
  let prevDash = true; // start of string behaves like after a dash
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return null;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else {
      return null;
    }
  }
  if (prevDash) return null;
  return raw;
}

// Parse one front-matter line value; returns {ok, value} or {ok:false, reason}
// with the reference's exact reason text (the refusal is `key "<k>": <reason>`).
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = parseStringValue(raw);
      return 'error' in s ? { ok: false, reason: s.error } : { ok: true, value: s.value };
    }
    case 'date':
      return parseDateValue(raw) === null
        ? { ok: false, reason: 'not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' }
        : { ok: true, value: raw };
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { ok: false, reason: 'not a list [a, b]' };
      }
      const v = parseTagsValue(raw);
      return v === null
        ? { ok: false, reason: 'an empty tag, or one holding " [ or ]' }
        : { ok: true, value: v };
    }
    case 'draft':
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'true or false' };
    case 'layout':
      return parseLayoutValue(raw) === null
        ? { ok: false, reason: 'not a template name' }
        : { ok: true, value: raw };
    case 'slug':
      return parseSlugValue(raw) === null
        ? { ok: false, reason: 'not a slug' }
        : { ok: true, value: raw };
    default:
      return { ok: false, reason: 'unknown key' };
  }
}

function parseFrontMatter(text) {
  // Returns {data, body} or {refusal} — mirrors the reference exactly.
  // The opening line must be exactly '---': the text is '---' alone, or
  // opens '---\n'. The body is sliced out, never split and re-joined.
  if (!text.startsWith('---')) return { refusal: 'no front matter' };
  if (text.length > 3 && text.charCodeAt(3) !== 10) return { refusal: 'no front matter' };
  // The closing line: the first line after the opening one that is exactly
  // '---' (a '\n---' followed by '\n' or the end of the text).
  let closeAt = -1; // index of the '\n' just before the closing line
  let closeEnd = -1; // index just past the closing line's '---'
  let p = 3;
  while (true) {
    const nl = text.indexOf('\n---', p);
    if (nl === -1) break;
    const after = nl + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeAt = nl;
      closeEnd = after;
      break;
    }
    p = nl + 1;
  }
  if (closeAt === -1) return { refusal: 'the front matter is not closed' };
  const fmText = closeAt <= 4 ? '' : text.slice(4, closeAt);
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    // Blank (spaces/tabs only) or comment (opens on '#') lines are skipped.
    let q = 0;
    const n = line.length;
    while (q < n && (line.charCodeAt(q) === 32 || line.charCodeAt(q) === 9)) q++;
    if (q === n) continue;
    if (line.charCodeAt(0) === 35) continue; // '#'
    // key: [a-z_]+ then ':' then optionally ' ' + value.
    let k = 0;
    while (k < n) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || k >= n || line.charCodeAt(k) !== 58) {
      return { refusal: `line ${j + 2} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === n) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { refusal: `line ${j + 2} is not "key: value"` };
    // Trailing spaces/tabs are dropped from the value.
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    if (e < raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.has(key)) return { refusal: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { refusal: `key "${key}" is given twice` };
    if (raw === '') return { refusal: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if (!v.ok) return { refusal: `key "${key}": ${v.reason}` };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { refusal: 'no title' };
  return { data, body };
}

// -------------------------------------------------------------- markdown ----

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlankLine(line) {
  for (let i = 0, n = line.length; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

// Fence opener: exactly three backticks, an optional language of
// [A-Za-z0-9_+-]*, then only spaces/tabs. Returns the language or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  if (line.charCodeAt(3) === 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  if (line.charCodeAt(3) === 96) return false;
  for (let i = 3, n = line.length; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 '#' + whitespace + non-empty text (trailing spaces/tabs dropped).
function headingOf(line) {
  let depth = 0;
  while (depth < 7 && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  const n = line.length;
  let i = depth;
  const c0 = line.charCodeAt(i);
  if (c0 !== 32 && c0 !== 9) return null;
  while (i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let e = n;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth, text: line.slice(i, e) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false; // '-' or '*'
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3, n = line.length; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// List marker: '- ' / '* ' bullet, or 1-9 digits + '. ' ordered.
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 0, content: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 1;
    while (i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    // i is now the digit count (1-9) unless a 10th digit follows.
    if (line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) return null;
    if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), content: line.slice(i + 2) };
    }
  }
  return null;
}

// Continuation line: two or more spaces, then a non-whitespace char.
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  const n = line.length;
  while (i < n && line.charCodeAt(i) === 32) i++;
  return i < n && !isWsCode(line.charCodeAt(i));
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// Find `what` at or after `from` (before `to`), skipping escape pairs,
// exactly like the reference's findUnescaped.
function findUnescaped(s, what, from, to) {
  const w = what.length;
  for (let j = from; j + w <= to; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// Find a lone '*' (not beside another '*') at or after `from`, skipping
// escape pairs, exactly like the reference's findSingleStar.
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c === 42) {
      if (j + 1 < to && s.charCodeAt(j + 1) === 42) { j++; continue; }
      return j;
    }
  }
  return -1;
}

function hasWhitespace(s) {
  for (let i = 0, n = s.length; i < n; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

// Render inline markup of s[a..b) into `out`. Plain runs are sliced
// verbatim (they contain no HTML-special char by construction); only the
// special chars are handled one by one. lctx is the per-build link context;
// resolveLink is called exactly when the reference calls env.link.
function inlineTo(s, a, b, lctx, out) {
  let i = a;
  let run = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out.push(s.slice(run, i));
        const next = s[i + 1];
        out.push(next === '>' ? '&gt;' : next);
        i += 2;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) { // backtick: code span
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) { // '*': strong or emphasis
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineTo(s, i + 2, j, lctx, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, b);
        if (j !== -1 && j > i + 1) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<em>');
          inlineTo(s, i + 1, j, lctx, out);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === 91) { // '[': link
      const k = findUnescaped(s, ']', i + 1, b);
      let target = '';
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m !== -1 && m < b) target = s.slice(k + 2, m);
        else m = -1;
      }
      if (m !== -1 && target !== '' && !hasWhitespace(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="', escapeHtml(resolveLink(lctx, target)), '">');
        inlineTo(s, i + 1, k, lctx, out);
        out.push('</a>');
        i = m + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 38) { // '&'
      if (i > run) out.push(s.slice(run, i));
      out.push('&amp;');
      i++;
      run = i;
      continue;
    }
    if (c === 60) { // '<'
      if (i > run) out.push(s.slice(run, i));
      out.push('&lt;');
      i++;
      run = i;
      continue;
    }
    if (c === 62) { // '>'
      if (i > run) out.push(s.slice(run, i));
      out.push('&gt;');
      i++;
      run = i;
      continue;
    }
    if (c === 34) { // '"'
      if (i > run) out.push(s.slice(run, i));
      out.push('&quot;');
      i++;
      run = i;
      continue;
    }
    if (c === 39) { // "'"
      if (i > run) out.push(s.slice(run, i));
      out.push('&#39;');
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (run < b) out.push(s.slice(run, b));
}

function inlineStr(s, lctx) {
  const out = [];
  inlineTo(s, 0, s.length, lctx, out);
  return out.join('');
}

// Render a Markdown body. Returns {html, toc, excerpt} where excerpt is the
// first paragraph's inner HTML (or '' when there is none).
function renderMarkdown(src, lctx) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = '';
  let haveExcerpt = false;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', escapeHtml(lang), '"');
      out.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        out.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      if (i < n) i++; // closing fence
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      i++;
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inlineStr(h.text, lctx);
      out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      continue;
    }
    if (isHr(line)) {
      i++;
      out.push('<hr>\n');
      continue;
    }
    if (line.charCodeAt(0) === 62) { // blockquote
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let rest = lines[i].charCodeAt(1) === 32 ? lines[i].slice(2) : lines[i].slice(1);
        rest = trimLine(rest);
        if (rest !== '') parts.push(rest);
        i++;
      }
      if (parts.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        out.push('<blockquote>\n<p>', inlineStr(parts.join('\n'), lctx), '</p>\n</blockquote>\n');
      }
      continue;
    }
    const marker = listMarker(line);
    if (marker !== null) {
      const ordered = marker.ordered;
      const items = [[trimLine(marker.content)]];
      const start = marker.start;
      i++;
      while (i < n) {
        const m = listMarker(lines[i]);
        if (m !== null && m.ordered === ordered) {
          items.push([trimLine(m.content)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      if (ordered && start !== 1) out.push(`<${tag} start="${start}">\n`);
      else out.push(`<${tag}>\n`);
      for (const item of items) {
        out.push('<li>', inlineStr(item.join('\n'), lctx), '</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: this line plus following lines up to a terminator.
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const text = parts.join('\n');
    if (!haveExcerpt) {
      excerpt = inlineStr(text, lctx);
      haveExcerpt = true;
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineTo(text, 0, text.length, lctx, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// -------------------------------------------------------------- templates ----

class TemplateError extends Error {
  constructor(name, reason) {
    super(`template "${name}": ${reason}`);
    this.name = 'TemplateError';
  }
}

function isPathStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isPathChar(c) {
  return isPathStart(c) || (c >= 48 && c <= 57);
}

// A path is names joined by '.', each [A-Za-z_][A-Za-z0-9_]*.
function isValidPath(s) {
  const n = s.length;
  if (n === 0) return false;
  let i = 0;
  while (true) {
    if (!isPathStart(s.charCodeAt(i))) return false;
    i++;
    while (i < n && isPathChar(s.charCodeAt(i))) i++;
    if (i === n) return true;
    if (s.charCodeAt(i) !== 46) return false; // '.'
    i++;
    if (i === n) return false;
  }
}

function isAllSpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(src, name) {
  const tokens = [];
  let i = 0;
  let text = '';
  const n = src.length;
  while (i < n) {
    const openVar = src.indexOf('{{', i);
    const openTag = src.indexOf('{%', i);
    let next = -1;
    let isVar = false;
    if (openVar !== -1 && (openTag === -1 || openVar < openTag)) { next = openVar; isVar = true; }
    else if (openTag !== -1) { next = openTag; }
    if (next === -1) { text += src.slice(i); break; }
    text += src.slice(i, next);
    if (isVar) {
      const raw = src.startsWith('{{{', next);
      const closeLen = raw ? 3 : 2;
      const close = src.indexOf(raw ? '}}}' : '}}', next + closeLen);
      if (close === -1) throw new TemplateError(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      const pathText = src.slice(next + closeLen, close).trim();
      if (!isValidPath(pathText)) throw new TemplateError(name, `${JSON.stringify(pathText)} is not a path`);
      if (text !== '') tokens.push({ type: 'text', value: text });
      text = '';
      tokens.push({ type: raw ? 'raw' : 'var', path: pathText.split('.') });
      i = close + closeLen;
    } else {
      const close = src.indexOf('%}', next + 2);
      if (close === -1) throw new TemplateError(name, 'a {% is not closed');
      const end = close + 2;
      const lineStart = src.lastIndexOf('\n', next - 1) + 1;
      const lineEnd = src.indexOf('\n', end);
      const lineEndPos = lineEnd === -1 ? n : lineEnd;
      const standalone = isAllSpaceTab(src, lineStart, next) && isAllSpaceTab(src, end, lineEndPos);
      if (standalone) {
        text = text.slice(0, text.length - (next - lineStart));
      }
      if (text !== '') tokens.push({ type: 'text', value: text });
      text = '';
      tokens.push({ type: 'tag', value: src.slice(next + 2, close).trim() });
      i = standalone ? (lineEnd === -1 ? n : lineEnd + 1) : end;
    }
  }
  if (text !== '') tokens.push({ type: 'text', value: text });
  return tokens;
}

// Parse a tag's for/if/include form. Returns a descriptor or null.
// The for/if path is one non-whitespace token (\S+); anything else is not
// a for/if tag at all (it falls through to "not a tag"). An include name is
// [a-z0-9-]+.
function parseForTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const n = tag.length;
  if (!isPathStart(tag.charCodeAt(i))) return null;
  const start = i;
  i++;
  while (i < n && isPathChar(tag.charCodeAt(i))) i++;
  const name = tag.slice(start, i);
  if (!tag.startsWith(' in ', i)) return null;
  const pathText = tag.slice(i + 4);
  if (pathText === '' || hasWhitespace(pathText)) return null;
  return { name, pathText };
}

function parseIfTag(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) { not = true; rest = rest.slice(4); }
  if (rest === '' || hasWhitespace(rest)) return null;
  return { not, pathText: rest };
}

function parseIncludeTag(tag) {
  if (!tag.startsWith('include "') || tag.length < 11) return null;
  if (tag.charCodeAt(tag.length - 1) !== 34) return null;
  const inner = tag.slice(9, -1);
  if (inner === '') return null;
  for (let i = 0, n = inner.length; i < n; i++) {
    const c = inner.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return inner;
}

function parseTemplate(name, src) {
  const tokens = tokenize(src, name);
  const root = [];
  let body = root;
  const stack = [];
  const parentBody = () => {
    if (stack.length === 0) return root;
    const p = stack[stack.length - 1];
    return p.type === 'for' ? p.body : (p.else !== null ? p.else : p.then);
  };
  for (const t of tokens) {
    if (t.type === 'text') { body.push({ type: 'text', value: t.value }); continue; }
    if (t.type === 'var') { body.push({ type: 'var', path: t.path }); continue; }
    if (t.type === 'raw') { body.push({ type: 'raw', path: t.path }); continue; }
    const tag = t.value;
    const f = parseForTag(tag);
    if (f !== null) {
      if (!isValidPath(f.pathText)) throw new TemplateError(name, `${JSON.stringify(f.pathText)} is not a path`);
      const node = { type: 'for', name: f.name, path: f.pathText.split('.'), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
      continue;
    }
    if (tag === 'endfor') {
      if (stack.length === 0 || stack[stack.length - 1].type !== 'for') {
        throw new TemplateError(name, 'an endfor with no open for');
      }
      stack.pop();
      body = parentBody();
      continue;
    }
    const cond = parseIfTag(tag);
    if (cond !== null) {
      if (!isValidPath(cond.pathText)) throw new TemplateError(name, `${JSON.stringify(cond.pathText)} is not a path`);
      const node = { type: 'if', not: cond.not, path: cond.pathText.split('.'), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
      continue;
    }
    if (tag === 'else') {
      if (stack.length === 0 || stack[stack.length - 1].type !== 'if' || stack[stack.length - 1].else !== null) {
        throw new TemplateError(name, 'an else outside an if');
      }
      const node = stack[stack.length - 1];
      node.else = [];
      body = node.else;
      continue;
    }
    if (tag === 'endif') {
      if (stack.length === 0 || stack[stack.length - 1].type !== 'if') {
        throw new TemplateError(name, 'an endif with no open if');
      }
      stack.pop();
      body = parentBody();
      continue;
    }
    const inc = parseIncludeTag(tag);
    if (inc !== null) { body.push({ type: 'include', name: inc }); continue; }
    throw new TemplateError(name, `{% ${tag} %} is not a tag`);
  }
  if (stack.length > 0) {
    throw new TemplateError(name, `a ${stack[stack.length - 1].type} is not closed`);
  }
  return root;
}

function lookup(scope, path) {
  let value;
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, path[0])) { value = s.vars[path[0]]; break; }
    s = s.parent;
  }
  if (value === undefined) return undefined;
  for (let i = 1; i < path.length; i++) {
    if (value === null || typeof value !== 'object') return undefined;
    value = Object.hasOwn(value, path[i]) ? value[path[i]] : undefined;
    if (value === undefined) return undefined;
  }
  return value;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---- constant-template analysis ------------------------------------------
// A template is constant when its render depends only on site/tags/recent
// (the same for every render in a build): every free root name is one of
// those three, no loop variable shadows one of them, and every template it
// includes is constant too. Constant renders are memoised per (name, depth).

const CONSTANT_ROOTS = new Set(['site', 'tags', 'recent']);

function analyzeNodes(nodes, bound, roots, loopVars, includes) {
  for (const node of nodes) {
    if (node.type === 'var' || node.type === 'raw' || node.type === 'if') {
      if (!bound.has(node.path[0])) roots.add(node.path[0]);
      if (node.type === 'if') {
        analyzeNodes(node.then, bound, roots, loopVars, includes);
        if (node.else !== null) analyzeNodes(node.else, bound, roots, loopVars, includes);
      }
    } else if (node.type === 'for') {
      if (!bound.has(node.path[0])) roots.add(node.path[0]);
      loopVars.add(node.name);
      const inner = new Set(bound);
      inner.add(node.name);
      inner.add('loop');
      analyzeNodes(node.body, inner, roots, loopVars, includes);
    } else if (node.type === 'include') {
      includes.push(node.name);
    }
  }
}

function markConstantTemplates(templates) {
  // Build-level guard: if any loop variable anywhere is named site/tags/
  // recent, a caller's loop could shadow the top-level value for an included
  // template, so memoisation is disabled for the whole build.
  const info = new Map();
  let guardOk = true;
  for (const [name, t] of templates) {
    const roots = new Set();
    const loopVars = new Set();
    const includes = [];
    analyzeNodes(t.nodes, new Set(), roots, loopVars, includes);
    for (const v of loopVars) {
      if (CONSTANT_ROOTS.has(v)) guardOk = false;
    }
    info.set(name, { roots, loopVars, includes });
  }
  if (!guardOk) {
    for (const t of templates.values()) t.constant = false;
    return;
  }
  // Local condition first, then iterate to a fixpoint over includes.
  for (const [name, t] of templates) {
    const inf = info.get(name);
    let ok = true;
    for (const r of inf.roots) {
      if (!CONSTANT_ROOTS.has(r)) { ok = false; break; }
    }
    if (ok) {
      for (const v of inf.loopVars) {
        if (CONSTANT_ROOTS.has(v)) { ok = false; break; }
      }
    }
    t.constant = ok;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, t] of templates) {
      if (!t.constant) continue;
      for (const inc of info.get(name).includes) {
        const it = templates.get(inc);
        if (it === undefined || !it.constant) { t.constant = false; changed = true; break; }
      }
    }
  }
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(node.value);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, node.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 'if': {
        const branch = truthy(lookup(scope, node.path)) !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (Array.isArray(xs)) {
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const vars = {
              [node.name]: xs[k],
              loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len },
            };
            renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t === undefined || depth >= 8) break;
        if (t.constant) {
          const key = `${node.name}\n${depth + 1}`;
          let rendered = ctx.memo.get(key);
          if (rendered === undefined) {
            const tmp = [];
            renderNodes(t.nodes, scope, ctx, depth + 1, tmp);
            rendered = tmp.join('');
            ctx.memo.set(key, rendered);
          }
          out.push(rendered);
        } else {
          renderNodes(t.nodes, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ build ----

const RESERVED_DIRS = ['posts', 'tags', 'page'];

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  const n = target.length;
  while (i < n) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return i < n && target.charCodeAt(i) === 58;
}

// Resolve a link target from a source's directory. lctx is the per-build
// link context ({dir, srcPath} set per source); broken links are recorded
// once per (source, target) in lctx.broken.
function resolveLink(lctx, target) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    return target;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(lctx.dir, rel);
  if (path !== null) {
    const hit = lctx.bySource.get(path);
    if (hit !== undefined) return hit.url + frag;
    if (lctx.staticPaths.has(path)) return `${lctx.base}/${path}${frag}`;
  }
  lctx.broken.add(`broken-link ${lctx.srcPath} -> ${target}`);
  return target;
}

export function run(input) {
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, { nodes: parseTemplate(name, input.templates[name]), constant: false });
    } catch (e) {
      if (e instanceof TemplateError) report.push(e.message);
      else throw e;
    }
  }
  markConstantTemplates(templates);
  const ctx = { templates, memo: new Map() };

  let base = input.site.base_url;
  let be = base.length;
  while (be > 0 && base.charCodeAt(be - 1) === 47) be--;
  base = base.slice(0, be);

  const sorted = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1
        ? f.content
        : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push(f);
    }
  }

  // Front matter and admission checks, in reference order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.refusal !== undefined) {
      report.push(`refused ${s.path}: ${fm.refusal}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && s.data.date === undefined) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const takenIn = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenIn.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenIn.set(dir, taken);
    }
    const slug = s.data.slug ?? slugify(s.data.title);
    s.slug = uniqueSlug(slug, taken);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
  }

  // Markdown.
  const bySource = new Map();
  for (const s of kept) bySource.set(s.path, s);
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const lctx = { dir: '', srcPath: '', bySource, staticPaths, base, broken };
  for (const s of kept) {
    lctx.dir = dirOf(s.path);
    lctx.srcPath = s.path;
    const md = renderMarkdown(s.body, lctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, ties by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((a, b) => {
    if (a.data.date !== b.data.date) return a.data.date > b.data.date ? -1 : 1;
    return byCodeUnits(a.slug, b.slug);
  });
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const tags = [];
  const byTagSlug = new Map();
  for (const p of posts) {
    const seen = new Set();
    p.tagRefs = [];
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = byTagSlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        byTagSlug.set(slug, tag);
        tags.push(tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  tags.sort((a, b) => (b.posts.length - a.posts.length) || byCodeUnits(a.slug, b.slug));
  for (const s of kept) {
    if (s.post) continue;
    // A page's tags are deduped by slug too (ownTags), then linked to the
    // posts' tag of the same slug, or to nothing (url '') where no post has it.
    const seen = new Set();
    s.tagRefs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = byTagSlug.get(slug);
      s.tagRefs.push(tag === undefined ? { name, slug, url: '' } : tag);
    }
  }

  // Cards and pages (a card is computed once per source and reused).
  function cardOf(s) {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  }
  function linkOf(p) {
    if (p === null) return null;
    return {
      title: p.data.title,
      url: p.url,
      date: p.data.date ?? '',
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
    };
  }
  function pageOf(s) {
    const card = cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.post ? linkOf(s.newer) : null,
      older: s.post ? linkOf(s.older) : null,
      is_post: s.post,
    };
  }

  // Layouts.
  const output = {};
  const siteVal = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);

  function render(name, vars) {
    const t = templates.get(name);
    if (t === undefined) return null;
    const scope = { vars: { site: siteVal, tags: allTags, recent, ...vars }, parent: null };
    const out = [];
    renderNodes(t.nodes, scope, ctx, 0, out);
    return out.join('');
  }

  for (const s of kept) {
    const html = render(s.layout, { page: pageOf(s) });
    if (html === null) continue;
    output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map(cardOf),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html === null) continue;
    output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map(cardOf),
      },
    });
    if (html === null) continue;
    output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) {
    output['tags/index.html'] = tagsHtml;
  }
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
    } else {
      output[f.path] = f.content;
    }
  }

  // The report counts kept non-post sources as pages, and ALL statics
  // (shadowed ones included) as static files.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.map((l) => `${l}\n`).join('');
  return output;
}
