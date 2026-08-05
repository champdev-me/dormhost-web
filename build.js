#!/usr/bin/env node
// Renders src/*.html into dist/, filling every {{placeholder}} from content.json.
//
// Two rules make this worth having over hand-edited HTML:
//   1. A legal fact (the registered address, the refund window, the price)
//      is written once and appears identically on every page that cites it.
//   2. The build FAILS on an unfilled value rather than shipping it. A payment
//      processor reading "[YOUR ADDRESS]" on the terms page is a rejection, so
//      a placeholder must not be able to reach production quietly.
//
// No dependencies, by design: the runtime image is alpine + node and nothing else.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, 'src');
const DIST = join(root, 'dist');
const PARTIALS = join(SRC, 'partials');

// ---------------------------------------------------------------- template

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// {{{raw}}} must be tried before {{escaped}}, hence the alternation order.
const TOKEN = /\{\{\{([^{}]+)\}\}\}|\{\{([#/][^{}]+)\}\}|\{\{([^{}]+)\}\}/g;

function tokenize(str) {
  const out = [];
  let last = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(str)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: str.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ t: 'raw', v: m[1].trim() });
    } else if (m[2] !== undefined) {
      const s = m[2].trim();
      if (s[0] === '#') {
        const [kw, ...rest] = s.slice(1).trim().split(/\s+/);
        out.push({ t: 'open', kw, arg: rest.join(' ') });
      } else {
        out.push({ t: 'close', kw: s.slice(1).trim() });
      }
    } else {
      out.push({ t: 'var', v: m[3].trim() });
    }
    last = TOKEN.lastIndex;
  }
  if (last < str.length) out.push({ t: 'text', v: str.slice(last) });
  return out;
}

function parse(tokens, where) {
  const root = { kw: 'root', children: [] };
  const stack = [root];
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (tok.t === 'open') {
      const node = { kw: tok.kw, arg: tok.arg, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (tok.t === 'close') {
      if (stack.length === 1) throw new Error(`${where}: {{/${tok.kw}}} with no matching open`);
      const closed = stack.pop();
      if (closed.kw !== tok.kw) {
        throw new Error(`${where}: {{#${closed.kw}}} closed by {{/${tok.kw}}}`);
      }
    } else {
      top.children.push(tok);
    }
  }
  if (stack.length !== 1) throw new Error(`${where}: unclosed {{#${stack[stack.length - 1].kw}}}`);
  return root;
}

const MISSING = Symbol('missing');

// Innermost scope wins; unresolved names walk outward to the root context.
function lookup(path, scopes) {
  if (path === '.' || path === 'this') return scopes[scopes.length - 1];
  const parts = path.split('.');
  for (let i = scopes.length - 1; i >= 0; i--) {
    let cur = scopes[i];
    let ok = true;
    for (const p of parts) {
      if (cur !== null && typeof cur === 'object' && p in cur) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok) return cur;
  }
  return MISSING;
}

const falsy = (v) =>
  v === MISSING || v === undefined || v === null || v === false || v === '' ||
  (Array.isArray(v) && v.length === 0);

function evaluate(node, scopes, where, missing) {
  let out = '';
  for (const child of node.children) {
    switch (child.kw ?? child.t) {
      case 'text':
        out += child.v;
        break;

      case 'var':
      case 'raw': {
        const v = lookup(child.v, scopes);
        if (v === MISSING || v === undefined || v === null) {
          missing.push(`${where}: {{${child.v}}}`);
          break;
        }
        out += child.t === 'raw' ? String(v) : escape(v);
        break;
      }

      case 'each': {
        const list = lookup(child.arg, scopes);
        if (list === MISSING) { missing.push(`${where}: {{#each ${child.arg}}}`); break; }
        if (!Array.isArray(list)) throw new Error(`${where}: {{#each ${child.arg}}} is not an array`);
        list.forEach((item, i) => {
          const scoped = typeof item === 'object' && item !== null
            ? { ...item, _index: i, _number: i + 1, _first: i === 0, _last: i === list.length - 1 }
            : item;
          out += evaluate(child, [...scopes, scoped], where, missing);
        });
        break;
      }

      case 'if':
        if (!falsy(lookup(child.arg, scopes))) out += evaluate(child, scopes, where, missing);
        break;

      case 'unless':
        if (falsy(lookup(child.arg, scopes))) out += evaluate(child, scopes, where, missing);
        break;

      default:
        throw new Error(`${where}: unknown block {{#${child.kw}}}`);
    }
  }
  return out;
}

// Partials are spliced in before parsing so a block can span a partial boundary.
function inlinePartials(str, where, seen = []) {
  return str.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    if (seen.includes(name)) throw new Error(`${where}: partial "${name}" includes itself`);
    let body;
    try {
      body = readFileSync(join(PARTIALS, `${name}.html`), 'utf8');
    } catch {
      throw new Error(`${where}: no such partial "${name}" (expected src/partials/${name}.html)`);
    }
    return inlinePartials(body, `partials/${name}.html`, [...seen, name]);
  });
}

function render(str, ctx, where) {
  const missing = [];
  const html = evaluate(parse(tokenize(inlinePartials(str, where)), where), [ctx], where, missing);
  return { html, missing };
}

// ---------------------------------------------------------------- content

function loadContent() {
  const raw = readFileSync(join(root, 'content.json'), 'utf8');
  const c = JSON.parse(raw);

  const unfilled = [];
  (function scan(node, path) {
    if (typeof node === 'string') {
      if (node.includes('FILL_ME')) unfilled.push(`${path} = ${node}`);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith('_')) continue; // notes to the reader, not site content
        scan(v, path ? `${path}.${k}` : k);
      }
    }
  })(c, '');

  if (unfilled.length) {
    console.error('\ncontent.json still has placeholders:\n');
    for (const u of unfilled) console.error(`  ${u}`);
    console.error(
      '\nThese appear on the public site and on the pages a payment processor reviews.\n' +
      'Fill them in and build again.\n'
    );
    process.exit(1);
  }

  return derive(c);
}

const inr = (n) => n.toLocaleString('en-IN');

// Values assembled from other values live here, so a template never does arithmetic.
function derive(c) {
  const a = c.company.address;
  a.oneLine = [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ');
  a.html = [a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`, a.country]
    .filter(Boolean).map(escape).join('<br>');

  for (const p of c.plans) {
    p.monthly = inr(p.priceMonthly);
    p.yearly = inr(p.priceYearly);
    p.yearlyPerMonth = inr(Math.round(p.priceYearly / 12));
    p.yearlySaving = inr(p.priceMonthly * 12 - p.priceYearly);
    p.perDay = (p.priceMonthly / 30).toFixed(2);
  }

  c.plansByName = Object.fromEntries(c.plans.map((p) => [p.slug, p]));
  c.cheapest = c.plans.reduce((lo, p) => (p.priceMonthly < lo.priceMonthly ? p : lo));
  return c;
}

// ---------------------------------------------------------------- build

function build() {
  const content = loadContent();

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const pages = readdirSync(SRC).filter((f) => f.endsWith('.html'));
  if (pages.length === 0) throw new Error('src/ has no .html pages');

  const missing = [];
  for (const page of pages) {
    const src = readFileSync(join(SRC, page), 'utf8');
    const isHome = page === 'index.html';
    const ctx = {
      ...content,
      page: {
        name: basename(page, '.html'),
        file: page,
        isHome,
        // Anchor links in the shared nav resolve in-page on the homepage and
        // jump back to it from anywhere else.
        homePrefix: isHome ? '' : '/',
      },
    };
    const result = render(src, ctx, `src/${page}`);
    missing.push(...result.missing);
    writeFileSync(join(DIST, page), result.html);
  }

  if (missing.length) {
    console.error('\nTemplate placeholders with nothing behind them:\n');
    for (const m of missing) console.error(`  ${m}`);
    console.error('\nEither add the value to content.json or remove the placeholder.\n');
    process.exit(1);
  }

  for (const asset of ['style.css', 'assets']) {
    const from = join(root, asset === 'style.css' ? 'src/style.css' : asset);
    cpSync(from, join(DIST, basename(from)), { recursive: true });
  }

  const bytes = readdirSync(DIST)
    .map((f) => statSync(join(DIST, f)))
    .reduce((n, s) => n + (s.isFile() ? s.size : 0), 0);

  console.log(`built ${pages.length} pages (${(bytes / 1024).toFixed(0)} kB) → dist/`);
  for (const page of pages.sort()) console.log(`  /${page === 'index.html' ? '' : page}`);
}

build();
