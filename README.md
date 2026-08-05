# dormhost-web

The public site for [DormHost](https://dormhost.dev) — cheap hosting for college
students.

## What is here

| Path | What it is |
|---|---|
| `index.html` | Marketing homepage |
| `terms.html`, `privacy.html`, `refunds.html`, `contact.html` | Policy pages, required for payment-gateway onboarding |
| `style.css` | All styling — one file, no build step |
| `server.js` | 40-line Node static server, no dependencies |

There is no build step and no JavaScript framework. The one piece of script is
the wake demo on the homepage, inline at the bottom of `index.html`.

## Running it locally

```bash
node server.js
# http://localhost:3000
```

## Deploying with easypanel

Create a new **App** service and point it at this repository. The buildpack
detects Node from `package.json` and runs `npm start`. Set the domain to
`dormhost.dev` and enable HTTPS.

There is deliberately no nginx and no Dockerfile: easypanel's proxy already
terminates TLS and routes, so a second web server inside the container would
only be another thing to configure. The app listens on `PORT`, which easypanel
sets.

## Before submitting to a payment gateway

The policy pages contain placeholders that a gateway's review **will** reject:

- `[YOUR LEGAL ENTITY NAME]`
- `[YOUR ADDRESS]`, `[YOUR CITY]`
- `[YOUR CONTACT NUMBER]`
- `[YOUR GSTIN]`

Search for `[YOUR` across the repo and replace every match with your registered
details. Gateways verify these against your business registration.

## Adding the admin panel later

The panel will live in `panel/` as a Next.js app, deployed as a second easypanel
service on a subdomain. Keeping both in one repository means the site
and the panel share styling and ship together.
