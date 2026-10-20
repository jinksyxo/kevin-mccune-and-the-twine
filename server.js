import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Minimal .env loader -- no dependency, same pattern as the Matsumoto repo's
// scripts/stripe-test-report.js. Real values always win over a placeholder
// in the file, and .env.local wins over .env.
// ---------------------------------------------------------------------------
function loadEnvFile(filePath) {
  try {
    const contents = readFileSync(filePath, 'utf8')

    contents.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) {
        return
      }

      const separatorIndex = trimmed.indexOf('=')

      if (separatorIndex === -1) {
        return
      }

      const key = trimmed.slice(0, separatorIndex).trim()
      const value = trimmed.slice(separatorIndex + 1).trim()

      if (key && process.env[key] === undefined) {
        process.env[key] = value
      }
    })
  } catch {
    // Env files are optional.
  }
}

loadEnvFile(path.join(__dirname, '.env'))
loadEnvFile(path.join(__dirname, '.env.local'))

const PORT = Number(process.env.PORT || 3100)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me'
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-too'
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(UPLOADS_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(path.join(DATA_DIR, 'blog.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    header_image TEXT,
    published INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`)

function rowToPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    headerImage: row.header_image || null,
    published: Boolean(row.published),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function listPublishedPosts() {
  return db
    .prepare('SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC')
    .all()
    .map(rowToPost)
}

function listAllPosts() {
  return db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all().map(rowToPost)
}

function getPostBySlug(slug, { includeUnpublished = false } = {}) {
  const row = includeUnpublished
    ? db.prepare('SELECT * FROM posts WHERE slug = ?').get(slug)
    : db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(slug)

  return row ? rowToPost(row) : null
}

function getPostById(id) {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
  return row ? rowToPost(row) : null
}

function slugExists(slug, excludeId) {
  const row = excludeId
    ? db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, excludeId)
    : db.prepare('SELECT id FROM posts WHERE slug = ?').get(slug)

  return Boolean(row)
}

function uniqueSlug(baseSlug, excludeId) {
  let candidate = baseSlug
  let suffix = 2

  while (slugExists(candidate, excludeId)) {
    candidate = `${baseSlug}-${suffix}`
    suffix += 1
  }

  return candidate
}

function insertPost(post) {
  db.prepare(
    `INSERT INTO posts (id, slug, title, body_markdown, header_image, published, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    post.id,
    post.slug,
    post.title,
    post.bodyMarkdown,
    post.headerImage,
    post.published ? 1 : 0,
    post.createdAt,
    post.updatedAt,
  )
}

function updatePostRow(id, post) {
  db.prepare(
    `UPDATE posts SET slug = ?, title = ?, body_markdown = ?, header_image = ?, published = ?, updated_at = ?
     WHERE id = ?`,
  ).run(post.slug, post.title, post.bodyMarkdown, post.headerImage, post.published ? 1 : 0, post.updatedAt, id)
}

function deletePostRow(id) {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function slugify(input) {
  const slug = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return slug || 'post'
}

function excerptFromMarkdown(markdown, maxLength = 180) {
  const plain = String(markdown || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (plain.length <= maxLength) {
    return plain
  }

  return `${plain.slice(0, maxLength).trim()}…`
}

function jsonResponse(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function textResponse(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  })
  response.end(body)
}

async function readRawBody(request, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0

    request.on('data', (chunk) => {
      totalBytes += chunk.length

      if (totalBytes > maxBytes) {
        reject(new Error('Request body is too large.'))
        request.destroy()
        return
      }

      chunks.push(chunk)
    })

    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const rawBody = await readRawBody(request)

  if (!rawBody.length) {
    return {}
  }

  try {
    return JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new Error('Request body is not valid JSON.')
  }
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie

  if (!cookieHeader) {
    return {}
  }

  return cookieHeader.split(';').reduce((cookies, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=')
    cookies[rawKey] = decodeURIComponent(rawValue.join('='))
    return cookies
  }, {})
}

// ---------------------------------------------------------------------------
// Admin auth -- one shared password, HMAC-signed session cookie. No 2FA;
// the stakes here are a blog, not payment data.
// ---------------------------------------------------------------------------
const COOKIE_NAME = 'kevin_admin'
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12
const COOKIE_SECURE_ATTR = APP_URL.startsWith('https://') ? '; Secure' : ''

function passwordMatches(candidate) {
  const expected = Buffer.from(ADMIN_PASSWORD)
  const actual = Buffer.from(String(candidate || ''))

  if (actual.length !== expected.length) {
    // Still do a constant-time compare of matching length so a wrong-length
    // guess doesn't return measurably faster than a right-length one.
    timingSafeEqual(Buffer.alloc(expected.length), Buffer.alloc(expected.length))
    return false
  }

  return timingSafeEqual(actual, expected)
}

function createSignature(value) {
  return createHmac('sha256', SESSION_SECRET).update(value).digest('hex')
}

function buildSessionCookieToken() {
  const expiresAt = Date.now() + SESSION_DURATION_MS
  const payload = JSON.stringify({ expiresAt, nonce: randomBytes(12).toString('hex') })
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url')
  const signature = createSignature(encodedPayload)

  return { token: `${encodedPayload}.${signature}`, expiresAt }
}

function validateSessionCookie(value) {
  if (!value || !value.includes('.')) {
    return false
  }

  const [encodedPayload, signature] = value.split('.')
  const expectedSignature = createSignature(encodedPayload)

  try {
    const actualBuffer = Buffer.from(signature, 'hex')
    const expectedBuffer = Buffer.from(expectedSignature, 'hex')

    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return false
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    return Number(payload.expiresAt) > Date.now()
  } catch {
    return false
  }
}

function sessionCookieHeader(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${COOKIE_SECURE_ATTR}; Max-Age=${maxAge}`
}

function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${COOKIE_SECURE_ATTR}; Max-Age=0`
}

function requireAdmin(request, response) {
  const cookies = parseCookies(request)

  if (!validateSessionCookie(cookies[COOKIE_NAME])) {
    jsonResponse(response, 401, { error: 'Unauthorized.' }, { 'Set-Cookie': clearSessionCookieHeader() })
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Header image upload -- client sends a base64 data URL (same pattern as
// Matsumoto's product image uploads), server decodes and writes it to disk.
// ---------------------------------------------------------------------------
const IMAGE_EXTENSION_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

function saveHeaderImage(dataUrl, postId) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''))

  if (!match) {
    throw new Error('Header image must be a valid image file.')
  }

  const [, mimeType, base64Body] = match
  const extension = IMAGE_EXTENSION_BY_TYPE[mimeType]

  if (!extension) {
    throw new Error('Header image must be JPEG, PNG, or WebP.')
  }

  const buffer = Buffer.from(base64Body, 'base64')

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('Header image is larger than 6 MB.')
  }

  const fileName = `${postId}-${Date.now()}${extension}`
  const filePath = path.join(UPLOADS_DIR, fileName)
  writeFileSync(filePath, buffer)

  return `/uploads/${fileName}`
}

function deleteHeaderImageIfLocal(headerImagePath) {
  if (!headerImagePath || !headerImagePath.startsWith('/uploads/')) {
    return
  }

  const fileName = headerImagePath.replace('/uploads/', '')
  const filePath = path.join(UPLOADS_DIR, fileName)

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } catch (error) {
    console.error('[uploads] failed to remove', filePath, error)
  }
}

// ---------------------------------------------------------------------------
// Post payload validation
// ---------------------------------------------------------------------------
function validatePostPayload(body) {
  const errors = []

  if (!String(body.title || '').trim()) {
    errors.push('Enter a title.')
  }

  if (!String(body.bodyMarkdown || '').trim()) {
    errors.push('Enter the post body.')
  }

  return errors
}

function publicPost(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    bodyMarkdown: post.bodyMarkdown,
    headerImage: post.headerImage,
    excerpt: excerptFromMarkdown(post.bodyMarkdown),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const STATIC_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

function serveFile(response, filePath, method) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    textResponse(response, 404, 'Not found.')
    return
  }

  const extension = path.extname(filePath).toLowerCase()
  const contentType = STATIC_MIME_TYPES[extension] || 'application/octet-stream'
  const size = statSync(filePath).size
  const headers = {
    'Content-Type': contentType,
    'Content-Length': size,
  }

  if (method === 'HEAD') {
    response.writeHead(200, headers)
    response.end()
    return
  }

  response.writeHead(200, headers)
  createReadStream(filePath).pipe(response)
}

const PAGE_ROUTES = {
  '/': 'index.html',
  '/about': 'about.html',
  '/blog': 'blog.html',
  '/physical-media': 'physical-media.html',
  '/admin': 'admin.html',
}

// URL.pathname keeps percent-encoding as-is (e.g. a literal "%20") rather
// than decoding it -- needed here since several asset folders have real
// spaces in their names on disk.
function decodeUrlPath(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

function normalizePath(pathname) {
  if (!pathname || pathname === '/') {
    return '/'
  }

  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (request, response) => {
  // Baseline security headers on every response.
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'SAMEORIGIN')
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (APP_URL.startsWith('https://')) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  const requestUrl = new URL(request.url || '/', `http://${request.headers.host}`)
  const pathname = normalizePath(requestUrl.pathname)
  const method = request.method

  try {
    // ---- Public post API ----
    if (method === 'GET' && pathname === '/api/posts') {
      jsonResponse(response, 200, { posts: listPublishedPosts().map(publicPost) })
      return
    }

    if (method === 'GET' && pathname.startsWith('/api/posts/')) {
      const slug = decodeURIComponent(pathname.replace('/api/posts/', ''))
      const post = getPostBySlug(slug)

      if (!post) {
        jsonResponse(response, 404, { error: 'Post not found.' })
        return
      }

      jsonResponse(response, 200, { post: publicPost(post) })
      return
    }

    // ---- Admin auth ----
    if (method === 'POST' && pathname === '/api/admin/login') {
      const body = await readJsonBody(request)

      if (!passwordMatches(body.password)) {
        jsonResponse(response, 401, { error: 'Password does not match.' })
        return
      }

      const { token, expiresAt } = buildSessionCookieToken()
      jsonResponse(
        response,
        200,
        { authenticated: true },
        { 'Set-Cookie': sessionCookieHeader(token, expiresAt) },
      )
      return
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
      jsonResponse(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookieHeader() })
      return
    }

    if (method === 'GET' && pathname === '/api/admin/session') {
      const cookies = parseCookies(request)
      jsonResponse(response, 200, { authenticated: validateSessionCookie(cookies[COOKIE_NAME]) })
      return
    }

    // ---- Admin post management ----
    if (method === 'GET' && pathname === '/api/admin/posts') {
      if (!requireAdmin(request, response)) return
      jsonResponse(response, 200, { posts: listAllPosts() })
      return
    }

    if (method === 'POST' && pathname === '/api/admin/posts') {
      if (!requireAdmin(request, response)) return

      const body = await readJsonBody(request)
      const errors = validatePostPayload(body)

      if (errors.length) {
        jsonResponse(response, 400, { errors })
        return
      }

      const id = randomUUID()
      const now = new Date().toISOString()
      const baseSlug = slugify(body.slug || body.title)
      const slug = uniqueSlug(baseSlug)

      let headerImage = null
      if (body.headerImageDataUrl) {
        try {
          headerImage = saveHeaderImage(body.headerImageDataUrl, id)
        } catch (error) {
          jsonResponse(response, 400, { error: error.message })
          return
        }
      }

      const post = {
        id,
        slug,
        title: String(body.title).trim(),
        bodyMarkdown: String(body.bodyMarkdown),
        headerImage,
        published: body.published !== false,
        createdAt: now,
        updatedAt: now,
      }

      insertPost(post)
      jsonResponse(response, 200, { post })
      return
    }

    if (method === 'PUT' && pathname.startsWith('/api/admin/posts/')) {
      if (!requireAdmin(request, response)) return

      const id = pathname.replace('/api/admin/posts/', '')
      const existingPost = getPostById(id)

      if (!existingPost) {
        jsonResponse(response, 404, { error: 'Post not found.' })
        return
      }

      const body = await readJsonBody(request)
      const errors = validatePostPayload(body)

      if (errors.length) {
        jsonResponse(response, 400, { errors })
        return
      }

      const baseSlug = slugify(body.slug || body.title)
      const slug = uniqueSlug(baseSlug, id)

      let headerImage = existingPost.headerImage
      if (body.headerImageDataUrl) {
        try {
          headerImage = saveHeaderImage(body.headerImageDataUrl, id)
          deleteHeaderImageIfLocal(existingPost.headerImage)
        } catch (error) {
          jsonResponse(response, 400, { error: error.message })
          return
        }
      } else if (body.removeHeaderImage) {
        deleteHeaderImageIfLocal(existingPost.headerImage)
        headerImage = null
      }

      const updatedPost = {
        ...existingPost,
        slug,
        title: String(body.title).trim(),
        bodyMarkdown: String(body.bodyMarkdown),
        headerImage,
        published: body.published !== false,
        updatedAt: new Date().toISOString(),
      }

      updatePostRow(id, updatedPost)
      jsonResponse(response, 200, { post: updatedPost })
      return
    }

    if (method === 'DELETE' && pathname.startsWith('/api/admin/posts/')) {
      if (!requireAdmin(request, response)) return

      const id = pathname.replace('/api/admin/posts/', '')
      const existingPost = getPostById(id)

      if (!existingPost) {
        jsonResponse(response, 404, { error: 'Post not found.' })
        return
      }

      deleteHeaderImageIfLocal(existingPost.headerImage)
      deletePostRow(id)
      jsonResponse(response, 200, { ok: true })
      return
    }

    // ---- Uploaded images ----
    if ((method === 'GET' || method === 'HEAD') && pathname.startsWith('/uploads/')) {
      const targetPath = path.join(UPLOADS_DIR, decodeUrlPath(pathname.replace('/uploads/', '')))
      const resolvedTarget = path.resolve(targetPath)

      if (!resolvedTarget.startsWith(path.resolve(UPLOADS_DIR))) {
        textResponse(response, 403, 'Forbidden.')
        return
      }

      serveFile(response, resolvedTarget, method)
      return
    }

    // ---- Pretty page URLs + a real blog post URL per slug ----
    if (method === 'GET' || method === 'HEAD') {
      if (pathname.startsWith('/post/')) {
        serveFile(response, path.join(__dirname, 'post.html'), method)
        return
      }

      if (PAGE_ROUTES[pathname]) {
        serveFile(response, path.join(__dirname, PAGE_ROUTES[pathname]), method)
        return
      }

      // Any other real file in the project root (styles.css, assets/*,
      // favicons, robots.txt, etc.), guarded against path traversal.
      const candidatePath = path.resolve(path.join(__dirname, decodeUrlPath(pathname)))

      if (
        candidatePath.startsWith(__dirname) &&
        existsSync(candidatePath) &&
        statSync(candidatePath).isFile()
      ) {
        serveFile(response, candidatePath, method)
        return
      }
    }

    textResponse(response, 404, 'Not found.')
  } catch (error) {
    console.error('[request-error]', method, pathname, error)
    jsonResponse(response, 500, { error: 'Something went wrong.' })
  }
})

server.listen(PORT, () => {
  console.log(`Kevin McCune site listening on http://localhost:${PORT}`)
})
