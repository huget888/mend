// mend — one patch tool for every AI edit format.
// Built from SPEC.md (starter/SPEC.md) of hidden-spec-cli-01-run-20261122.
// Node 22, standard library only. Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Formats: unified diff, SEARCH/REPLACE blocks, V4A, JSON edits. Matching
// happens at three tiers (exact, trailing-whitespace-insensitive,
// leading+trailing-whitespace-insensitive with re-indentation). A patch
// either applies completely or not at all; failures are reported per edit.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// A patch that is malformed in a way the spec reports as `error: <line>`.
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

// One edit that failed, with the spec's failure code and path.
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

// Split patch text into lines: split at \n, drop the empty piece after a
// final \n, and remove one trailing \r from every line.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

// ---------------------------------------------------------------- files

interface FileState {
  lines: string[];
  br: string; // the file's line break: '\n' or '\r\n'
  final: boolean; // whether the file ends with a line break
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// -------------------------------------------------------------- matching

// The comparison key of a line at a matching tier: 0 exact, 1 trailing
// whitespace removed, 2 leading and trailing whitespace removed.
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Positions where the lines O occur in `lines` at the given tier, at or
// after `from`.
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const keys = O.map((l) => tierKey(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (tierKey(lines[i + k]!, tier) !== keys[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; tier 0 only under --strict) at which
// O occurs, with its positions. Null when O never occurs.
function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// At tier 2, a new line that is not empty and not only whitespace and that
// starts with the old first line's indentation P has that P replaced by
// the matched file line's indentation F.
function reindent(line: string, P: string, F: string): string {
  if (line === '' || line.trim() === '') return line;
  if (!line.startsWith(P)) return line;
  return F + line.slice(P.length);
}

// One line of the replacement text: a context line (index into O, written
// as the file's own matched line) or a fresh line (written as-is, except
// for the tier-2 re-indentation).
interface NLine {
  text: string;
  ctx: number | null;
}

// Replace lines[pos .. pos + O.length) by N, honouring the matching tier.
function applyRep(
  lines: string[],
  pos: number,
  O: string[],
  N: NLine[],
  tier: number,
): string[] {
  const out = lines.slice(0, pos);
  const F = lead(lines[pos]!);
  const P = lead(O[0]!);
  for (const n of N) {
    if (n.ctx !== null) out.push(lines[pos + n.ctx]!);
    else if (tier === 2) out.push(reindent(n.text, P, F));
    else out.push(n.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

// ------------------------------------------------------------------ tree

// The file tree under the current directory, as the edits leave it.
// `now` holds every path an edit touched; `orig` caches the pre-patch
// bytes of the paths that were read.
class Tree {
  private orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.orig.set(p, value);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

// ------------------------------------------------------- format detection

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------------- json

// One edit, as a function of the tree. Every path the edit names is
// checked for safety before anything else about it.
type Edit = (tree: Tree) => void;

// Build the edit for one JSON edit object, or null when the object is not
// a well-formed edit.
function jsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  const path = o.path;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : (o.new_str as string);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const f = splitFile(cur);
      const text = f.lines.join(f.br) + (f.final ? f.br : '');
      const isCrlf = f.br === '\r\n';
      const norm = isCrlf ? text.replace(/\r\n/g, '\n') : text;
      const normOld = isCrlf ? oldStr.replace(/\r\n/g, '\n') : oldStr;
      const normNew = isCrlf ? newStr.replace(/\r\n/g, '\n') : newStr;
      let count = 0;
      for (let k = norm.indexOf(normOld); k >= 0; k = norm.indexOf(normOld, k + 1)) count++;
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      const replaced = norm.replace(normOld, normNew);
      const out = isCrlf ? replaced.replace(/\n/g, '\r\n') : replaced;
      tree.set(path, out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line as number;
    const newStr = o.new_str;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const f = splitFile(cur);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', path);
      const added = patchLines(newStr);
      f.lines.splice(line, 0, ...added);
      tree.set(path, joinFile(f));
    };
  }

  return null;
}

// Parse a JSON patch (array form or JSON Lines form) into its edits.
function jsonEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const firstLine = lines[first]!;
  if (firstLine.trimStart()[0] === '[') {
    const text = lines.join('\n');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(value)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const e = jsonEdit(value);
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------- unified

interface UniHunk {
  a: number; // the old start line number of the hunk
  body: string[]; // body lines, trailing blank lines removed
}

interface UniSection {
  oldP: string | null; // null means /dev/null
  newP: string | null;
  create: boolean; // `new file mode` line seen
  del: boolean; // `deleted file mode` line seen
  hunks: UniHunk[];
}

// The paths from a `diff --git a/<X> b/<Y>` line, or null when the line is
// not of that form.
function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) return null;
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

// The path named by a `--- ` or `+++ ` header line: the text after the
// first four characters up to the first tab, surrounding spaces removed,
// with a leading `a/` or `b/` removed. `/dev/null` is null.
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

// Parse the header lines of a unified section, starting at `i`. Stops at
// the first hunk line, the next section's start, or the end of the patch,
// and returns that index. A `--- ` line not followed by a `+++ ` line is a
// parse error naming the line after it.
function parseUniHeader(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldP = headerPath(l);
        sec.newP = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('rename from ')) {
      sec.oldP = l.slice('rename from '.length);
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.newP = l.slice('rename to '.length);
      i++;
      continue;
    }
    if (l === 'new file mode' || l.startsWith('new file mode ')) {
      sec.create = true;
      i++;
      continue;
    }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
      sec.del = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Split a hunk body into its old lines O and its new lines N (context
// lines carry the index of their line in O), and say whether a `\` line
// follows the hunk's last context or `+` line, and whether one follows
// its last `+` line.
function hunkParts(body: string[]): {
  O: string[];
  N: NLine[];
  noFinal: boolean;
  noFinalPlus: boolean;
} {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastOut = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl.startsWith(' ')) {
      O.push(bl.slice(1));
      N.push({ text: bl.slice(1), ctx: O.length - 1 });
      lastOut = k;
    } else if (bl.startsWith('-')) {
      O.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      N.push({ text: bl.slice(1), ctx: null });
      lastOut = k;
      lastPlus = k;
    } else if (bl === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
      lastOut = k;
    }
  }
  const after = (k: number): boolean =>
    k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
  return { O, N, noFinal: after(lastOut), noFinalPlus: after(lastPlus) };
}

// Parse the hunks of a unified section, starting at `i`. Stops at the
// next section's start or the end of the patch, and returns that index.
// A hunk before any section is a parse error, raised by the caller.
function parseUniHunks(lines: string[], i: number, sec: UniSection): number {
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      let j = i + 1;
      const body: string[] = [];
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\') ||
          bl === ''
        ) {
          body.push(bl);
          j++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
      sec.hunks.push({ a, body });
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const dg = parseDiffGit(l);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldP: dg[0], newP: dg[1], create: false, del: false, hunks: [] };
      i++;
      i = parseUniHeader(lines, i, sec);
      i = parseUniHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldP: null, newP: null, create: false, del: false, hunks: [] };
      sec.oldP = headerPath(l);
      sec.newP = headerPath(lines[i + 1]!);
      i += 2;
      i = parseUniHeader(lines, i, sec);
      i = parseUniHunks(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections;
}

// Apply one hunk of a unified section to the file state `f`, whose lines
// are the evolving result. `d` is the running offset: the sum, over the
// hunks applied so far, of (len(N) - len(O)). Returns the new `d`.
function applyUniHunk(f: FileState, h: UniHunk, d: number, strict: boolean, path: string): number {
  const { O, N, noFinal } = hunkParts(h.body);
  if (O.length === 0) {
    const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
    const atEnd = at === f.lines.length;
    const ins = N.map((x) => x.text);
    f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
    if (atEnd) f.final = !noFinal;
    return d + N.length;
  }
  const found = findTier(f.lines, O, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let pos = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const touchesEnd = pos + O.length === f.lines.length;
  f.lines = applyRep(f.lines, pos, O, N, found.tier);
  if (touchesEnd) f.final = !noFinal;
  return d + (N.length - O.length);
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    const isCreate = (oldP === null || sec.create) && newP !== null;
    const isDelete = !isCreate && (newP === null || sec.del) && oldP !== null;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        const parts = hunkParts(h.body);
        let hasPlus = false;
        for (const bl of h.body) {
          if (bl.startsWith('+')) {
            plus.push(bl.slice(1));
            hasPlus = true;
          }
        }
        if (hasPlus) noFinal = parts.noFinalPlus;
      }
      const file: FileState = { lines: plus, br: '\n', final: plus.length > 0 && !noFinal };
      tree.set(p, joinFile(file));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    if (oldP === null || newP === null) return; // both /dev/null: nothing to do
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) d = applyUniHunk(f, h, d, strict, oldP);
    if (isMove) {
      tree.set(newP, joinFile(f));
      tree.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.set(oldP, joinFile(f));
    }
  };
}

// ---------------------------------------------------------- search/replace

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const file: FileState = { lines: newLines, br: '\n', final: newLines.length > 0 };
        tree.set(p, joinFile(file));
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      f.lines = applyRep(f.lines, pos, oldLines, N, found.tier);
      tree.set(p, joinFile(f));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

// --------------------------------------------------------------------- v4a

interface V4Chunk {
  anchor: string | null; // null means no anchor
  body: string[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const plines: string[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (!blank(m) && !m.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        plines.push(m);
        i++;
      }
      // Blank lines at the end of a section are not part of it.
      while (plines.length > 0 && blank(plines[plines.length - 1]!)) plines.pop();
      const flines = plines.map((m) => (m.startsWith('+') ? m.slice(1) : ''));
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const file: FileState = { lines: flines, br: '\n', final: flines.length > 0 };
        tree.set(p, joinFile(file));
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4Chunk[] = [];
      let cur: V4Chunk | null = null;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m) || m.trim() === '*** End Patch') break;
        if (m.startsWith('@@')) {
          const anchorText = m.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          chunks.push(cur);
          i++;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push(m);
          i++;
          continue;
        }
        if (m.trim() === '*** End of File') {
          if (cur !== null) cur.eof = true;
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of the section are not part of it.
      if (cur !== null) {
        while (cur.body.length > 0 && blank(cur.body[cur.body.length - 1]!)) cur.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLine}`);
      }
      const p = path;
      const to = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (to !== null && !safe(to)) throw new Fail('unsafe', to);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
        const f = splitFile(curText);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundIdx = -1;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
              for (let k = cursor; k < f.lines.length; k++) {
                if (tierKey(f.lines[k]!, t) === tierKey(ch.anchor!, t)) {
                  foundIdx = k;
                  break;
                }
              }
            }
            if (foundIdx < 0) throw new Fail('no-match', p);
            cursor = foundIdx + 1;
          }
          const O: string[] = [];
          const N: NLine[] = [];
          for (const bl of ch.body) {
            if (bl.startsWith(' ')) {
              O.push(bl.slice(1));
              N.push({ text: bl.slice(1), ctx: O.length - 1 });
            } else if (bl.startsWith('-')) {
              O.push(bl.slice(1));
            } else if (bl.startsWith('+')) {
              N.push({ text: bl.slice(1), ctx: null });
            } else if (bl === '') {
              O.push('');
              N.push({ text: '', ctx: O.length - 1 });
            }
          }
          if (O.length === 0) {
            const at = ch.eof ? f.lines.length : cursor;
            const ins = N.map((x) => x.text);
            f.lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
            cursor = at + ins.length;
          } else {
            let found: { tier: number; pos: number } | null = null;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier && found === null; t++) {
              const occ = occurrences(f.lines, O, t, cursor).filter(
                (pos) => !ch.eof || pos + O.length === f.lines.length,
              );
              if (occ.length > 0) found = { tier: t, pos: occ[0]! };
            }
            if (!found) throw new Fail('no-match', p);
            f.lines = applyRep(f.lines, found.pos, O, N, found.tier);
            cursor = found.pos + N.length;
          }
        }
        if (to !== null) {
          tree.set(to, joinFile(f));
          tree.set(p, null);
          tree.moves.push([p, to]);
        } else {
          tree.set(p, joinFile(f));
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// --------------------------------------------------------------------- run

const byteCmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

interface Row {
  key: string;
  line: string;
  write: () => void;
}

function computeRows(tree: Tree): Row[] {
  const rows: Row[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      movedOld.add(o);
      movedNew.add(n);
      rows.push({
        key: n,
        line: `R ${o} -> ${n}`,
        write: () => {
          rmSync(o, { force: true });
          mkdirSync(dirname(n), { recursive: true });
          writeFileSync(n, tree.get(n)!);
        },
      });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) {
      rows.push({
        key: p,
        line: `A ${p}`,
        write: () => {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        },
      });
    } else if (now === null) {
      rows.push({
        key: p,
        line: `D ${p}`,
        write: () => rmSync(p, { force: true }),
      });
    } else {
      rows.push({
        key: p,
        line: `M ${p}`,
        write: () => writeFileSync(p, now),
      });
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  return rows;
}

function run(args: string[]): { code: number; out: string } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: 'error: usage\n' };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: 'error: usage\n' };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;

  let text: string;
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    return { code: 2, out: 'error: no-patch\n' };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: 'error: format\n' };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = jsonEdits(lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: `${e.line}\n` };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: 'error: parse 1\n' };

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`).join('\n') + `\nfailed: ${fails.length} of ${edits.length} edits\n`;
    return { code: 1, out };
  }

  const rows = computeRows(tree);
  const count = rows.length;
  const out = rows.map((r) => r.line).join('\n') + (count > 0 ? '\n' : '') + `ok: ${count} ${count === 1 ? 'file' : 'files'}\n`;
  if (!check) {
    for (const r of rows) r.write();
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out);
  process.exitCode = result.code;
}
