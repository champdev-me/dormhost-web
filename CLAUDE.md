# Working in this repo

The DormHost marketing site. Zero-dependency static build: `node build.js`.

## Comments and prose

Comments short. No em dashes anywhere, including page copy and legal text.

## Tooling

`pnpm` for anything that needs it. Never `npm` or `yarn`.

## Git

Never set a git author identity. The global config is already correct.

## Things that bite here

`content.json` is the single source of truth for every price, policy and legal
fact. Change it there, never in a template. The build fails on an unfilled
`FILL_ME` or an unresolved placeholder, which is deliberate.

The stylesheet is content-hashed because Cloudflare cached an old one for a week
against fresh HTML, and every inline SVG carries explicit `width` and `height`
so a missing rule cannot fall back to 300x150.

Copy must match what the platform actually does. The site claimed we issue
certificates for custom domains, and we do not: the origin serves one
self-signed cert behind Cloudflare.
