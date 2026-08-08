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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, statSync, watch } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
    throw new Error(
      'content.json still has placeholders:\n\n' +
        unfilled.map((u) => `  ${u}`).join('\n') +
        '\n\nThese appear on the public site and on the pages a payment processor\n' +
        'reviews. Fill them in and build again.'
    );
  }

  return derive(c);
}

const inr = (n) => n.toLocaleString('en-IN');

// Values assembled from other values live here, so a template never does arithmetic.
function derive(c) {
  // From package.json, not content.json: a version that has to be edited in
  // two places is a version that disagrees with the tag it was built from.
  c.site.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  const a = c.company.address;
  a.oneLine = [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ');
  a.html = [a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`, a.country]
    .filter(Boolean).map(escape).join('<br>');

  // One number, two shapes: tel: wants no spaces, a human wants them.
  const digits = c.company.phone.replace(/[\s-]/g, '');
  c.company.phoneHref = digits;
  const indian = digits.match(/^(\+91)(\d{5})(\d{5})$/);
  c.company.phoneDisplay = indian ? `${indian[1]} ${indian[2]} ${indian[3]}` : c.company.phone;

  for (const p of c.plans) {
    p.monthly = inr(p.priceMonthly);
    p.yearly = inr(p.priceYearly);
    p.yearlyPerMonth = inr(Math.round(p.priceYearly / 12));
    p.yearlySaving = inr(p.priceMonthly * 12 - p.priceYearly);
    // Both rates, because a student comparing plans is comparing days. The
    // platform charges the day's slice of the period rather than this average,
    // so the copy says "about" and the period totals are the exact numbers.
    p.perDay = (p.priceMonthly / 30).toFixed(2);
    p.perDayYearly = (p.priceYearly / 365).toFixed(2);
    // No per-day figure in dollars: a cent is a third of a day at $0.99 a
    // month, so both rates round to the same number and the comparison would
    // say there is no saving when there is one.

    // One price, in rupees, and a dollar approximation of it. They used to be
    // two independent prices, which was a promise the platform could not keep:
    // PayU settles in rupees only, so a dollar account would have had its
    // "$2.49" handed to the gateway and charged as ₹2.49. Derived from a
    // pegged rate so the two can never contradict each other.
    const rate = c.payments.fxRate;
    p.usdMonthly = (p.priceMonthly / rate).toFixed(2);
    p.usdYearly = (p.priceYearly / rate).toFixed(2);
    p.usdYearlySaving = ((p.priceMonthly * 12 - p.priceYearly) / rate).toFixed(2);
  }

  // Written once, as a list of {id, name}, and turned into prose here. Two
  // hand-maintained copies is how a language gets renamed in one and not the
  // other, and how an icon ends up beside the wrong word.
  const names = (list) => list.map((x) => x.name);
  const sentence = (parts) =>
    parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  c.runtimes.detectedText = sentence(names(c.runtimes.detected));
  c.databases.text = names(c.databases.list).join(', ').replace(/, ([^,]*)$/, ' or $1');
  c.databases.textLong = `${c.databases.text}, which is MySQL`;

  c.plansByName = Object.fromEntries(c.plans.map((p) => [p.slug, p]));
  c.cheapest = c.plans.reduce((lo, p) => (p.priceMonthly < lo.priceMonthly ? p : lo));

  // Who wins a comparison row, as booleans a template can read without doing
  // string equality. A row with no "who" is neutral (Best for, usually) and
  // gets no icon.
  for (const cp of c.compares) {
    for (const row of cp.rows) {
      row.oursWin = row.who === 'ours';
      row.theirsWin = row.who === 'theirs';
    }
  }

  // Structured data is assembled here rather than hand-written in a <script>
  // tag: JSON needs JSON escaping, and the template engine only does HTML
  // escaping. Emitted with {{{ }}} so it reaches the page unaltered.
  const a2 = c.company.address;
  c.jsonld = {
    organization: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: c.company.tradeName,
      legalName: c.company.legalName,
      url: c.site.url,
      logo: `${c.site.url}/assets/icon-512.png`,
      image: `${c.site.url}/assets/og.png`,
      email: c.company.email,
      telephone: c.company.phoneHref,
      address: {
        '@type': 'PostalAddress',
        streetAddress: [a2.line1, a2.line2].filter(Boolean).join(', '),
        addressLocality: a2.city,
        addressRegion: a2.state,
        postalCode: a2.pincode,
        addressCountry: 'IN',
      },
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'customer support',
        email: c.company.email,
        telephone: c.company.phoneHref,
        availableLanguage: ['en', 'hi'],
      },
    }),

    products: JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': c.plans.map((p) => ({
        '@type': 'Product',
        name: `${c.site.name} ${p.name}`,
        description: p.description,
        brand: { '@type': 'Brand', name: c.site.name },
        category: 'Web application hosting',
        // One offer, in rupees. A second in dollars would be structured data
        // claiming a price we cannot take: the gateway settles in INR only.
        offers: {
          '@type': 'Offer',
          price: String(p.priceMonthly),
          priceCurrency: 'INR',
          url: `${c.site.url}/pricing.html#${p.slug}`,
          availability: 'https://schema.org/InStock',
        },
      })),
    }),

    // The homepage's visible FAQ, mirrored as structured data. Questions that
    // match how people search ("is it really free", "what can I host") are
    // what FAQPage rich results are for, so the two must not drift.
    faq: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: c.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    }),
  };

  return c;
}

// A crumb trail for the generated pages. Site is the first crumb, the section
// is the second, and the item itself is the last, so a page never claims a
// trail that does not exist in the navigation.
function breadcrumb(site, crumbs) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  });
}

// ---------------------------------------------------------------- search

// Crawl weight, highest first. Anything unlisted is a policy page at 0.5:
// real, indexable, and not what we want ranking above the pricing page.
const PRIORITY = {
  'index.html': '1.0',
  'pricing.html': '0.9',
  'features.html': '0.8',
  'docs.html': '0.8',
  'ai.html': '0.8',
  'about.html': '0.7',
  'contact.html': '0.7',
  'students.html': '0.7',
  'blog.html': '0.6',
  'security.html': '0.5',
  'status.html': '0.4',
  'changelog.html': '0.4',
};

// Generated pages rank by what they are. A use-case page answers a search
// question, a compare page answers a choice, a blog post answers an intent;
// none of them outrank the pricing page they funnel into.
const GENERATED_PRIORITY = {
  'use-cases/': '0.6',
  'compare/': '0.5',
  'blog/': '0.5',
};

const urlEntry = (path, priority, content) => {
  const loc = path === 'index.html' ? `${content.site.url}/` : `${content.site.url}/${path}`;
  return [
    '  <url>',
    `    <loc>${escape(loc)}</loc>`,
    `    <lastmod>${content.site.lastmod}</lastmod>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ].join('\n');
};

function sitemap(urls, content) {
  const xml = urls.map((u) => urlEntry(u.path, u.priority, content)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xml}
</urlset>
`;
}

// AI crawlers are welcome by name, not just by wildcard: a student asking an
// assistant "where do I host my project cheaply in India" is our best referral.
const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
  'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Applebot-Extended', 'meta-externalagent', 'CCBot',
];

const robots = (content) => `User-agent: *
Allow: /

${AI_CRAWLERS.map((bot) => `User-agent: ${bot}\nAllow: /`).join('\n\n')}

Sitemap: ${content.site.url}/sitemap.xml
`;

// llms.txt: the convention AI assistants read for a site's own summary.
// Every fact comes from content.json, so it can never drift from the pages.
function llmsTxt(content) {
  const c = content;
  const plans = c.plans
    .map((p) => `- **${p.name}**: Rs ${p.monthly}/month per app (about $${p.usdMonthly}). ${p.summary}`)
    .join('\n');
  return `# ${c.site.name}

> Web hosting for college students, built in India: deploy any language from GitHub for Rs ${c.cheapest.monthly}/month (about $${c.cheapest.usdMonthly}). Pay by UPI in India or by card from anywhere; no card needed to start, ${c.trial.days} days free. Also an OpenAI-compatible AI API billed in rupees per request.

## What ${c.site.name} is

${c.site.name} (${c.site.url}) hosts student projects: Node, Python, Go, or any Dockerfile, built from a GitHub repository, with a MongoDB, PostgreSQL or MariaDB database included. Apps run on ${c.site.appDomain} subdomains, custom domains supported. ${c.company.gst.statement}

## Plans

${plans}

${c.trial.short} ${c.trial.noCard}

## AI API

${c.ai.pitch} ${c.ai.injected}
- Endpoint: ${c.ai.endpoint} (OpenAI-compatible; any OpenAI SDK works)
- Live model list and rupee prices: ${c.ai.endpoint}/models
- ${c.ai.billing}

## Pages

- [Pricing](${c.site.url}/pricing.html): full plan details and live AI prices
- [AI](${c.site.url}/ai.html): the AI API, models, billing and quickstart
- [Features](${c.site.url}/features.html): deploy, run, data, networking and developer experience
- [Student projects](${c.site.url}/students.html): what to deploy, by project type
- [Docs](${c.site.url}/docs.html): quickstart, deploy and troubleshoot
- [Security](${c.site.url}/security.html): isolation, HTTPS, backups and credentials
- [Status](${c.site.url}/status.html): what is up, honestly
- [Changelog](${c.site.url}/changelog.html): what shipped and when
- [About](${c.site.url}/about.html): who runs this and why
- [Terms](${c.site.url}/terms.html), [AI terms](${c.site.url}/ai-terms.html), [Privacy](${c.site.url}/privacy.html), [Refunds](${c.site.url}/refunds.html)
- Dashboard for sign-up and deploys: ${c.site.dashboardUrl}

## Use cases

${c.useCases.map((u) => `- [${u.title}](${c.site.url}/use-cases/${u.slug}.html): ${u.meta}`).join('\n')}

## Comparisons

${c.compares.map((cp) => `- [${cp.title}](${c.site.url}/compare/${cp.slug}.html): ${cp.meta}`).join('\n')}

## Blog

${c.blogPosts.map((p) => `- [${p.title}](${c.site.url}/blog/${p.slug}.html): ${p.meta}`).join('\n')}

## Who it is for

College students and hobbyists anywhere who need cheap, honest hosting for course projects, Discord and Telegram bots, portfolio sites and small APIs. Built in India and especially friendly there (UPI, rupee pricing, no card), with international cards working from everywhere else and hosting in Mumbai or London.
`;
}

// ---------------------------------------------------------------- build

const rev = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

function build() {
  const content = loadContent();

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // The stylesheet ships under a content-hashed name, and the icons carry a
  // hash in the query. Without this a CSS change is invisible behind a CDN
  // for as long as the old file's max-age: fresh HTML lands against a stale
  // stylesheet, and every rule added since the last deploy simply does not
  // exist. Elements styled only by the new rules then fall back to their
  // intrinsic size, which for an <svg> is 300x150. That shipped once.
  const css = readFileSync(join(SRC, 'style.css'));
  const cssName = `style.${rev(css)}.css`;
  const assets = {
    css: `/${cssName}`,
    rev: rev(readFileSync(join(root, 'assets/logo.svg'))),
  };

  const pages = readdirSync(SRC).filter((f) => f.endsWith('.html'));
  if (pages.length === 0) throw new Error('src/ has no .html pages');

  // Every page gets the whole content tree plus a small, page-specific header.
  const pageCtx = (content, assets, file, extra = {}) => ({
    ...content,
    ...extra,
    assets,
    page: {
      name: basename(file, '.html'),
      file,
      isHome: file === 'index.html',
      // Anchor links in the shared nav resolve in-page on the homepage and
      // jump back to it from anywhere else.
      homePrefix: file === 'index.html' ? '' : '/',
      // Canonical, and the og:url that goes with it.
      url: file === 'index.html' ? `${content.site.url}/` : `${content.site.url}/${file}`,
    },
  });

  const missing = [];
  for (const page of pages) {
    const src = readFileSync(join(SRC, page), 'utf8');
    const ctx = pageCtx(content, assets, page);
    const result = render(src, ctx, `src/${page}`);
    missing.push(...result.missing);
    writeFileSync(join(DIST, page), result.html);
  }

  // Generated pages: one HTML file per entry in content.json, rendered from a
  // template in src/templates/. They live in subdirectories (use-cases/,
  // compare/, blog/) so each gets its own URL and can rank on its own.
  const generated = (tpl, file, item, crumbs) => {
    const url = `${content.site.url}/${file}`;
    item.jsonldBreadcrumb = breadcrumb(content.site, crumbs);
    const ctx = pageCtx(content, assets, file, item);
    const tplPath = `src/templates/${tpl}.html`;
    const result = render(readFileSync(join(SRC, 'templates', `${tpl}.html`), 'utf8'), ctx, tplPath);
    missing.push(...result.missing);
    mkdirSync(dirname(join(DIST, file)), { recursive: true });
    writeFileSync(join(DIST, file), result.html);
  };

  const urls = pages.map((page) => ({ path: page, priority: PRIORITY[page] ?? '0.5' }));

  for (const uc of content.useCases) {
    generated('use-case', `use-cases/${uc.slug}.html`, uc, [
      { name: content.site.name, url: `${content.site.url}/` },
      { name: 'Student projects', url: `${content.site.url}/students.html` },
      { name: uc.title, url: `${content.site.url}/use-cases/${uc.slug}.html` },
    ]);
    urls.push({ path: `use-cases/${uc.slug}.html`, priority: GENERATED_PRIORITY['use-cases/'] });
  }

  for (const cp of content.compares) {
    generated('compare', `compare/${cp.slug}.html`, cp, [
      { name: content.site.name, url: `${content.site.url}/` },
      { name: 'Pricing', url: `${content.site.url}/pricing.html` },
      { name: cp.title, url: `${content.site.url}/compare/${cp.slug}.html` },
    ]);
    urls.push({ path: `compare/${cp.slug}.html`, priority: GENERATED_PRIORITY['compare/'] });
  }

  for (const post of content.blogPosts) {
    generated('post', `blog/${post.slug}.html`, post, [
      { name: content.site.name, url: `${content.site.url}/` },
      { name: 'Blog', url: `${content.site.url}/blog.html` },
      { name: post.title, url: `${content.site.url}/blog/${post.slug}.html` },
    ]);
    urls.push({ path: `blog/${post.slug}.html`, priority: GENERATED_PRIORITY['blog/'] });
  }

  if (missing.length) {
    throw new Error(
      'Template placeholders with nothing behind them:\n\n' +
        missing.map((m) => `  ${m}`).join('\n') +
        '\n\nEither add the value to content.json or remove the placeholder.'
    );
  }

  writeFileSync(join(DIST, 'sitemap.xml'), sitemap(urls, content));
  writeFileSync(join(DIST, 'robots.txt'), robots(content));
  writeFileSync(join(DIST, 'llms.txt'), llmsTxt(content));

  writeFileSync(join(DIST, cssName), css);
  cpSync(join(root, 'assets'), join(DIST, 'assets'), { recursive: true });

  const bytes = readdirSync(DIST)
    .map((f) => statSync(join(DIST, f)))
    .reduce((n, s) => n + (s.isFile() ? s.size : 0), 0);

  return {
    pages: pages.length + content.useCases.length + content.compares.length + content.blogPosts.length,
    kb: (bytes / 1024).toFixed(0),
  };
}

// ---------------------------------------------------------------- entry

const watching = process.argv.includes('--watch');

function once() {
  try {
    const { pages, kb } = build();
    const at = watching ? new Date().toTimeString().slice(0, 8) + '  ' : '';
    console.log(`${at}built ${pages} pages (${kb} kB) → dist/`);
    return true;
  } catch (err) {
    console.error(`\n${err.message}\n`);
    if (!watching) process.exit(1);
    return false;
  }
}

once();

if (watching) {
  // Coalesce the burst of events an editor emits for a single save.
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(once, 80);
  };
  watch(SRC, { recursive: true }, rebuild);
  watch(join(root, 'content.json'), rebuild);

  // A running watcher holds this file in memory, so editing it and carrying on
  // would keep rebuilding with the old code and quietly write a wrong dist/.
  // Stopping is the only honest option.
  watch(join(root, 'build.js'), () => {
    console.log('\nbuild.js changed. Stopping, because this watcher is still');
    console.log('running the old copy. Start it again to pick up the change.\n');
    process.exit(0);
  });

  console.log('watching src/ and content.json');
}
