# dormhost-web

The public site for [DormHost](https://dormhost.dev), cheap hosting for college
students in India. Static HTML, no framework, no dependencies.

## Editing content

Almost everything you might want to change lives in **`content.json`**: the legal
name and registered address, the support email and phone, the plans and their
prices, the refund window, the retention periods. Change a value there and every
page that mentions it updates on the next build.

The build **fails** if any value still contains `FILL_ME`. That is deliberate:
these facts appear on the pages a payment processor reviews, and a placeholder
must not be able to reach production quietly.

## Layout

| Path | What it is |
|---|---|
| `content.json` | Every legal, contact and pricing fact, in one place |
| `src/*.html` | Page templates |
| `src/partials/` | Shared head, nav and footer |
| `src/style.css` | All styling, one file |
| `assets/` | Logo masters and the rendered PNG icon set |
| `build.js` | Fills the templates from `content.json` into `dist/` |
| `server.js` | Serves `dist/`, standard library only |
| `tools/` | Icon and social card rendering, run by hand |

## Templates

`build.js` implements just enough of a template language to avoid repeating
things:

```
{{company.email}}          escaped value
{{{company.address.html}}} raw value, for pre-built markup
{{> nav}}                  include src/partials/nav.html
{{#each plans}}...{{/each}}  loop, {{.}} is the current item
{{#if featured}}...{{/if}}   and {{#unless}}
```

A placeholder with nothing behind it fails the build rather than rendering
empty.

## Running it

```bash
node build.js     # src/ + content.json -> dist/
node server.js    # serve dist/ on :3000
pnpm dev          # both
```

## Icons

`assets/logo.svg` is the master. The PNGs beside it are rendered from it and
committed, because the runtime image is alpine and node and should not have to
carry a headless browser to redraw five icons.

After changing the logo:

```bash
pnpm icons        # needs Google Chrome, macOS
```

## Deployment

Pushing to `main` triggers a rebuild on easypanel, which builds the `Dockerfile`
and serves the result at <https://dormhost.dev>. The image is built in two
stages, so what ships is `dist/` plus `server.js` and nothing that made them.
