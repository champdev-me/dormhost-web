// Serves the built site out of dist/. No dependencies, and no nginx: easypanel's
// proxy already terminates TLS and routes, so a second web server inside the
// container would only be another thing to configure.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const PORT = Number(process.env.PORT || 3000)

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/index.html is missing. Run `node build.js` first.')
  process.exit(1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

/** style.<8 hex>.css and friends: the name changes whenever the bytes do. */
const HASHED = /\.[0-9a-f]{8}\.(css|js)$/

/**
 * Resolves a URL to a file inside ROOT, or null.
 *
 * The containment check is the point: without it, a request for
 * /../../etc/passwd would escape the site directory.
 */
function resolve(urlPath) {
  let clean
  try {
    clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  } catch {
    return null // malformed percent-encoding
  }
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '')

  for (const candidate of [rel, `${rel}.html`, path.join(rel, 'index.html')]) {
    const full = path.resolve(ROOT, candidate)
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) continue
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      /* try the next shape */
    }
  }
  return null
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    return res.end('method not allowed')
  }

  const file = resolve(req.url || '/')
  if (!file) {
    res.writeHead(404, { 'content-type': TYPES['.html'] })
    return res.end(fs.readFileSync(path.join(ROOT, 'index.html')))
  }

  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    // Content-hashed filenames can be cached forever, because changing the
    // content changes the URL. Everything else gets a day: long enough to be
    // worth caching, short enough that a mistake heals on its own.
    'cache-control': ext === '.html'
      ? 'no-cache'
      : HASHED.test(path.basename(file))
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
})

server.listen(PORT, () => console.log(`dormhost-web listening on ${PORT}`))
