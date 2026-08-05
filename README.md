# dormhost-web

The public site for [DormHost](https://dormhost.dev) — cheap hosting for college
students.

## What is here

| Path | What it is |
|---|---|
| `index.html` | Marketing homepage |
| `terms.html`, `privacy.html`, `refunds.html`, `contact.html` | Policy pages, required for payment-gateway onboarding |
| `style.css` | All styling — one file, no build step |
| `Dockerfile` | nginx serving the static files |

There is no build step and no JavaScript framework. The one piece of script is
the wake demo on the homepage, inline at the bottom of `index.html`.

## Running it locally

```bash
docker build -t dormhost-web .
docker run --rm -p 8080:80 dormhost-web
# http://localhost:8080
```

## Deploying with easypanel

Create a new **App** service, point it at this repository, and choose the
**Dockerfile** build method. Set the domain to `dormhost.dev` and enable HTTPS.
Nothing else is needed — the container listens on port 80.

## Before submitting to a payment gateway

The policy pages contain placeholders that a gateway's review **will** reject:

- `[YOUR LEGAL ENTITY NAME]`
- `[YOUR ADDRESS]`, `[YOUR CITY]`
- `[YOUR CONTACT NUMBER]`
- `[YOUR GSTIN]`

Search for `[YOUR` across the repo and replace every match with your registered
details. Gateways verify these against your business registration.

## Adding the admin panel later

The panel will live in `panel/` with its own `Dockerfile`, deployed as a second
easypanel service on a subdomain. Keeping both in one repository means the site
and the panel share styling and ship together.
