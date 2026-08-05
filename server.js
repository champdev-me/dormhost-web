// Serves the static site. No dependencies, no nginx — easypanel's proxy already
// terminates TLS and routes, so a second web server inside the container would
// only be another thing to configure.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname
const PORT = Number(process.env.PORT || 3000)

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
}

/**
 * Resolves a URL to a file inside ROOT, or null.
 *
 * The containment check is the point: without it, a request for
 * /../../etc/passwd would escape the site directory.
 */
function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  let rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '')

  const candidates = [rel, `${rel}.html`, path.join(rel, 'index.html')]
  for (const candidate of candidates) {
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
    const notFound = path.join(ROOT, 'index.html')
    res.writeHead(404, { 'content-type': TYPES['.html'] })
    return res.end(fs.readFileSync(notFound))
  }

  const ext = path.extname(file)
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
})

server.listen(PORT, () => console.log(`dormhost-web listening on ${PORT}`))
