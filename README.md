# Xitter

A self-hosted backend for the X (Twitter) web client. The server hosts a pinned
build of the official client from your own domain and answers its API from
Postgres, so the real x.com interface runs against your own instance.

The client itself is not in this repository. Each instance downloads its own
copy during setup, and it stays on that machine.

## What works

- Posting, replies, quotes, reposts, likes, bookmarks (with folders), pinned
  posts, pinned replies, highlights, @mentions and hashtags; editing posts, polls,
  scheduled threads (up to 26 posts), places
- Scheduled threads publish together. Failed threads retry; permanent failures
  or exhausted retries return the complete thread to drafts. Each account can
  queue 100 future posts.
- Who can reply: everyone, accounts you follow, your network (them and the
  accounts they follow), verified accounts, accounts you mention, or accounts
  based in countries or regions you pick (several at once, changeable after
  posting); accounts mentioned in the post can always reply. Post views,
  reposts, likes and quotes lists
- Images, GIFs and video (converted with ffmpeg), alt text, content warnings on
  media, long-form articles
- Optional compression for instances short on disk (Admin > Settings > Media
  storage): photos are shrunk to the size the app shows and saved again as
  JPEG (PNG when see-through), videos encoded again at the size and quality
  set there, and only the smaller file is kept. "Compress stored files" does
  the same for what was uploaded before. Animated images are left alone
- Profiles with all their tabs, editing, follows, followers, private
  (protected) accounts with follow requests, "About this account" with the
  country or region it is based in and where it joined from (staff can set
  either, including a name of their own)
- Lists (with banners) and communities (rules, members, moderation tools,
  custom banners, a topic from the instance's topics, community label on posts)
- Home timeline: a ranked "For you" and a chronological "Following"
- Notifications with unread counts, browser push (with the instance's own VAPID
  key, made on first start in `data/push-vapid.json`); the profile bell (new posts from that
  account arrive as notifications) and turning an account's reposts off
- Search with X's operators, including full federated handles, trends, Explore;
  trends by location (Explore settings: worldwide, a country, or yours with
  "Trends for you")
- PostgreSQL trigram indexes for post text and account search; startup installs
  the `pg_trgm` extension and builds the indexes on existing data once
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
  (reactivates on sign-in within 30 days), downloadable JSON and offline HTML
  data archives (including drafts,
  scheduled posts, polls, media metadata, bookmark folders and visible encrypted
  chat history without decryption keys), email notification
  settings (activity and new-message digests, sent while you're away), sessions
  list with revoke, account access history (each sign-in
  with its app and address), two-factor sign-in with an
  authenticator app and backup codes, passkeys (Settings > Passkeys; the
  sign-in dialog offers them in the username field and with a button, and
  `/account/passkey` has one too; changing or resetting the password removes
  them), password reset by email
- Moving an account between instances (Settings > Move account,
  `/account/migrate`): see [Moving accounts](#moving-accounts)
- Reporting posts and accounts
- Account analytics (Overview, Content and each post's page) from the
  instance's own counts
- Sticker packs made by staff (Admin > Stickers), picked from a button beside
  the composer's emoji button and posted as images
- Branded hashtags (X's branded likes and hashmoji, Admin > Branded
  hashtags): for a set time, liking a post with the hashtag plays a custom
  Lottie animation, and the hashtag shows an emoji (optionally with hashfetti)
- Conversation cards: the composer’s conversation-card icon adds up to four hashtag buttons
  with prefilled post text, a title and an optional thank-you message, destination
  URL and display URL to one image, GIF or video. The editor previews the attached media, title and buttons
  together; its crop control opens the client’s image editor for still images.
  Published cards use the client’s native image/video conversation-card design.
  Each button opens an editable post carrying the original card; hashtag fields
  add the # prefix automatically. Post text is optional, including the prefilled
  text for each choice (which defaults to its hashtag). Drafts and scheduled
  posts preserve card settings and media. Incomplete cards can be saved as drafts;
  scheduling requires a valid card with one finished upload. Empty-text card
  shares include the title and hashtags when federation is enabled.
- Import from X (off by default; Admin > Settings, feature switches, then
  Settings > Your account > Import from X): upload the archive x.com makes
  (up to `ARCHIVE_MAX_MB`, default 1024) and its posts, threads, photos,
  videos and profile come over with their original dates and X ids. Imported
  posts pass the same length limit, automod and blocked phrases as new ones
  (those that don't are left out and counted) and count toward the post rate
  limit, so the import waits on it. Retweets and likes stay behind, mentions
  stay as text, imported posts aren't sent to other instances, and an upload
  that isn't imported within a day is deleted. By default only accounts a
  week old can import, and staff approve each import first (Admin > Settings,
  Import from X)
- Equicoins (in the side bar): every account has a wallet and sends money
  to other accounts, here or on a peer instance, with a note. It is play money,
  not real currency: a wallet starts with `money.starting_cents` (default
  $5), one payment moves up to `money.max_transfer_cents` (default $1,000),
  each like on your posts earns you `money.like_cents` (default 50¢, once per
  post and account). Admin > Equicoins sets those three, shows the money in
  circulation, the biggest balances and every payment, and has staff adjust a
  balance or reverse a payment (Staff permissions: Equicoins; all recorded in
  the audit log).
  - Requests: ask one account for an amount (it gets a notification to pay or
    decline), or anyone, as a "Pay @you" card in a post that anyone who sees it
    can pay, with or without a set amount
  - A payment's or request's link (`/i/xmoney/p/<id>`, `/i/xmoney/r/<id>`) in a
    post by its own side shows as X's card: "$100 sent to liza", "Pay @james"
    with a Pay button, or a purchase ("$3.52 at Taco Bell"). The composer's $
    button adds a Pay button or one of your payments; "Share it in a post" does
    it when sending or requesting
  - Merchant mode (Settings > Your account > Equicoins), for gold organisations:
    payments to them read as purchases under the name they choose, with their
    banner if they like
  - Payments show checkmarks and an affiliate's organisation badge; money
    received, requests and declined requests come as notifications and pushes
  - A payments feed (Admin > Equicoins, off until an account is named): that
    account posts every payment as "Alice sent $5 to Liza! #Money" (names, so nobody is mentioned) over its
    card, without the note; reversing a payment takes its post down, and the
    Send screen says payments are public
  - Across instances: a wallet lives on its account's home instance, and a
    payment to `name@peer` moves the money there once (signed, retried until
    the peer answers, refunded if it refuses). Likes from peers' accounts pay
    too. Requests, balance adjustments and reversals stay on one instance.
    Admin > Equicoins settings:
    - Use the network's economy: the starting balance, like reward and largest
      payment come from xitter.space instead of this instance's own
      (`money.follow_network`, off)
    - Most taken in from one instance a day, its payments and likes together;
      over it, payments are refused and refunded and likes stop paying
      (`money.peer_daily_cents`, default $1,000, 0 for no limit). A peer's
      word is all there is for what it sends, so this is the only brake on a
      peer minting money here
    - An account moving to another instance takes its balance along
      (`money.move_balance`, on); the new instance takes it only for an account
      it imported from there, once per move and up to 100 times its largest
      payment
    - A payment a peer hasn't taken after three days fails and goes back to
      the sender
    - Share this instance's totals with peers and show the network's in
      circulation, wallets and payments (`money.network_totals`, off)
  - The shop (`/account/money/shop`, opened in Admin > Equicoins): accounts
    spend their balance on listings staff make. An admin's listing goes up at
    once; one from a moderator waits for an admin. A purchase is charged at
    once and waits for staff, who deliver it or refund it; an invite code is
    the only thing that comes without review. Moderators deliver badges
    (Staff permissions: Equicoins shop); everything else below is delivered
    by an admin. A paid announcement stays up until an admin takes it down
    in Admin > Equicoins. What a listing can give:
    - A custom badge staff made, or a badge the buyer designs (an image up to
      256 KB, GIFs animate)
    - An instance announcement the buyer writes
    - A blue checkmark for the listing's days (default 30), with longer posts
      while it lasts; it comes off by itself, and one staff gave is never
      touched
    - An invite code, good for one sign-up within 30 days (not while sign-up
      is open)
    - A hashflag: the buyer's emoji after a hashtag, for its days (default 7)
    - A sticker pack of up to 6 of the buyer's stickers, in everyone's composer
    - An Explore card (title, summary, a search it opens, a picture) for its
      days (default 1)
    - A post boost: one of the buyer's posts shows once on each page of For
      you, marked as an ad, for its days (default 1)
    - Badges, custom badges and checkmarks can be gifts to another account
      here, which gets a notification once staff deliver it
    - Approved listings are shared with peer instances, where they stay hidden
      until that instance's staff approve them too; buying across instances
      isn't available yet
  - The first time Equicoins opens, each account accepts a disclaimer: the money
    is virtual, has no real-world value and can't be exchanged
  - Off by default: Admin > Settings, feature switches turns it on. Switched
    off, the Equicoins tab, its pages, the composer's $ button, Pay buttons, like
    earnings and its notifications go away, but cards already in posts still
    show. `bun scripts/test-money.ts` checks it
- Polls with a photo on each choice
- YouTube links (videos, Shorts, live, youtu.be, with `t=` start times) become
  player cards: the thumbnail comes through `EMBED_PROXY`, and pressing play
  loads the video in place from youtube-nocookie.com
- Previews when a public post or profile is shared in other apps (Discord,
  Slack, iMessage…): OpenGraph and Twitter card tags and oEmbed, for active,
  unprotected accounts only. Admin > Settings > Features switches them off
- Dim (X dropped it from Display settings) and custom themes, including
  gradients, per-token colours, and Google Fonts served from this instance;
  Settings > Display or /account/theme. Organisation profile decor keeps its
  own look on the profile column.
- Staff labels under posts, as X shows them: Visibility limited (also kept out
  of For you and search), Misleading, Stay informed, Get the latest, Legally
  required notice; staff can also set the counts a post or profile shows
- Admin > Feature switches: any of the client's own switches, set for everyone
- Rate limits per account and address (`src/ratelimit.ts`)
- A public JSON API under `/api/v1` with personal tokens (`/account/api`,
  read or read and write), including chunked video uploads with progress and
  retry support; `/api` documents it. Pending uploads expire after one hour and
  are lost if the server restarts. Changing or resetting a password revokes all
  of that account's API tokens.
- Connected apps: developers register a public client at `/account/apps/developer`,
  users approve read or read-and-write access with OAuth 2 authorization code
  and mandatory PKCE, and revoke access at `/account/apps`. Tokens expire after
  30 days; `/api` documents the flow. Apps can skip registering on each
  instance by using the URL of a client ID metadata document as their
  `client_id`, so one app signs in with one tap on every Xitter
  (`/.well-known/oauth-authorization-server` advertises it).
- An admin panel at `/admin`: users, standing (restrict, limit, suspend),
  badges (blue, gold organisation, grey government organisation or official),
  translator globes (blue translator, gold translator moderator, yellow approver),
  roles, organisations, posts, reports, invites, instance settings,
  feature switches, announcements, topics, Explore cards and an audit log.
  Bulk tools: strike many accounts at once (by handle, optionally with alts
  seen at the same addresses), hide, mark sensitive or delete many posts, and
  delete many files, each reporting what worked and what didn't. An account's
  page links its profile picture, banner and all its uploads; pride flags go
  up to four per account, in the order picked
- Staff roles (admin, moderator, support) whose powers an admin chooses: Admin >
  Staff permissions turns each permission (changing standing, deleting posts,
  editing profiles, resetting passwords…) on or off for moderators and support,
  and who sees IP addresses, email addresses, invite codes and server errors
  (`src/staff-permissions.ts`; `bun scripts/test-staff-permissions.ts` checks it)
- Updating from the panel (Admin > Server update, off until `SELF_UPDATE=on`):
  admins update a git checkout from a branch of Xittered/xitter, or of the
  other GitHub repositories the owner allows, after giving their password and
  a two-factor code again. It backs up the database, fetches and checks out
  the branch, runs `bun install`, stays on the old commit if the new code
  doesn't load, and restarts; "Go back" returns to the commit before

Not built yet: Spaces and live video, Moments. Email is sent over SMTP to your own mail server when
`SMTP_URL` is set, or through [Resend](https://resend.com) when
`RESEND_API_KEY` is (with both, Resend catches what SMTP refused); Admin >
Email sends a test mail (it shows the server's answer) and lists every mail
tried.

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

The image has a health check: `/healthz` answers `ok` while the server runs
and reaches its database, and `docker compose ps` shows the app as
`unhealthy` when it doesn't. Docker doesn't restart unhealthy containers by
itself; a watcher such as
[autoheal](https://github.com/willfarrell/docker-autoheal) can.

For an optional PgBouncer connection pool, add `DB_HOST=pool` and
`DB_PORT=6432` to `.env`, then start with
`docker compose --profile sqlpool up -d --build`. PgBouncer uses session pooling
so Bun's prepared statements and startup migration keep their connection
semantics. `PGBOUNCER_POOL_SIZE` defaults to 20 server connections; tune it
alongside `DB_POOL_MAX` for the number of app replicas. Backups use a direct
PostgreSQL connection. The Compose PostgreSQL service also uses conservative
cache and autovacuum settings; adjust them for the host's memory and workload.

### Keep these private

- An `auth_token` cookie is a live login to your X account. Use it only for
  `fetch-client.ts` and don't share it.
- `client/` holds X's own client code. It is downloaded per instance and must
  not be committed or shared.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://dev@localhost:5432/xitter` | Postgres connection |
| `BACKUP_DATABASE_URL` | `DATABASE_URL` | Direct Postgres connection for `pg_dump` when the app uses a pooler |
| `DB_POOL_MAX` | `20` | Postgres connections the server keeps open |
| `DB_STATEMENT_TIMEOUT`, `DB_LOCK_TIMEOUT` | `30s`, `10s` | A query running or waiting on a lock longer than this is cancelled, so one stuck query can't hold every connection (the migration at start-up has no limit) |
| `PORT` | `3000` | Listen port |
| `PUBLIC_ORIGIN` | `http://localhost:$PORT` | Address browsers use to reach the instance |
| `PASSKEY_ORIGINS` | none | Other https sites of this instance, comma separated, that may make and use its passkeys (subdomains of `PUBLIC_ORIGIN`'s host only) |
| `CLIENT_DIR` | `client` | Where the pinned client is stored |
| `MEDIA_DIR` | `media` | Uploaded images and videos |
| `BRANDING_DIR` | `data/branding` | Logos uploaded in the admin panel |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | Video tools |
| `MAX_VIDEO_MB`, `MAX_VIDEO_SECONDS` | `200`, `600` | Starting video limits (changeable in the panel) |
| `SOURCE_URL` | this repository | The source link shown to users |
| `LOG_REQUESTS` | unset | `1` logs every API call, `errors` also prints the client's error reports |
| `RATE_LIMITS` | on | `off` turns the rate limits off (for the test scripts; limits are in `src/ratelimit.ts`, `scripts/test-ratelimit.ts` checks them) |
| `TRUSTED_PROXIES` | unset | Comma-separated addresses or ranges (`127.0.0.1`, `172.16.0.0/12`) whose `CF-Connecting-IP` header is believed, besides Cloudflare's own ranges: set it to a Cloudflare tunnel's address. A plain nginx or Caddy passes the visitor's header on, so leave it out of this list |
| `EMBED_PROXY` | `https://cors.estrogen.delivery/` | where link previews are fetched from and their images served, as `<proxy>?url=<link>`, so neither the instance nor its readers reach the linked site |
| `JUICEBOX_URL` | `http://localhost:8580` | Private address of the key-backup realm, proxied through `/juicebox/` |
| `CHAT_TOKEN_SECRET` | saved in `data/chat-secrets.json` | Signing secret for chat socket tokens |
| `JUICEBOX_REALM_ID`, `JUICEBOX_TENANT_SECRET` | saved in `data/chat-secrets.json` | Stable realm identity and tenant signing secret |
| `MAX_CHAT_MEDIA_MB` | `200` | Maximum encrypted chat attachment size |
| `SMTP_URL` | unset | Own mail server for sign-up codes, password resets and notifications: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465`; percent-encode `@` in the user; the host must be the name on the server's certificate |
| `RESEND_API_KEY` | unset | Resend key, used when `SMTP_URL` isn't set or refused a mail; without either nothing is sent |
| `MAIL_FROM` | `"<instance name>" <noreply@xit.chococat.lol>` | Sender of that mail. Set it on your own instance: its domain must be the mail server's, or verified in Resend |
| `ARCHIVE_DIR`, `ARCHIVE_MAX_MB` | `data/imports`, `1024` | Where uploaded X archives wait while they import, and the largest accepted |
| `ARCHIVE_MAX_JSON_MB` | `64` | Largest JSON file in an archive (`tweets.js` and its parts) an import reads; it's parsed in memory |
| `GIF_PROVIDER` | `auto` | Instance default provider (`klipy`, `tenor` or `giphy`); users can override it in Settings > GIF provider. Auto prefers configured Klipy, then Tenor, then Giphy |
| `KLIPY_API_KEY` | unset | Account-specific key from the [Klipy Partner Panel](https://partner.klipy.com/api-keys). This server-proxied integration requires Klipy's prior written approval |
| `TENOR_API_KEY` | built-in public client key | Tenor API key override; set empty to disable Tenor |
| `TENOR_API_URL` | `https://api.tenor.com/v1` | Tenor API base URL |
| `GIPHY_API_KEY` | built-in public client key | Giphy API key override; set empty to disable Giphy |
| `GIPHY_API_URL` | `https://api.giphy.com/v1/gifs` | Giphy API base URL |
| `KLIPY_API_URL` | `https://api.klipy.com/v2` | Klipy API base URL, for a proxy or a test server |
| `FFMPEG_THREADS` | `2` | Threads each ffmpeg job may use; jobs run at a lower priority beside the server |
| `PUBLIC_DIR` | `public` | Logos and icons served to everyone |
| `BACKUP_DIR`, `PG_DUMP` | `data/backups`, `pg_dump` | Where database backups (Admin > Backups) go, and the tool that makes them; `media/` and `data/` need copying separately |
| `ADMIN_ANY_IP` | unset | `1` opens the admin panel to every address, ignoring the allow-list in its settings (to get back in after locking yourself out) |
| `GOOGLE_FONTS_CSS_ORIGIN`, `GOOGLE_FONTS_FILE_ORIGIN` | Google's | Where theme fonts are fetched from before this instance serves them |
| `FEDERATION` | on | `off` stops federating (see [FEDERATION.md](FEDERATION.md)) |
| `FEDERATION_KEY_FILE` | `data/federation-key.json` | This instance's federation key; back it up |
| `FEDERATION_REGISTRY_URL` | `instances.json` on this repository's `main` | The list of instances to federate with |
| `FEDERATION_MEDIA`, `FEDERATION_MEDIA_CACHE_MB` | unset, `64` | `store` keeps other instances' media on disk; otherwise it's fetched on view and the newest kept in memory |
| `FEDERATION_EVENTS_PER_HOUR`, `FEDERATION_MAX_ACCOUNTS` | `20000`, `100000` | Changes taken from one other instance per hour before its sync pauses, and the most of its accounts this instance takes |
| `FEDERATION_ALLOW_HTTP` | unset | `1` federates over plain HTTP. For test instances only |
| `XITTER_VERSION` | `version` in `package.json` | The version this instance reports in `/.well-known/xitter` and compares when an account moves |
| `XITTER_COMMIT` | read from `.git` | The commit `/.well-known/xitter` shows, for images built without `.git`; the update check also uses it to count how far behind the instance is |
| `UPDATE_CHECK`, `UPDATE_REPO`, `UPDATE_BRANCH`, `UPDATE_GITHUB_TOKEN` | on, the GitHub repository `SOURCE_URL` names (else `Xittered/xitter`), `main`, unset | Every six hours the server asks GitHub whether this branch has a newer Xitter, and admins see a banner atop the panel when it does. `UPDATE_CHECK=off` turns that off; a token raises GitHub's limit of 60 requests an hour per address |
| `SELF_UPDATE`, `SELF_UPDATE_REPOS`, `SELF_UPDATE_RESTART` | off, `UPDATE_REPO` (else `Xittered/xitter`), exit | `on` lets admins update this checkout from Admin > Server update; they need two-factor on, and give their password and a code each time. The code they pick runs as this server, so by default only the update repository is allowed: `SELF_UPDATE_REPOS` names others (`owner/name`, comma-separated), and `*` allows any. The server's user must own the checkout and reach `pg_dump` (`PG_DUMP`). To restart, the process exits with code 75, for systemd (`Restart=on-failure` or `always`) or Docker to start it again; `SELF_UPDATE_RESTART` runs a shell command instead. An update whose code loads but fails on start (a migration that breaks, say) leaves the instance down, and the panel with it: go back over SSH with `git checkout` of the commit in `data/self-update.json` (`previous`), `bun install`, and a restart. A `SELF_UPDATE_RESTART` script that restarts, checks the server answers, and does that itself when it doesn't covers this case |
| `MIGRATION_ALLOW_HTTP`, `MIGRATION_ALLOW_PRIVATE` | unset | `1` lets an account move from an instance over plain HTTP, or on a private network. For test instances only |

Everything else (name, sign-up mode, features, limits, announcement, rules,
logos) is set in the admin panel.

## Federation

Instances listed in `instances.json` share public accounts and posts with each
other. [FEDERATION.md](FEDERATION.md) explains how to set up an instance and
join the list.

## Moving accounts

An account can move from one Xitter instance to another, federated or not.
Both sides are on the Move account page (`/account/migrate`):

1. On the old instance, the account makes a migration code with its password.
   The code works for 24 hours and lets one other instance read the account's
   data; a new code replaces it.
2. On the new instance, the account it moves into enters the old instance's
   address and the code, and presses Check. Nothing is copied yet: the new
   instance asks the old one what it runs and what the account holds, and shows
   both side by side.
   - It refuses when the old instance exports a newer archive format than it
     reads, when the address is its own, or while another import runs.
   - It warns, and starts only once the warnings are accepted, when the two run
     different versions (or the same version with a different database schema,
     meaning one is modified), when the two don't federate with each other (so
     the account's follows, likes, replies and the like involving accounts there
     can't be matched), when the account here already has posts or follows, and
     when files are over this instance's size limits.
3. The import runs in the background, with its progress and a report on the
   same page: files, polls, articles, posts with their threads, quotes, edit
   history and original times, drafts and scheduled posts, the profile, follows,
   follow requests, blocks, mutes, muted words, lists, likes, reposts,
   bookmarks and their folders. Other accounts and posts are matched to the ones
   this instance already knows (its own, or copies from federation); the report
   lists accounts it couldn't find. Every object brought over is recorded, so an
   import that failed, or is run again, only adds what's missing.
4. When it's done, the old instance records where the account went, cancels its
   scheduled posts there, and if asked leaves "Moved to @name@instance" as the
   profile's bio and deactivates the account.

Followers can't be moved for them, and encrypted chats stay behind, since their
keys never leave the browser. The old instance only answers on the public
internet over HTTPS unless `MIGRATION_ALLOW_HTTP` and `MIGRATION_ALLOW_PRIVATE`
are set.

`docker/migration-test.yaml` runs two throwaway instances on ports 3101 and
3102; `bun scripts/test-migration.ts` moves a seeded account between them and
checks what arrived (its first lines give the variables).

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

[CONTRIBUTING.md](CONTRIBUTING.md) has the rules for changes and how to run
the tests; [AGENTS.md](AGENTS.md) explains how the code fits together and what
to watch out for (it's written for coding agents, and works for people too).
`sh scripts/ci-local.sh` runs the same checks as CI against a throwaway
database.

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

The local scoring rule needs at least five active ratings and a 95% Wilson
lower bound above 50% before a misleading-post note is displayed as native
context. Ratings from suspended accounts are excluded. Authors can appeal a
Not Helpful note at `/account/notes/appeals`; admins and moderators review
appeals there, with decisions recorded in the audit log. A staff decision does
not change the reader score. This is not X's matrix-factorization scoring
system. Media-match notes and automated translation are not implemented.

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
encrypted, so the server can't read them. The first refusals each week (5 by
default) are second chances: the content isn't published, and the person gets a
notice and a modal saying what was caught and how many chances are left. After
that each refusal is an appealable strike, and strikes, from staff or
automatic, follow a ladder set in Settings > Automod (by default a warning, a
day, a week, 30 days, then permanent). `bun test ./scripts/test-hate.ts` checks evasions and false
positives without a server; `bun scripts/test-automod.ts` checks the ladder,
expiry, write paths and request limits against one.

- `GET /_debug/unknown` (admins only) lists the client calls no handler answers yet, most
  frequent first. Start there when a screen is empty.
- `bun run test:unit` discovers and runs the scripts that use `bun:test`, without
  needing a server. `.github/workflows/tests.yml` runs these on pushes and pull
  requests, then checks password and two-factor concurrency, poll visibility,
  search operators, API request limits, email confirmations, data exports,
  scheduled threads and quotas, bookmark pagination, media privacy, chunked
  video uploads, account settings and encrypted chat
  against a fresh PostgreSQL 18 database and a local server. The pinned client
  is not downloaded; checks that need it report a skip.
- The `test-*-concurrency.ts`, `test-poll-visibility.ts` and
  `test-search-operators.ts` scripts can also run against a dedicated migrated
  test database without a server. Set `DATABASE_URL` to that database; each
  script creates and removes its own test accounts.
- `scripts/test-*.ts` check each feature end to end against a running server,
  for example `bun scripts/test-posts.ts <user A> <user B> <password>`. Each
  script's first lines give its arguments.
- `bun scripts/test-chat.ts` creates and removes temporary users and checks
  encryption with emusks, access controls, requests, groups, socket delivery,
  attachments and history. `bun test ./scripts/test-chat-token.ts` checks token
  validation without a running server. `bun scripts/test-juicebox.ts` verifies
  realm registration and recovery; run it with `recover` after a realm/database
  restart to check durability (`TEST_JUICEBOX_URL` selects the realm).
- `bun scripts/test-conversation-live.ts public/logo-light.png` verifies conversation
  card uploads, publication, native previews, sharing and JSON storage against a
  running server and database. It creates and removes its own test account.
- Other checks: `test-account-settings`, `test-two-factor`, `test-password-reset`,
  `test-reply-limits`, `test-views`, `test-protected`, `test-communities`, `test-lists`,
  `test-polls`, `test-scheduled` and the rest of `scripts/test-*.ts`. A passing
  script is not a working screen: check the UI with `drive.ts` too.
- Where the account's country comes from: the `CF-IPCountry` header, which
  only exists behind Cloudflare. Without it the About page shows no location.
- `bun scripts/drive.ts <path> <steps...>` clicks through the real client in
  headless Edge and takes screenshots (uses the browser profile
  `scripts/probe.sh` leaves signed in).

## Donate

If Xitter is useful to you, crypto donations keep the main instance running.
Send only the coin on the network listed for each address.

| Coin | Network | Address |
| --- | --- | --- |
| SOL | Solana | `5nmzmrxFrvacVuQhNPVFJzbbkAgRMefWsWmPSoft1cJF` |
| BTC | Bitcoin | `bc1qj2kedn4kqavwg2r5z5n4cldtx09gy2recswak9` |
| ETH | Ethereum | `0x5A7cFbf7F877BE5b6DB4aE248178761E68129881` |
| USDT | Tron (TRC20) | `THvC2xDHpF8Yr9s6jhHCXYGDya9ZnvjG79` |

## License

[AGPL-3.0](LICENSE). If you run a modified instance for other people, you must
offer them its source; the signed-out home page links to it (`SOURCE_URL`, or the admin
panel's Settings).

## Stars

[![GitHub stars](https://img.shields.io/github/stars/Xittered/xitter?style=for-the-badge&logo=github&label=stars)](https://github.com/Xittered/xitter/stargazers)

[![Star history](https://api.star-history.com/svg?repos=Xittered/xitter&type=Date)](https://star-history.com/#Xittered/xitter&Date)
