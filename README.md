# Xitter

A self-hosted backend for the X (Twitter) web client. The server hosts a pinned
build of the official client from your own domain and answers its API from
Postgres, so the real x.com interface runs against your own instance.

The client itself is not in this repository. Each instance downloads its own
copy during setup, and it stays on that machine.

## What works

- Posting, replies, quotes, reposts, likes, bookmarks (with folders), pinned
  posts, pinned replies, highlights, @mentions and hashtags; editing posts, polls, scheduling,
  places
- Who can reply (everyone, followed accounts, verified, mentioned), post views,
  reposts, likes and quotes lists
- Images, GIFs and video (converted with ffmpeg), alt text, content warnings on
  media, long-form articles
- Profiles with all their tabs, editing, follows, followers, private
  (protected) accounts with follow requests, "About this account" with the
  country or region it is based in
- Lists (with banners) and communities (rules, members, moderation tools,
  custom banners, a topic from the instance's topics, community label on posts)
- Home timeline: a ranked "For you" and a chronological "Following"
- Notifications with unread counts, browser push (with the instance's own VAPID
  key, made on first start in `data/push-vapid.json`); the profile bell (new posts from that
  account arrive as notifications) and turning an account's reposts off
- Search with X's operators, trends, Explore; trends by location (Explore
  settings: worldwide, a country, or yours with "Trends for you")
- News and sports cards at the top of Explore, written by staff (Admin >
  Explore cards); sports cards are scoreboards you update as the game goes
- Topics: staff define them with keywords; people follow them from "Topics to
  follow" or a post's menu, and "For you" brings in and labels matching posts
- Blocks, mutes and muted words
- Who to follow and "You might like" ranked by shared follows, with accounts
  like the profile you're on; uploaded contacts (Settings > Contacts) for people
  who let themselves be found by email
- Direct messages, end-to-end encrypted, with key backup
- Community Notes
- Invite-only sign-up with a required email (proven with a mailed 6-digit code
  when mail is set up; Settings > Email changes it by a confirmation link), pride flag badges, organisations
  with affiliates, several signed-in accounts
- Account settings: password change, username change, language, deactivation
  (reactivates on sign-in within 30 days), data archive, email notification
  settings (activity and new-message digests, sent while you're away), sessions
  list with revoke, account access history (each sign-in
  with its app and address), two-factor sign-in with an
  authenticator app and backup codes, password reset by email
- Reporting posts and accounts
- Account analytics (Overview, Content and each post's page) from the
  instance's own counts
- Sticker packs made by staff (Admin > Stickers), picked from a button beside
  the composer's emoji button and posted as images
- Branded hashtags (X's branded likes and hashmoji, Admin > Branded
  hashtags): for a set time, liking a post with the hashtag plays a custom
  Lottie animation, and the hashtag shows an emoji (optionally with hashfetti)
- Polls with a photo on each choice
- Staff labels under posts, as X shows them: Visibility limited (also kept out
  of For you and search), Misleading, Stay informed, Get the latest, Legally
  required notice; staff can also set the counts a post or profile shows
- Admin > Feature switches: any of the client's own switches, set for everyone
- Rate limits per account and address (`src/ratelimit.ts`)
- A public JSON API under `/api/v1` with personal tokens (`/account/api`,
  read or read and write); `/api` documents it
- An admin panel at `/admin`: users, standing (restrict, limit, suspend),
  badges (blue, gold organisation, grey government organisation or official),
  translator globes (blue translator, gold translator moderator, yellow approver),
  roles, organisations, posts, reports, invites, instance settings,
  feature switches, announcements, topics, Explore cards and an audit log

Not built yet: Spaces and live video, Moments, signing in other apps (Connected
apps stays empty). Email is sent through
[Resend](https://resend.com) when `RESEND_API_KEY` is set; Admin > Email sends
a test mail (it shows Resend's answer, e.g. an unverified domain) and lists
every mail tried.

## Running it locally

### What you need

- [Bun](https://bun.sh) 1.4 or newer
- PostgreSQL 14 or newer, with an empty database
- Optional: [ffmpeg](https://ffmpeg.org) on the PATH, for video uploads

### Steps

```sh
git clone https://github.com/Xittered/xitter
cd xitter
bun install

# 1. a database (any name; set DATABASE_URL if it isn't the default below)
createdb xitter
export DATABASE_URL=postgres://<user>@localhost:5432/xitter

# 2. download a client build (no X account needed)
bun scripts/fetch-client.ts

# 3. the first account, made an admin
bun scripts/create-user.ts <name> <password> "<display name>"
bun scripts/make-admin.ts <name>

# 4. run
bun src/server.ts
```

Open `http://localhost:3000` and sign in with the client's own form. The
tables are created on the first start.

More accounts: make invite codes in the admin panel (`/admin` > Invites) or with
`bun scripts/invite.ts`. On the sign-in form, a username that doesn't exist yet
starts sign-up and asks for the code; an invite link (`/signup?code=<code>`)
fills it in.

On Windows, run the commands in Git Bash or set the variables with
`$env:DATABASE_URL = "..."` in PowerShell.

Without an account the script pins the build x.com gives signed-out visitors
at `/i/tweetdeck`, with the guest set of feature switches. `--latest` re-pins
the current build. `--token <auth_token>` (the cookie from a signed-in x.com
tab) or `--har <file>` pins the signed-in page instead, with that account's
switches; nothing about the account is kept.

### With Docker Compose

`compose.yaml` runs Xitter and Postgres 18, with ffmpeg and `pg_dump` in the
image. The client is downloaded into its volume on the first start.

```sh
docker/env.sh                  # writes .env with fresh secrets; edit PUBLIC_ORIGIN, HOST_PORT, mail keys there
docker compose up -d --build
docker compose exec app bun scripts/create-user.ts <name> <password> "<display name>"
docker compose exec app bun scripts/make-admin.ts <name>
```

Add `--profile keybackup` to `up` to also run the Juicebox realm for chat
passcode recovery (built from `deploy/juicebox`, with its own Postgres); its
realm ID and tenant secret come from `.env`, so keep that file and back it up
with the volumes (`db`, `client`, `media`, `data`, `realm-db`). Other scripts
run the same way, e.g. `docker compose exec app bun scripts/invite.ts`, and
any variable from the Configuration table can be added to `.env`.
`FETCH_CLIENT=0` skips the first-start download; `docker compose exec app bun
scripts/fetch-client.ts --latest` re-pins the build.

### Keep these private

- An `auth_token` cookie is a live login to your X account. Use it only for
  `fetch-client.ts` and don't share it.
- `client/` holds X's own client code. It is downloaded per instance and must
  not be committed or shared.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://dev@localhost:5432/xitter` | Postgres connection |
| `PORT` | `3000` | Listen port |
| `PUBLIC_ORIGIN` | `http://localhost:$PORT` | Address browsers use to reach the instance |
| `CLIENT_DIR` | `client` | Where the pinned client is stored |
| `MEDIA_DIR` | `media` | Uploaded images and videos |
| `BRANDING_DIR` | `data/branding` | Logos uploaded in the admin panel |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | Video tools |
| `MAX_VIDEO_MB`, `MAX_VIDEO_SECONDS` | `200`, `600` | Starting video limits (changeable in the panel) |
| `SOURCE_URL` | this repository | The source link shown to users |
| `LOG_REQUESTS` | unset | `1` logs every API call, `errors` also prints the client's error reports |
| `RATE_LIMITS` | on | `off` turns the rate limits off (for the test scripts; limits are in `src/ratelimit.ts`, `scripts/test-ratelimit.ts` checks them) |
| `EMBED_PROXY` | `https://cors.estrogen.delivery/` | where link previews are fetched from and their images served, as `<proxy>?url=<link>`, so neither the instance nor its readers reach the linked site |
| `JUICEBOX_URL` | `http://localhost:8580` | Private address of the key-backup realm, proxied through `/juicebox/` |
| `CHAT_TOKEN_SECRET` | saved in `data/chat-secrets.json` | Signing secret for chat socket tokens |
| `JUICEBOX_REALM_ID`, `JUICEBOX_TENANT_SECRET` | saved in `data/chat-secrets.json` | Stable realm identity and tenant signing secret |
| `MAX_CHAT_MEDIA_MB` | `200` | Maximum encrypted chat attachment size |
| `RESEND_API_KEY` | unset | Resend key for password-reset and notification mail; without it nothing is sent |
| `MAIL_FROM` | `Xitter <noreply@xit.chococat.lol>` | Sender of that mail (the domain must be verified in Resend) |
| `KLIPY_API_KEY` | unset | GIF search through [Klipy](https://klipy.com) (see `src/gifs.ts`); without it the GIF button is hidden |

Everything else (name, sign-up mode, features, limits, announcement, rules,
logos) is set in the admin panel.

## Encrypted chat and key backup

Chat encrypts messages and attachments in the browser. Xitter keeps ciphertext,
public keys, membership and event history. Images, videos and files use the same
multipart ciphertext store under `MEDIA_DIR/chat`; downloads require membership.
Requests from accounts you do not follow stay separate until accepted. Group
creation, membership changes, edits, reactions, read receipts and typing use the
pinned client's XChat events.

Passcode recovery requires a Juicebox software realm. `deploy/juicebox` builds
upstream commit `2e485aac584a6c9ada1fb9f156dc4d7cad3ab338` with our Postgres
provider patch. It is also AGPL. The compose stack has its own persistent Postgres
volume and binds the realm to `127.0.0.1:8580`, with no public database port.

Start Xitter once to generate `data/chat-secrets.json`, then prepare the private
configuration and run the stack from the project root:

```sh
bun scripts/prepare-realm.ts deploy/juicebox
docker compose -f deploy/juicebox/compose.yaml -p xitter-juicebox up --build -d
```

`realm.env` is ignored by Git; the preparation script refuses to overwrite an
existing configuration. Keep the realm ID, signing secret and database password
stable. Back up the Postgres volume together with that configuration. Changing
the realm ID or losing its database prevents recovery of existing chat keys.
If Xitter runs inside Docker, connect it to the realm's network and set
`JUICEBOX_URL=http://realm:8580`; browsers continue using Xitter's authenticated
same-origin proxy. The local development realm and the server realm have separate
record stores: starting a server realm does not transfer local backups.

## Development

### Client apps and Community Notes

A post's page shows the app it came from after its time ("11:21 PM · Oct 14,
2026 · Xitter for Web"). Admins create and revoke app tokens under **Client
apps**, with a label such as `Xitter for Android`. The token is shown once; the
database stores its SHA-256 hash. The app sends it as `Authorization: Bearer
<token>` alongside the user's session cookies and CSRF header. It names the app,
not the user, and grants no account access. Revoking a token rejects later
requests using it; posts made with it keep their label. Requests from the
browser client are `Xitter for Web`.

Community Notes use the pinned client's native viewing, writing and rating
screens. Admins grant or revoke **Community Notes writing access** under a
user's Access section. Writing is denied by default and enforced server-side.
Contributors have random aliases independent of their handles. Signed-in active
users can request notes and rate other people's notes; authors cannot rate their
own notes. Requests and ratings are deduplicated. Authors can delete their notes;
admins and moderators can remove notes, with staff removals recorded in the audit
log. Blocked accounts cannot interact through notes.

The current local scoring rule needs at least three ratings, with two thirds
Helpful, before a misleading-post note is displayed as native context. Ratings
from suspended accounts are excluded. This is not X's matrix-factorization scoring
system. Media-match notes, automated translation and appeals are not implemented.

Run `bun scripts/test-notes.ts` against the development server with the existing
`pozo`/`goldcorp` test accounts. It creates temporary posts, tokens and voters,
restores writing access, and removes its fixtures.

### Moderation

Besides reports and standings, staff can send an account a message, warning or
strike. It arrives in the account's Notifications tab and opens a page where a
warning or strike can be appealed; a suspended account appeals at `/appeal`
with its password. Standings can be temporary (they lift on their own). Staff
keep private notes on accounts, see and end sessions, hide posts and articles
(staff still see them), mark media sensitive (X's content warning), give
accounts custom badges and delete uploads. Settings also hold maintenance mode
(everyone but staff sees a message), blocked phrases, hidden and promoted
trends, and a post pinned to the top of every home timeline.
`bun scripts/test-admin-extra.ts` checks these.

The automod (`src/hate.ts`) refuses slurs, explicit hate, transphobia and
abuse like "kill yourself" in posts, replies, scheduled posts, profiles, names,
polls, image descriptions, lists, communities, articles and Community Notes.
It reads through look-alike letters from other alphabets, Unicode styles,
leetspeak, invisible characters, accents, repeated letters, letters spelled
out one by one and reversed or upside-down text. Reclaimed queer words pass
unless the text attacks someone, and NSFW text isn't touched. DMs are end-to-end
encrypted, so the server can't read them. Each refusal is an appealable
strike, and strikes, from staff or automatic, follow a ladder set in
Settings > Automod (by default a warning, a day, a week, 30 days, then
permanent). `bun test ./scripts/test-hate.ts` checks evasions and false
positives without a server; `bun scripts/test-automod.ts` checks the ladder,
expiry, write paths and request limits against one.

- `GET /_debug/unknown` lists the client calls no handler answers yet, most
  frequent first. Start there when a screen is empty.
- `scripts/test-*.ts` check each feature end to end against a running server,
  for example `bun scripts/test-posts.ts <user A> <user B> <password>`. Each
  script's first lines give its arguments.
- `bun scripts/test-chat.ts` creates and removes temporary users and checks
  encryption with emusks, access controls, requests, groups, socket delivery,
  attachments and history. `bun test ./scripts/test-chat-token.ts` checks token
  validation without a running server. `bun scripts/test-juicebox.ts` verifies
  realm registration and recovery; run it with `recover` after a realm/database
  restart to check durability (`TEST_JUICEBOX_URL` selects the realm).
- Other checks: `test-account-settings`, `test-two-factor`, `test-password-reset`,
  `test-reply-limits`, `test-views`, `test-protected`, `test-communities`, `test-lists`,
  `test-polls`, `test-scheduled` and the rest of `scripts/test-*.ts`. A passing
  script is not a working screen: check the UI with `drive.ts` too.
- Where the account's country comes from: the `CF-IPCountry` header, which
  only exists behind Cloudflare. Without it the About page shows no location.
- `bun scripts/drive.ts <path> <steps...>` clicks through the real client in
  headless Edge and takes screenshots (uses the browser profile
  `scripts/probe.sh` leaves signed in).

## License

[AGPL-3.0](LICENSE). If you run a modified instance for other people, you must
offer them its source; the signed-out home page links to it (`SOURCE_URL`, or the admin
panel's Settings).
