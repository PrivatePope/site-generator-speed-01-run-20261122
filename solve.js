// site-generator-speed-01: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns makefun-site 1.0.0's output tree for one case's input,
// byte for byte: every page's index.html, the index and tag pages,
// build-report.txt and each static file. Written from scratch against the
// reference's stated rules (front matter, template dialect, Markdown subset,
// slug rule, report). Dependency-free, no network, no clock, no randomness,
// nothing cached from one case to the next: templates are compiled fresh per
// run() call and all per-run state is built inside run().
//
// Speed comes from: a hand-rolled single-pass Markdown renderer (no token
// arrays, no per-line regexes), templates compiled to plain functions with
// new Function (one render pass, output pushed to an array and joined once),
// and cheap exact helpers (ASCII fast paths, cached slugs, single-pass
// word counting).

// ---------------------------------------------------------------- utilities

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Whether a UTF-16 code unit is JavaScript whitespace (\s, per code unit). */
function isWS(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body's lines: the runs of characters other than whitespace in them all. */
function wordsOfLines(lines) {
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (
        c === 32 ||
        (c >= 9 && c <= 13) ||
        c === 160 ||
        c === 0x1680 ||
        (c >= 0x2000 && c <= 0x200a) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0x202f ||
        c === 0x205f ||
        c === 0x3000 ||
        c === 0xfeff
      )
        inWord = false;
      else if (!inWord) {
        n++;
        inWord = true;
      }
    }
  }
  return n;
}

/** A line of only spaces and tabs (or empty). */
function isBlankST(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs dropped at both ends. */
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (
      !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)
    )
      return false;
  }
  return false;
}

// ---------------------------------------------------------------- text rules

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** The slug of `text` (no cache: callers cache it per run). */
function slugifyCore(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  // NFKD of pure ASCII is the identity and no ASCII character is a
  // combining mark, so the ASCII path skips both passes.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = null;
      if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = plain[i];
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return Number(d) + ' ' + MONTHS[Number(m) - 1] + ' ' + y;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const bad = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: bad };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: bad };
      }
      const y =
        (raw.charCodeAt(0) - 48) * 1000 +
        (raw.charCodeAt(1) - 48) * 100 +
        (raw.charCodeAt(2) - 48) * 10 +
        (raw.charCodeAt(3) - 48);
      const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: bad };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout': {
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45))
          return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let prevDash = true;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
          if (alnum) {
            prevDash = false;
            continue;
          }
          if (c === 45 && !prevDash && i !== raw.length - 1) {
            prevDash = true;
            continue;
          }
          ok = false;
          break;
        }
        if (prevDash) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends.
 */
function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankST(line) || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of [a-z_]+, a colon, one space and the value.
    let j = 0;
    const L = line.length;
    while (j < L) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= L || line.charCodeAt(j) !== 58)
      return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let raw;
    if (j + 1 === L) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    raw = raw.slice(0, e);
    const key = line.slice(0, j);
    if (FM_KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE_ARR = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>'])
  ESCAPABLE_ARR[ch.charCodeAt(0)] = 1;

function isEscapableCode(c) {
  return c < 128 && ESCAPABLE_ARR[c] === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const lim = s.length - what.length;
  for (let j = from; j <= lim; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\[]/g;
const WS_RE = /\s/;

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  const parts = [];
  let i = 0;
  const N = s.length;
  while (i < N) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) {
      parts.push(esc(s.slice(i)));
      break;
    }
    const j = m.index;
    if (j > i) parts.push(esc(s.slice(i, j)));
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash
      if (j + 1 < N && isEscapableCode(s.charCodeAt(j + 1))) {
        parts.push(esc(s[j + 1]));
        i = j + 2;
      } else {
        parts.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      // backtick: a code span closed by the next backtick, at least one character between
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        parts.push('<code>' + esc(s.slice(j + 1, k)) + '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      // star: strong, else emphasis
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          parts.push('<strong>' + inline(s.slice(j + 2, k), link) + '</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          parts.push('<em>' + inline(s.slice(j + 1, k), link) + '</em>');
          i = k + 1;
        } else {
          parts.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // '[': a link, [text](target), else itself
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      parts.push('<a href="' + esc(link(target)) + '">' + inline(s.slice(j + 1, k), link) + '</a>');
      i = mm + 1;
    } else {
      parts.push('[');
      i = j + 1;
    }
  }
  return parts.join('');
}

/** A fence's language, or null when `line` does not open a fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const L = line.length;
  while (j < L) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const langEnd = j;
  while (j < L) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else break;
  }
  if (j !== L) return null;
  return line.slice(3, langEnd);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6 || k >= line.length) return null;
  const c = line.charCodeAt(k);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(k));
  if (text === '') return null;
  return { depth: k, text };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (c0 === 45) {
    if (c1 !== 45 || c2 !== 45) return false;
  } else if (c0 === 42) {
    if (c1 !== 42 || c2 !== 42) return false;
  } else return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlankST(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** A list's first line: { ordered, start, text }, or null. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  let d = 0;
  while (d < line.length && d < 10) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32)
    return { ordered: true, start: Number(line.slice(0, d)), text: line.slice(d + 2) };
  return null;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  return !isWS(line.charCodeAt(s));
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents
 * (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or ""). `link(target)` resolves a link's href; `slugCache` is this run's slug cache.
 */
function renderMD(lines, link, slugCache) {
  const N = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  // One list's blocks, from its first line `first` (already matched); `i` is past that line's start.
  const listBlock = (first) => {
    const isOrdered = first.ordered;
    const items = [[trimST(first.text)]];
    while (i < N) {
      const m = listStart(lines[i]);
      if (m !== null && m.ordered === isOrdered) {
        items.push([trimST(m.text)]);
        i++;
      } else if (isContinued(lines[i])) {
        items[items.length - 1].push(trimST(lines[i]));
        i++;
      } else break;
    }
    const tag = isOrdered ? 'ol' : 'ul';
    const open = isOrdered && first.start !== 1 ? '<ol start="' + first.start + '">' : '<' + tag + '>';
    let html = open + '\n';
    for (let k = 0; k < items.length; k++) html += '<li>' + inline(items[k].join('\n'), link) + '</li>\n';
    html += '</' + tag + '>\n';
    blocks.push(html);
  };
  while (i < N) {
    const line = lines[i];
    // Dispatch on the first character: no block marker can start later in the line.
    if (line.length === 0 || line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) {
      if (isBlankST(line)) {
        i++;
        continue;
      }
    } else {
      const c0 = line.charCodeAt(0);
      if (c0 === 96) {
        const fl = fenceLang(line);
        if (fl !== null) {
          const body = [];
          i++;
          while (i < N && fenceLang(lines[i]) !== '') body.push(lines[i++]);
          i++;
          const cls = fl === '' ? '' : ' class="language-' + esc(fl) + '"';
          const inner = body.length === 0 ? '' : esc(body.join('\n')) + '\n';
          blocks.push('<pre><code' + cls + '>' + inner + '</code></pre>\n');
          continue;
        }
      } else if (c0 === 35) {
        const hd = headingOf(line);
        if (hd !== null) {
          let slug = slugCache.get(hd.text);
          if (slug === undefined) {
            slug = slugifyCore(hd.text);
            slugCache.set(hd.text, slug);
          }
          const id = uniqueSlug(slug, ids);
          const html = inline(hd.text, link);
          blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
          if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
          i++;
          continue;
        }
      } else if (c0 === 45 || c0 === 42) {
        if (isHR(line)) {
          blocks.push('<hr>\n');
          i++;
          continue;
        }
        const ls0 = listStart(line);
        if (ls0 !== null) {
          i++;
          listBlock(ls0);
          continue;
        }
      } else if (c0 === 62) {
        const body = [];
        while (i < N && lines[i].charCodeAt(0) === 62) {
          const l = lines[i++];
          body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        }
        const ls = [];
        for (let k = 0; k < body.length; k++) {
          const t = trimST(body[k]);
          if (t !== '') ls.push(t);
        }
        blocks.push(
          ls.length === 0
            ? '<blockquote>\n</blockquote>\n'
            : '<blockquote>\n<p>' + inline(ls.join('\n'), link) + '</p>\n</blockquote>\n',
        );
        continue;
      } else if (c0 >= 48 && c0 <= 57) {
        const ls0 = listStart(line);
        if (ls0 !== null) {
          i++;
          listBlock(ls0);
          continue;
        }
      }
    }
    const body = [trimST(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>\n');
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function templateError(name, msg) {
  return new Error('template "' + name + '": ' + msg);
}

/** The path `text` names, split at its dots, or a template error. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw templateError(name, JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw templateError(name, 'a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') {
        tokens.push({ t: 'text', text });
        text = '';
      }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? L : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') {
      tokens.push({ t: 'text', text });
      text = '';
    }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a template error when it does not parse). */
function parseTemplateTree(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw templateError(name, 'an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw templateError(name, 'an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body =
          parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw templateError(name, '{% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw templateError(name, 'a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += textOf(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A value as an escaped variable writes it: strings escaped, numbers and booleans in their own digits. */
function escText(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(textOf(v));
  return '';
}

/**
 * A template compiled to a render function (out, scope, depth, tpls, escText, textOf, lookup, truthy):
 * it pushes the template's output onto `out` (an array of strings). Paths are hoisted to constants,
 * loops use plain for loops, includes call the compiled template for the name. Each loop's scope
 * frame and loop record are created once per render (hoisted to the function's top) and their
 * fields set per element, so iterating allocates nothing.
 */
function compileTemplate(name, src) {
  const nodes = parseTemplateTree(name, src);
  const paths = [];
  const pathIndex = new Map();
  const pid = (path) => {
    const key = path.join('');
    let ix = pathIndex.get(key);
    if (ix === undefined) {
      ix = paths.length;
      paths.push(path);
      pathIndex.set(key, ix);
    }
    return ix;
  };
  let uid = 0;
  const decls = [];
  const gen = (ns, scopeVar, out) => {
    for (const n of ns) {
      if (n.kind === 'text') out.push('out.push(' + JSON.stringify(n.text) + ');');
      else if (n.kind === 'var')
        out.push('out.push(escText(lookup(' + scopeVar + ',P' + pid(n.path) + ')));');
      else if (n.kind === 'raw') out.push('out.push(textOf(lookup(' + scopeVar + ',P' + pid(n.path) + ')));');
      else if (n.kind === 'if') {
        out.push(
          'if(truthy(lookup(' + scopeVar + ',P' + pid(n.path) + '))!==' + (n.not ? 'true' : 'false') + '){',
        );
        gen(n.then, scopeVar, out);
        out.push('}');
        if (n.else !== null) {
          out.push('else{');
          gen(n.else, scopeVar, out);
          out.push('}');
        }
      } else if (n.kind === 'for') {
        const u = ++uid;
        const sv = 's' + u;
        const lv = 'l' + u;
        decls.push(
          'var ' +
            sv +
            '={vars:{},parent:' +
            scopeVar +
            '};var ' +
            lv +
            '={index:0,first:false,last:false,length:0};' +
            sv +
            '.vars.loop=' +
            lv +
            ';',
        );
        out.push('var a' + u + '=lookup(' + scopeVar + ',P' + pid(n.path) + ');');
        out.push('if(Array.isArray(a' + u + ')){');
        out.push(lv + '.length=a' + u + '.length;');
        out.push('for(var k' + u + '=0;k' + u + '<a' + u + '.length;k' + u + '++){');
        if (n.name !== 'loop') out.push(sv + '.vars[' + JSON.stringify(n.name) + ']=a' + u + '[k' + u + '];');
        out.push(
          lv +
            '.index=k' +
            u +
            '+1;' +
            lv +
            '.first=k' +
            u +
            '===0;' +
            lv +
            '.last=k' +
            u +
            '===a' +
            u +
            '.length-1;',
        );
        gen(n.body, sv, out);
        out.push('}}');
      } else if (n.kind === 'include') {
        const u = ++uid;
        out.push(
          'var f' +
            u +
            '=tpls.get(' +
            JSON.stringify(n.name) +
            ');if(f' +
            u +
            '!==undefined&&depth<8)f' +
            u +
            '(out,' +
            scopeVar +
            ',depth+1,tpls,escText,textOf,lookup,truthy);',
        );
      }
    }
  };
  const lines = [];
  gen(nodes, 'scope', lines);
  let head = '';
  for (let i = 0; i < paths.length; i++) head += 'var P' + i + '=' + JSON.stringify(paths[i]) + ';';
  return new Function(
    'out',
    'scope',
    'depth',
    'tpls',
    'escText',
    'textOf',
    'lookup',
    'truthy',
    head + decls.join('') + lines.join(''),
  );
}

// ---------------------------------------------------------------- the build

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (t) => {
    let h = slugCache.get(t);
    if (h === undefined) {
      h = slugifyCore(t);
      slugCache.set(t, h);
    }
    return h;
  };
  const report = [];
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md'))
      sources.push({
        path: f.path,
        text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'),
      });
    else statics.push(f);
  }

  // 2. Each source's front matter, in order; a refused source or a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let t = taken.get(dir);
    if (t === undefined) {
      t = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, t);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), t);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMD(s.bodyLines, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags, grouped by their slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const arr = s.data.tags === undefined ? [] : s.data.tags;
    for (let k = 0; k < arr.length; k++) {
      const sl = slugify(arr[k]);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(arr[k]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugify(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: base + '/tags/' + sl + '/', posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const refs = [];
    for (const name of ownTags(s)) {
      const sl = slugify(name);
      const t = bySlug.get(sl);
      refs.push(t !== undefined ? t : { name, slug: sl, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // A page's link record as templates read it.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date === undefined ? '' : s.data.date,
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };

  // A post's card, as lists show it (computed once per source).
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date === undefined ? '' : s.data.date,
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary === undefined ? '' : s.data.summary,
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, varsObj) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, { vars: varsObj, parent: null }, 0, templates, escText, textOf, lookup, truthy);
    return out.join('');
  };
  for (const s of kept) {
    const page = Object.assign({}, s.card, {
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer === undefined ? null : s.newer),
      older: linkOf(s.older === undefined ? null : s.older),
      is_post: s.post,
    });
    output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let nPages = 0;
  for (const s of kept) if (!s.post) nPages++;
  lines.push(
    'built ' +
      nPages +
      ' pages, ' +
      posts.length +
      ' posts, ' +
      tags.length +
      ' tags and ' +
      statics.length +
      ' static files',
  );
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
