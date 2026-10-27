# Academic Schedule — Frontend

Plain HTML, CSS, and vanilla JavaScript (native ES modules). No framework,
no bundler, no build step. Every `.js` file here is loaded directly by the
browser via `<script type="module">`.

## Structure

```
client/
  pages/      one real HTML file per screen (spec section 80's route list)
  js/         shared modules (api-client, auth-state, nav-config, ui, theme)
    pages/    one script per page, importing the shared modules above
  css/        tokens.css (design tokens) -> base.css -> components.css -> layout.css
  components/ (reserved for future markup partials, if a page needs one)
  assets/     (reserved for images/icons, empty for now)
```

## Running it locally

This is a static site — any static file server works, pointed at this
`client/` folder as the webroot (so that `/css/...`, `/js/...`,
`/pages/...` resolve correctly as root-relative paths). For example:

```bash
cd client
npx serve .
# or: python3 -m http.server 8080
```

Then open `http://localhost:<port>/pages/login.html`.

## Connecting to the backend

The backend uses an HTTP-only session cookie for authentication (Master
Specification section 69) — there is no token for this frontend to read
or store. `server/app.js` already has CORS configured with
`credentials: true` and an allow-list read from the `CORS_ORIGIN`
environment variable (`server/config/env.js`). For the browser to send
and receive that cookie when this client is served from a different
origin/port than the backend, **`CORS_ORIGIN` on the backend must
include this client's exact origin** (e.g. `http://localhost:8080`).

- `js/config.js` sets `apiBaseUrl`. Leave it as `''` (same-origin
  relative `/api/...` calls) if something ends up serving this client
  from the same origin as the backend; otherwise set it to the
  backend's URL, e.g. `'http://localhost:3000'`.
- No backend file was changed to make this work — only `CORS_ORIGIN`
  (an environment variable, not code) needs to match wherever this
  client is actually served from.

## What's implemented so far (frontend foundation phase)

- Shared API client (`js/api-client.js`) — every fetch, JSON handling,
  and error normalization goes through here.
- Shared auth state (`js/auth-state.js`) — login/logout/me, role
  helpers, session-expired and maintenance-mode events.
- Design tokens + base/component/layout CSS (`css/`).
- Role-aware nav data (`js/nav-config.js`) — not wired into any page
  yet; no authenticated page exists yet to host it.
- The Login page (`pages/login.html` + `js/pages/login.js`) — the only
  complete screen so far.

Every other page in spec section 80's route list is **not built yet** —
that's later frontend-phase work. A successful login will correctly
compute and navigate to the right dashboard URL for the user's role, but
that destination page will 404 until its phase builds it. This is
expected, not a bug.
