# Kevin McCune and the Twine

Static link site for the band, plus a small Node backend for the blog.

## Why this setup

- Still separate from the Matsumoto storefront, so you don't risk breaking that app.
- No frontend build step -- plain HTML/CSS/JS, same as before.
- One small dependency-free Node server (`server.js`) now exists, just to handle
  blog posts: it serves the static pages, a JSON API for posts, and a
  password-gated upload page at `/admin`.

## Local start

1. Copy `.env.example` to `.env.local` and set a real `ADMIN_PASSWORD` and
   `SESSION_SECRET`.
2. `npm start` (no dependencies to install -- it's plain Node).
3. Open `http://localhost:3100`.

## Structure

- `index.html`: main links page
- `about.html`: short bio page
- `blog.html`: blog post listing, fetched from `/api/posts`
- `post.html`: a single blog post, served at `/post/<slug>`
- `admin.html`: password-gated page to write/edit/delete posts, at `/admin`
- `physical-media.html`: placeholder merch/media page
- `styles.css`: shared retro styling
- `server.js`: the backend -- static file serving, the post API, and admin auth
- `data/`: SQLite database + uploaded header images (gitignored, created on
  first run -- **not persisted across a redeploy unless the host gives this
  directory a real persistent volume**)

## Blog posts

Posts are written in Markdown with one optional header image, from `/admin`.
A post can be saved as a draft (left out of `/api/posts` and `/blog` until you
check "Published"). Deleting a post also deletes its uploaded image.

## Hosting

Needs an actual Node process now (not a static host) for the blog to work --
the links pages alone would still work static, but `/admin` and `/blog` need
`server.js` running. A small Railway service (its own, separate from
Matsumoto) is the plan. Whichever host you pick, it needs:

- `ADMIN_PASSWORD`, `SESSION_SECRET`, and `APP_URL` set as real environment
  variables (see `.env.example`).
- A persistent volume/disk mounted at the `data/` directory (or set `DATA_DIR`
  to wherever the host's persistent storage lives) -- otherwise every
  redeploy wipes the blog.
