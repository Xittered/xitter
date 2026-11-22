# AGENTS.md

Notes for coding agents (and people) working on Xitter. Read this and
[CONTRIBUTING.md](CONTRIBUTING.md) before changing code. The README covers
what Xitter does and how to run an instance.

## What this is

Xitter is a backend for the **real x.com web client**. We don't write a
frontend: a pinned build of X's own client is downloaded per instance, its
hard-coded hosts are rewritten as it is served, and every call it makes lands
on this Bun + PostgreSQL server, which answers in X's exact response shapes.
The same goes for X's sign-in screens (a binary format called Jetfuel) and its
end-to-end encrypted chat app (XChat).

So most work is: find what the client asks for and what shape it expects, then
answer it from our own data.

## Never commit or paste

- `client/`: X's proprietary client bundle. Each instance fetches its own.
- `har-raw/`, `samples/`: browser captures. They hold live cookies, passwords,
  other people's posts and encrypted chats. Read samples only through
  `scripts/sample-shape.ts` / `scripts/thrift-shape.ts`, which print structure,
  not values.
- `data/`: federation key, chat token and Juicebox secrets, uploaded branding.
- `.env`, `realm.env`, an x.com `auth_token`, database dumps.
- `*.local.md`: personal notes, git-ignored.

All of these are in `.gitignore`; keep it that way.

## Layout

| Where | What |
|---|---|
| `src/server.ts` | `Bun.serve`: routing, CSP, public files, media, GraphQL dispatch, chat socket, `/juicebox` proxy |
| `src/build.ts`, `client-cache.ts`, `client-update.ts`, `scripts/fetch-client.ts` | The pinned client build; files come from abs.twimg.com on first use into `client/` |
| `src/patch.ts`, `reply-control-client.ts` | String patches applied to client JS as it is served (read the next section first) |
| `src/shell.ts`, `tidy.ts` | The boot page (`__INITIAL_STATE__`, feature switches, claims) and the CSS/JS that hides features switched off |
| `src/graphql.ts`, `rest.ts`, `public-api.ts` | GraphQL operations by name, REST (`1.1/`, `2/`), the public JSON API at `/api/v1` |
| `src/model.ts` | Our rows to X's response shapes |
| `src/posts.ts`, `users.ts`, `ranking.ts`, `search.ts`, `notifications.ts`, `lists.ts`, `communities.ts`, ... | Features, one file each |
| `src/media.ts`, `video.ts`, `media-compress.ts` | Uploads, the ffmpeg queue, optional compression |
| `src/auth.ts`, `accounts.ts`, `onboarding.ts`, `jetfuel*.ts`, `src/jf/` | Sessions and cookies, several accounts, X's sign-in dialog |
| `src/chat.ts`, `chat-media.ts`, `thrift.ts` | XChat |
| `src/federation*.ts`, `superadmin*.ts`, `migration*.ts` | Instance-to-instance federation and moving accounts |
| `src/admin.ts`, `admin-tools.ts`, `admin.html`, `staff-permissions.ts` | The admin panel (one HTML file, its actions, who may run them) |
| `src/settings.ts` | Instance settings with their defaults |
| `src/schema.sql` | Every table. Idempotent, runs on each start |
| `scripts/` | Test scripts, the client fetcher, admin helpers |
| `public/` | Logos and icons |

## How the client is hosted (read before touching `patch.ts`)

- The main client and the chat app are served from `/abs/*`, patched at
  serve time by `patchText()`. The downloaded archive stays as it came.
- `RULES` apply to every file; `CHAT_RULES` only to `/x-web/xchat/` files.
- **Never add a broad host rewrite to `RULES`.** The client decides whether to
  send auth headers by comparing hosts (`if ("https://ton.x.com" === r.host)
  return i(r)` sends without them). Rewriting `ton.x.com` everywhere once made
  every request go out without `authorization` and `x-csrf-token`: 403 on
  everything. Before adding a global rule, diff `patchText()` output before and
  after over all `client/abs/responsive-web/client-web/*.js` and read every
  change.
- Patches are regexes over minified code. Bound them (`[\s\S]{0,N}?`, not
  `[\s\S]*?`) and skip files that can't contain the target, or the first load of
  a big bundle crawls.
- Never give a signed-in client a guest token: it switches to guest mode and
  stops sending its CSRF header.

## Finding what the client wants

- `LOG_REQUESTS=1` logs every API call; unhandled ones print `unhandled ...`.
  `GET /_debug/unknown` (admins) lists calls no handler answers, most frequent
  first. Start there when a screen is empty.
- Response shapes: grep the client bundle for the reader code
  (`e?.user?.result?...`) and for `operationName:"..."`. Relay queries carry
  their whole field tree in the bundle, which gives exact shapes.
- emusks (AGPL, in `node_modules/emusks`) is a reverse-engineered X client:
  request shapes, Jetfuel, XChat crypto and frames. Xitter is AGPL too, so its
  code may be used.

## Protocol notes

- **Jetfuel** (sign-in screens): binary UI trees, codec in `src/jetfuel.ts`.
  Templates are captured screens in `src/jf/*.json` with placeholders.
  Element and prop names are MurmurHash3-32 (seed 0), low 16 bits signed.
  Errors must come back as an `ActionResponder` root (`fieldError()` in
  `onboarding.ts`); re-sending the first screen breaks the dialog.
- **XChat**: everything is encrypted in the browser. The server stores sealed
  Thrift events and only adds what it knows (`stamp()`: sequence id, sender,
  conversation id and token, time). `src/thrift.ts` keeps wire types so blobs
  round-trip exactly. Socket frames are Thrift structs. The chat app sends
  GraphQL `variables` as a JSON string, and Relay needs exact `__typename`s on
  unions.
- **Juicebox** (chat passcode backup): realm tokens are HS256 JWTs; the chat
  app trusts only pinned realms, so `realm-a.x.com` is patched to our
  `/juicebox/` proxy, which must pass the SDK's headers.

## Gotchas

- Equicoins (`src/money*.ts`) are play money with no cash value. Don't treat
  them as real funds: no extra safeguards for "moving money", and impersonating
  superadmins may do anything the account can, Equicoins included.
- The client is strict about types: `timestamp_ms` must be a number, typeahead
  needs every empty list (`cashtags: []`), notification URLs need
  `urlType: "ExternalUrl"`.
- It treats only `x.com` / `twitter.com` links as its own; a link meant to stay
  in the app uses `https://x.com/<path>`.
- GraphQL errors: the client reads the code from `extensions.code` and shows
  the message after its first `": "`. `runOperation` builds that shape.
- Bun SQL has no `sql.json`: insert jsonb as `${JSON.stringify(x)}::text::jsonb`.
- Bun answers a `Range` header by itself when a response body comes from a
  file, even as a stream, and ignores `If-Range`; pipe it through a
  `TransformStream` to send the whole file.
- Settings load at start and are cached: after changing them in the database
  directly, call `loadSettings()` or restart.
- Import modules by relative path inside the repo. The same file imported by
  two different paths (`C:/...` and `../src/...`) loads twice, with two copies
  of its state.
- Windows: run scripts with Git Bash `sh`; Git Bash rewrites arguments that
  start with `/` (set `MSYS_NO_PATHCONV=1`); Bun can't read `/tmp`; heredocs
  eat backslashes, so write code with an editor, not `cat <<EOF`.

## Testing

See [CONTRIBUTING.md](CONTRIBUTING.md#tests). In short:

- `bun run test:unit` needs no server or database.
- The database and HTTP suites in `.github/workflows/tests.yml` need a
  throwaway PostgreSQL database whose name contains `test` (the scripts refuse
  anything else) and, for the HTTP ones, a running server.
  `sh scripts/ci-local.sh` runs the same list locally.
- A passing script is not a working screen. Check UI changes in the real
  client: `bun scripts/drive.ts <path> <steps...>` clicks through it in
  headless Edge and takes screenshots.

## Style

- Match the code around you: tabs, double quotes, small functions, plain SQL
  through Bun's `sql`.
- Comments are few and say *why*: a gotcha, a protocol fact, a reason. No
  comments that narrate what the next line does.
- Commit messages: a short subject, then a body saying what changed and why.
  No marketing language.
- New tables and columns go in `src/schema.sql` as idempotent statements
  (`create ... if not exists`, `alter ... add column if not exists`).
- User-facing text follows X's wording where X has a screen for it.
