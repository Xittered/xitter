create table if not exists users (
	id bigint primary key,
	screen_name text not null,
	name text not null,
	password_hash text not null,
	bio text not null default '',
	location text not null default '',
	avatar_url text,
	banner_url text,
	-- null, 'blue', 'business' (gold) or 'government' (grey)
	verified_type text check (verified_type in ('blue', 'business', 'government')),
	created_at timestamptz not null default now()
);
create unique index if not exists users_screen_name_key on users (lower(screen_name));
create extension if not exists pg_trgm;
create index if not exists users_handle_trgm_idx on users using gin (screen_name gin_trgm_ops);
create index if not exists users_name_trgm_idx on users using gin (name gin_trgm_ops);
create index if not exists users_bio_trgm_idx on users using gin (bio gin_trgm_ops);

create table if not exists sessions (
	token text primary key,
	user_id bigint not null references users (id) on delete cascade,
	csrf text not null,
	created_at timestamptz not null default now()
);

create table if not exists posts (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	text text not null,
	reply_to_id bigint references posts (id) on delete set null,
	conversation_id bigint not null,
	created_at timestamptz not null default now()
);
-- replies with their authors, for the counts (posts.ts); replaces two copies
-- of the same index on reply_to_id
create index if not exists posts_replies_idx on posts (reply_to_id, user_id);
drop index if exists posts_reply_to_idx;
alter table posts drop constraint if exists posts_reply_to_id_fkey;
alter table posts add column if not exists reply_to_user_id bigint;
create index if not exists posts_user_idx on posts (user_id, id desc);
-- trends read the last days' posts; without it every refresh read the whole table
create index if not exists posts_created_idx on posts (created_at);
-- The search box uses ILIKE %term% and regex hashtag matches. Trigram GIN
-- supports both without changing the search language or result ordering.
create index if not exists posts_text_trgm_idx on posts using gin (text gin_trgm_ops);
-- replies to an account's posts, newest first (notifications.ts)
create index if not exists posts_reply_user_idx on posts (reply_to_user_id, created_at) where reply_to_user_id is not null;

create table if not exists custom_badges (
	id bigint primary key, name text not null check(char_length(name) between 1 and 60),
	image bytea not null, mime text not null, created_at timestamptz not null default now()
);
-- an account's custom badges in order: the first fills X's badge slot after
-- the name (unless an organisation's does), the others are drawn after it
create table if not exists user_badges (
	user_id bigint not null references users(id) on delete cascade,
	badge_id bigint not null references custom_badges(id) on delete cascade,
	position integer not null default 0,
	primary key (user_id, badge_id)
);
create index if not exists user_badges_badge_idx on user_badges(badge_id);
-- accounts used to hold a single custom badge
do $$ begin
	if exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'custom_badge_id') then
		insert into user_badges (user_id, badge_id) select id, custom_badge_id from users where custom_badge_id is not null on conflict do nothing;
		alter table users drop column custom_badge_id;
	end if;
end $$;
-- the client's "seen this" popups: flag name -> timestamp
alter table users add column if not exists education_flags jsonb not null default '{}';
alter table users add column if not exists preferences jsonb not null default '{}';
alter table users add column if not exists country text;
alter table users add column if not exists status_until timestamptz;
-- self-service deactivation: signing in within 30 days brings the account back
alter table users add column if not exists deactivated_at timestamptz;
alter table users add column if not exists language text not null default 'en';
alter table users add column if not exists email text;
alter table users add column if not exists totp_enabled boolean not null default false;
alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_pending text;
alter table users add column if not exists totp_backup jsonb not null default '[]';
-- the step of the last code accepted, so a code can't be used twice
alter table users add column if not exists totp_last_step bigint;
create table if not exists login_challenges (
	token uuid primary key,
	user_id bigint not null references users (id) on delete cascade,
	attempts int not null default 0,
	created_at timestamptz not null default now()
);
-- passkeys (passkeys.ts): id is the credential id, public_key its SPKI, both base64url
create table if not exists passkeys (
	id text primary key,
	user_id bigint not null references users (id) on delete cascade,
	public_key text not null,
	alg int not null,
	sign_count bigint not null default 0,
	name text not null,
	transports text[] not null default '{}',
	backed_up boolean not null default false,
	created_at timestamptz not null default now(),
	last_used_at timestamptz
);
create index if not exists passkeys_user on passkeys (user_id);
-- one per sign-in or set-up, used once; user_id only when adding a passkey
create table if not exists passkey_challenges (
	challenge text primary key,
	user_id bigint references users (id) on delete cascade,
	created_at timestamptz not null default now()
);
-- who has been shown a post (other than its author), once each
create table if not exists post_views (
	post_id bigint not null references posts (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (post_id, user_id)
);
-- who may reply, set on the first post of a conversation: Community (accounts it follows), ByInvitation (mentioned) or Verified
alter table posts add column if not exists reply_policy text;
create table if not exists password_resets (
	token_hash text primary key,
	user_id bigint not null references users (id) on delete cascade,
	used boolean not null default false,
	created_at timestamptz not null default now()
);
alter table users add column if not exists email_settings jsonb not null default '{}';
create table if not exists data_exports (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	body jsonb not null,
	created_at timestamptz not null default now()
);
create unique index if not exists users_email_idx on users (lower(email));
alter table users add column if not exists status_restore text;
alter table posts add column if not exists hidden boolean not null default false;
alter table posts add column if not exists sensitive boolean not null default false;
alter table users add column if not exists never_sensitive boolean not null default false;
alter table users add column if not exists remote_badges jsonb;
alter table users add column if not exists remote_counts jsonb;
alter table posts add column if not exists remote_counts jsonb;
do $$ begin
	if not exists (select 1 from information_schema.columns where table_name = 'posts' and column_name = 'received_at') then
		alter table posts add column received_at timestamptz;
		update posts set received_at = created_at;
		alter table posts alter column received_at set default now();
		alter table posts alter column received_at set not null;
	end if;
end $$;
alter table sessions add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists sessions_id_key on sessions(id);
alter table sessions add column if not exists last_seen_at timestamptz not null default now();
alter table sessions add column if not exists user_agent text;
update sessions set token = encode(sha256(convert_to(token, 'UTF8')), 'hex') where token !~ '^[0-9a-f]{64}$';

create table if not exists staff_notes (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	actor_id bigint references users(id) on delete set null, body text not null check(char_length(body) between 1 and 2000),
	created_at timestamptz not null default now()
);
create index if not exists staff_notes_user_idx on staff_notes(user_id,id desc);
create index if not exists staff_notes_actor_idx on staff_notes(actor_id);
create table if not exists staff_messages (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	actor_id bigint references users(id) on delete set null,
	kind text not null check(kind in ('message','warning','strike')),
	body text not null check(char_length(body) between 1 and 2000),
	created_at timestamptz not null default now(), read_at timestamptz, revoked_at timestamptz
);
create index if not exists staff_messages_user_idx on staff_messages(user_id,id desc);
create index if not exists staff_messages_actor_idx on staff_messages(actor_id);
create table if not exists moderation_appeals (
	id bigint primary key, user_id bigint not null references users(id) on delete cascade,
	message_id bigint references staff_messages(id) on delete set null, body text not null,
	status text not null default 'open' check(status in ('open','accepted','rejected')),
	staff_reply text, reviewer_id bigint references users(id) on delete set null,
	created_at timestamptz not null default now(), resolved_at timestamptz
);
create index if not exists moderation_appeals_user_idx on moderation_appeals(user_id,id desc);
create index if not exists moderation_appeals_message_idx on moderation_appeals(message_id);
create index if not exists moderation_appeals_reviewer_idx on moderation_appeals(reviewer_id);
create unique index if not exists moderation_appeals_open_user_idx on moderation_appeals(user_id) where status='open';

alter table posts add column if not exists source text not null default 'Xitter for Web';
alter table users add column if not exists notes_writer boolean not null default false;
alter table users add column if not exists shadow_banned boolean not null default false;
alter table users add column if not exists notes_alias text not null default ('Contributor-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
create unique index if not exists users_notes_alias_key on users(notes_alias);
create table if not exists client_platforms (
	id bigint primary key,
	label text not null check (char_length(label) between 1 and 80),
	token_hash text not null unique,
	creator_id bigint references users(id) on delete set null,
	revoked boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists client_platforms_creator_idx on client_platforms(creator_id);

create table if not exists community_notes (
	id bigint primary key,
	post_id bigint not null references posts(id) on delete cascade,
	author_id bigint not null references users(id) on delete cascade,
	text text not null check (char_length(text) between 1 and 500),
	classification text not null check (classification in ('Misleading', 'NotMisleading')),
	created_at timestamptz not null default now(),
	unique(post_id, author_id)
);
create index if not exists community_notes_author_idx on community_notes(author_id);
alter table community_notes add column if not exists data_v1 jsonb not null default '{}';
alter table community_notes add column if not exists staff boolean not null default false;
create table if not exists community_note_ratings (
	note_id bigint not null references community_notes(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	rating text not null check (rating in ('Helpful', 'SomewhatHelpful', 'NotHelpful')),
	primary key(note_id, user_id)
);
create index if not exists community_note_ratings_user_idx on community_note_ratings(user_id);
alter table community_note_ratings add column if not exists data_v2 jsonb not null default '{}';
create table if not exists community_note_appeals (
	note_id bigint primary key references community_notes(id) on delete cascade,
	author_id bigint not null references users(id) on delete cascade,
	reason text not null check (char_length(reason) between 20 and 1000),
	status text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
	created_at timestamptz not null default now(),
	reviewed_by bigint references users(id) on delete set null,
	reviewed_at timestamptz,
	resolution text
);
create index if not exists community_note_appeals_open_idx on community_note_appeals (created_at) where status = 'open';
create table if not exists community_note_requests (
	post_id bigint not null references posts(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key(post_id, user_id)
);
create index if not exists community_note_requests_user_idx on community_note_requests(user_id);
alter table community_note_requests add column if not exists source_link text;
alter table community_note_requests add column if not exists suggestion text;

create table if not exists likes (
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
-- with the liker, so a post's count skips suspended accounts from the index alone
create index if not exists likes_post_user_idx on likes (post_id, user_id);
drop index if exists likes_post_idx;
-- what came in since a mark (notifications.ts: push, unread counts)
create index if not exists likes_created_idx on likes (created_at);

create table if not exists reposts (
	id bigint not null,
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
create index if not exists reposts_post_user_idx on reposts (post_id, user_id);
drop index if exists reposts_post_idx;
create index if not exists reposts_created_idx on reposts (created_at);
-- a repost's own id, which the client acts on (posts.ts originalPostId)
create index if not exists reposts_id_idx on reposts (id);

create table if not exists bookmarks (
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);
create index if not exists bookmarks_post_idx on bookmarks (post_id);

-- posts an account shows on its profile's Highlights tab
create table if not exists highlights (
	user_id bigint not null references users (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, post_id)
);

create table if not exists follows (
	follower_id bigint not null references users (id) on delete cascade,
	followee_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (follower_id, followee_id),
	check (follower_id <> followee_id)
);
create index if not exists follows_followee_created_idx on follows (followee_id, created_at);
drop index if exists follows_followee_idx;

create table if not exists media (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	-- 'photo' or 'video'
	kind text not null,
	mime text not null,
	size integer not null,
	width integer not null,
	height integer not null,
	post_id bigint references posts (id) on delete set null,
	position smallint,
	created_at timestamptz not null default now()
);
create index if not exists media_post_idx on media (post_id, position);
create index if not exists media_user_idx on media (user_id, id);
alter table media add column if not exists detached boolean not null default false;
create or replace function media_detached() returns trigger language plpgsql as $$
begin
	if old.post_id is not null and new.post_id is null then new.detached := true; end if;
	return new;
end $$;
create or replace trigger media_detached before update of post_id on media for each row execute function media_detached();

alter table users add column if not exists website text not null default '';

alter table posts add column if not exists quote_id bigint references posts (id) on delete set null;
alter table users add column if not exists pinned_post_id bigint references posts (id) on delete set null;
create index if not exists reposts_user_idx on reposts (user_id, id desc);

-- posts and reposts as one ordered stream; a repost's own id places it in time
alter table posts add column if not exists ad_only boolean not null default false;
create or replace view feed_items as
	select p.id as item_id, p.id as post_id, null::bigint as reposter_id, p.user_id as author_id,
		p.reply_to_id is not null as is_reply, p.created_at
	from posts p
	where not p.ad_only
	union all
	select r.id, r.post_id, r.user_id, r.user_id, false, r.created_at
	from reposts r
	where not exists (select 1 from posts x where x.id = r.post_id and x.ad_only);
create index if not exists posts_top_level_idx on posts (id) where reply_to_id is null;

-- videos: converted after upload; 'processing' until ffmpeg is done
alter table media add column if not exists duration_ms integer;
alter table media add column if not exists state text not null default 'ready';
alter table media add column if not exists alt_text text;
-- the content warning the author put on it: adult_content, graphic_violence, other
alter table media add column if not exists sensitive_warning text[];

-- long-form articles; the body is the editor's Draft.js document, kept as sent.
-- Publishing creates a post that carries the article (posts.article_id).
create table if not exists articles (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	title text not null default '',
	content_state jsonb,
	plain_text text not null default '',
	cover_media_id bigint references media (id) on delete set null,
	-- 'Draft' or 'Published'
	state text not null default 'Draft',
	created_at timestamptz not null default now(),
	modified_at timestamptz not null default now(),
	first_published_at timestamptz
);
create index if not exists articles_user_idx on articles (user_id, state, modified_at desc);
alter table posts add column if not exists article_id bigint references articles (id) on delete set null;

-- accounts named with @ in a post; they get a notification and the name becomes a link
create table if not exists post_mentions (
	post_id bigint not null references posts (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	primary key (post_id, user_id)
);
create index if not exists post_mentions_user_idx on post_mentions (user_id);
create index if not exists posts_quotes_idx on posts (quote_id, user_id) where quote_id is not null;
drop index if exists posts_quote_idx;
drop index if exists posts_reply_idx;
-- notifications newer than this are unread
alter table users add column if not exists notifications_seen_at timestamptz not null default now();

-- a block hides both accounts from each other; a mute only hides the muted
-- account from the muter's home feeds and notifications
create table if not exists blocks (
	blocker_id bigint not null references users (id) on delete cascade,
	blocked_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (blocker_id, blocked_id)
);
create index if not exists blocks_blocked_idx on blocks (blocked_id);
create table if not exists mutes (
	muter_id bigint not null references users (id) on delete cascade,
	muted_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (muter_id, muted_id)
);
-- muted words; surfaces are home_timeline, tweet_replies and notifications
create table if not exists muted_keywords (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	keyword text not null,
	surfaces text[] not null,
	exclude_following boolean not null default false,
	valid_until timestamptz,
	created_at timestamptz not null default now()
);
create unique index if not exists muted_keywords_user_word_idx on muted_keywords (user_id, lower(keyword));

-- sign-up is by invite; a code works until it runs out of uses or expires
create table if not exists invites (
	code text primary key,
	created_by bigint references users (id) on delete set null,
	max_uses integer not null default 1,
	uses integer not null default 0,
	expires_at timestamptz,
	created_at timestamptz not null default now()
);
alter table users add column if not exists invite_code text references invites (code) on delete set null;
-- a pride flag shown next to the name (see flags.ts), picked at sign-up
alter table users add column if not exists flag text;
alter table users add column if not exists pronouns text;

-- Admin panel. Staff roles: admin (everything), moderator (users' standing and
-- posts), support (read, password resets, sign-outs). Every staff action is logged.
alter table users add column if not exists role text check (role in ('admin', 'moderator', 'support'));
-- active; restricted (can read, not post); limited (only followers see their
-- posts); suspended (can't sign in, hidden everywhere)
alter table users add column if not exists status text not null default 'active'
	check (status in ('active', 'restricted', 'limited', 'suspended'));
-- the few suspended accounts every post query leaves out (posts.ts SUSPENDED)
create index if not exists users_suspended_idx on users (id) where status = 'suspended';
alter table users add column if not exists last_seen_at timestamptz;
create table if not exists audit_log (
	id bigint primary key,
	actor_id bigint references users (id) on delete set null,
	action text not null,
	target text,
	detail jsonb,
	created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on audit_log (created_at desc);
create index if not exists audit_log_action_idx on audit_log (action);
-- organisations are business accounts; affiliates show the org's badge
create table if not exists affiliations (
	org_id bigint not null references users (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (org_id, user_id)
);
drop index if exists affiliations_user_idx;
create index if not exists affiliations_user_created_idx on affiliations (user_id, created_at);
create or replace function affiliations_cap() returns trigger language plpgsql as $$
begin
	perform 1 from users where id = new.user_id for update;
	if (select count(*) from affiliations where user_id = new.user_id) >= 4 then
		raise exception 'affiliation_limit' using errcode = 'P0001';
	end if;
	return new;
end $$;
drop trigger if exists affiliations_cap on affiliations;
create trigger affiliations_cap before insert on affiliations for each row execute function affiliations_cap();
-- instance-wide settings as key/value (sign-up mode, ...)
create table if not exists settings (
	key text primary key,
	value jsonb not null
);
alter table invites add column if not exists org_id bigint references users (id) on delete set null;
alter table invites add column if not exists revoked boolean not null default false;

-- reports from the client's Report post / Report account flow, for staff
create table if not exists reports (
	id bigint primary key,
	reporter_id bigint references users (id) on delete set null,
	-- what was reported: a post (and its author), or an account
	post_id bigint references posts (id) on delete set null,
	user_id bigint references users (id) on delete cascade,
	reason text not null,
	details text not null default '',
	-- open, dismissed or actioned
	status text not null default 'open',
	handled_by bigint references users (id) on delete set null,
	handled_at timestamptz,
	note text not null default '',
	created_at timestamptz not null default now()
);
create index if not exists reports_status_idx on reports (status, created_at desc);

-- for "About this account": when the badge was given, and past handles
alter table users add column if not exists verified_at timestamptz;
-- One-off data fixes run once, the first time a server that has them starts;
-- run on every start, the larger ones scanned whole tables each time.
create table if not exists schema_steps (
	name text primary key,
	done_at timestamptz not null default now()
);
do $$ begin
	if not exists (select 1 from schema_steps where name = 'verified_at') then
		update users set verified_at = created_at where verified_type is not null and verified_at is null;
		insert into schema_steps (name) values ('verified_at');
	end if;
end $$;
create table if not exists username_changes (
	user_id bigint not null references users (id) on delete cascade,
	old_name text not null,
	new_name text not null,
	changed_at timestamptz not null default now()
);
create index if not exists username_changes_user_idx on username_changes (user_id, changed_at desc);

-- sign-ups between the dialog's screens; kept here so a restart doesn't lose them
create table if not exists signup_sessions (
	token uuid primary key,
	username text not null,
	code text not null default '',
	created_at timestamptz not null default now()
);

-- Chat (src/chat.ts). Messages are encrypted by the browsers; what is kept is
-- each account's public keys, who is in which conversation, and every event as
-- the sealed blob the sender built, stamped by the server.
create table if not exists chat_keys (
	user_id bigint not null references users (id) on delete cascade,
	version bigint not null,
	public_key text not null,
	signing_public_key text not null,
	identity_public_key_signature text not null default '',
	registration_method text not null default 'CustomPin',
	created_at timestamptz not null default now(),
	primary key (user_id, version)
);
create table if not exists chat_members (
	conversation_id text not null,
	user_id bigint not null references users (id) on delete cascade,
	joined_at timestamptz not null default now(),
	primary key (conversation_id, user_id)
);
create index if not exists chat_members_user_idx on chat_members (user_id);
create table if not exists chat_events (
	seq bigint primary key,
	conversation_id text not null,
	sender_id bigint not null references users (id) on delete cascade,
	-- the event's detail: 1 message, 3 key change, 12 read, ... (chat.ts KIND)
	kind smallint not null,
	event bytea not null,
	created_at timestamptz not null default now()
);
create index if not exists chat_events_conversation_idx on chat_events (conversation_id, kind, seq desc);
-- a conversation's newest event of any kind (the inbox's order, chat.ts), and
-- each member's newest read marker
create index if not exists chat_events_conversation_seq_idx on chat_events (conversation_id, seq desc);
create index if not exists chat_events_sender_kind_idx on chat_events (conversation_id, kind, sender_id, seq desc);
create index if not exists chat_events_sender_idx on chat_events (sender_id);
-- messages since a mark (push.ts, mail-digest.ts)
create index if not exists chat_events_created_idx on chat_events (created_at);
alter table chat_members add column if not exists accepted boolean not null default true;
alter table chat_members add column if not exists archived boolean not null default false;
alter table chat_members add column if not exists muted boolean not null default false;
alter table chat_members add column if not exists deleted_before bigint not null default 0;
create table if not exists chat_conversations (
	id text primary key,
	creator_id bigint not null references users(id) on delete cascade,
	metadata jsonb not null default '{}',
	created boolean not null default false
);
create index if not exists chat_conversations_creator_idx on chat_conversations (creator_id);
create table if not exists chat_trust (
	user_id bigint not null references users(id) on delete cascade,
	trusted_id bigint not null references users(id) on delete cascade,
	primary key (user_id, trusted_id)
);
create index if not exists chat_trust_target_idx on chat_trust (trusted_id);
create table if not exists chat_hidden_events (
	user_id bigint not null references users(id) on delete cascade,
	seq bigint not null references chat_events(seq) on delete cascade,
	primary key (user_id, seq)
);
create index if not exists chat_hidden_events_seq_idx on chat_hidden_events (seq);
create table if not exists chat_uploads (
	hash text primary key,
	resume_id bigint not null unique,
	conversation_id text not null,
	message_id text not null,
	uploader_id bigint not null references users(id) on delete cascade,
	total_bytes bigint not null check (total_bytes > 0),
	ready boolean not null default false,
	expires_at timestamptz,
	created_at timestamptz not null default now()
);
create index if not exists chat_uploads_uploader_idx on chat_uploads (uploader_id);
alter table chat_events add column if not exists audience_id bigint references users(id) on delete cascade;
create index if not exists chat_events_audience_idx on chat_events (audience_id);
alter table chat_events add column if not exists deleted boolean not null default false;
alter table articles add column if not exists hidden boolean not null default false;
alter table users add column if not exists org_badge_id bigint references custom_badges(id) on delete set null;
create index if not exists users_org_badge_idx on users(org_badge_id);
alter table users add column if not exists remote_org_badge text;
create index if not exists users_status_until_idx on users(status_until) where status_until is not null;

create table if not exists lists (
	id bigint primary key,
	owner_id bigint not null references users (id) on delete cascade,
	name text not null,
	description text not null default '',
	is_private boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists lists_owner_idx on lists (owner_id);
alter table lists add column if not exists banner_media_id bigint;

create table if not exists list_members (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (list_id, user_id)
);
create index if not exists list_members_user_idx on list_members (user_id);

create table if not exists list_subscribers (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (list_id, user_id)
);
create index if not exists list_subscribers_user_idx on list_subscribers (user_id);

-- a muted list's accounts stay out of the viewer's home feeds
create table if not exists list_mutes (
	list_id bigint not null references lists (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	primary key (list_id, user_id)
);

-- lists shown as extra tabs on the viewer's home page
create table if not exists pinned_lists (
	user_id bigint not null references users (id) on delete cascade,
	list_id bigint not null references lists (id) on delete cascade,
	position int not null default 0,
	primary key (user_id, list_id)
);

create table if not exists communities (
	id bigint primary key,
	creator_id bigint not null references users (id) on delete cascade,
	name text not null,
	description text not null default '',
	question text not null default '',
	-- Open, RestrictedJoinRequestsRequireModeratorApproval, RestrictedJoinRequestsRequireAdminApproval, RestrictedJoinRequestsDisabled
	join_policy text not null default 'Open',
	-- MemberInvitesAllowed, ModeratorInvitesAllowed, AdminInvitesAllowed
	invites_policy text not null default 'MemberInvitesAllowed',
	is_nsfw boolean not null default false,
	banner_url text,
	created_at timestamptz not null default now()
);
create unique index if not exists communities_name_key on communities (lower(name));

create table if not exists community_members (
	community_id bigint not null references communities (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	role text not null default 'Member' check (role in ('Member', 'Moderator', 'Admin')),
	created_at timestamptz not null default now(),
	primary key (community_id, user_id)
);
create index if not exists community_members_user_idx on community_members (user_id);

create table if not exists community_rules (
	id bigint primary key,
	community_id bigint not null references communities (id) on delete cascade,
	name text not null,
	description text not null default '',
	position int not null default 0
);
create index if not exists community_rules_community_idx on community_rules (community_id, position);

create table if not exists community_join_requests (
	community_id bigint not null references communities (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	answer text not null default '',
	created_at timestamptz not null default now(),
	primary key (community_id, user_id)
);

alter table posts add column if not exists community_id bigint references communities (id) on delete set null;
create index if not exists posts_community_idx on posts (community_id, id desc) where community_id is not null;

create table if not exists polls (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	choices text[] not null,
	duration_minutes int not null,
	-- set when the post is created; the card exists before the post does
	ends_at timestamptz,
	created_at timestamptz not null default now()
);
-- an image poll: one uploaded photo per choice, in choice order
alter table polls add column if not exists choice_media bigint[];
create index if not exists polls_user_idx on polls (user_id, id);
create index if not exists polls_choice_media_idx on polls using gin (choice_media) where choice_media is not null;

create table if not exists poll_votes (
	poll_id bigint not null references polls (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	choice smallint not null,
	created_at timestamptz not null default now(),
	primary key (poll_id, user_id)
);

alter table posts add column if not exists poll_id bigint references polls (id) on delete set null;
create index if not exists poll_votes_user_idx on poll_votes (user_id, created_at, poll_id);
create index if not exists posts_poll_idx on posts (poll_id) where poll_id is not null;

-- scheduled posts and drafts, kept as the composer sent them
create table if not exists scheduled_posts (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	kind text not null check (kind in ('scheduled', 'draft')),
	execute_at timestamptz,
	request jsonb not null,
	created_at timestamptz not null default now()
);
create index if not exists scheduled_posts_due_idx on scheduled_posts (execute_at) where kind = 'scheduled';
create index if not exists scheduled_posts_user_idx on scheduled_posts (user_id, kind);
alter table scheduled_posts add column if not exists attempts int not null default 0;
alter table scheduled_posts add column if not exists last_error text;

alter table posts add column if not exists place_id text;

-- edits keep the post's id; what it said before each edit lives here under an
-- id of its own, so the client's edit history can fetch each version
alter table posts add column if not exists edit_count int not null default 0;
alter table posts add column if not exists edited_at timestamptz;
create table if not exists post_versions (
	version_id bigint primary key,
	post_id bigint not null references posts (id) on delete cascade,
	seq int not null,
	text text not null,
	-- when this version went up
	created_at timestamptz not null
);
create index if not exists post_versions_post_idx on post_versions (post_id, seq);

-- protected accounts: posts only for approved followers
alter table users add column if not exists protected boolean not null default false;
create table if not exists follow_requests (
	requester_id bigint not null references users (id) on delete cascade,
	target_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (requester_id, target_id),
	check (requester_id <> target_id)
);
create index if not exists follow_requests_target_idx on follow_requests (target_id, created_at desc);

-- bookmark folders: a viewer's own groups of bookmarked posts
create table if not exists bookmark_folders (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	name text not null,
	created_at timestamptz not null default now()
);
create index if not exists bookmark_folders_user_idx on bookmark_folders (user_id, created_at);
create table if not exists bookmark_folder_posts (
	folder_id bigint not null references bookmark_folders (id) on delete cascade,
	post_id bigint not null references posts (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (folder_id, post_id)
);
create index if not exists bookmark_folder_posts_page_idx on bookmark_folder_posts (folder_id, created_at desc, post_id desc);

-- the reply the conversation's author pinned under their post
alter table posts add column if not exists pinned_reply_id bigint references posts (id) on delete set null;

-- topics (topics.ts): staff name a subject and its keywords; people follow it or turn it down
create table if not exists topics (
	id bigint primary key,
	name text not null check (char_length(name) between 1 and 50),
	description text not null default '',
	keywords text[] not null,
	created_at timestamptz not null default now()
);
create unique index if not exists topics_name_key on topics (lower(name));
create table if not exists topic_follows (
	user_id bigint not null references users (id) on delete cascade,
	topic_id bigint not null references topics (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, topic_id)
);
create index if not exists topic_follows_topic_idx on topic_follows (topic_id);
create table if not exists topic_not_interested (
	user_id bigint not null references users (id) on delete cascade,
	topic_id bigint not null references topics (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, topic_id)
);
create index if not exists topic_not_interested_topic_idx on topic_not_interested (topic_id);

-- the bell on a profile: tell the user about every new post of target_id
create table if not exists post_notifications (
	user_id bigint not null references users (id) on delete cascade,
	target_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, target_id)
);
create index if not exists post_notifications_target_idx on post_notifications (target_id);
-- "Turn off reposts": target_id's reposts stay out of user_id's home feeds
create table if not exists repost_mutes (
	user_id bigint not null references users (id) on delete cascade,
	target_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (user_id, target_id)
);

-- for "About this account": the app and country an account signed up from
alter table users add column if not exists signup_source text;
alter table users add column if not exists signup_country text;
-- staff's own text for "Account based in", shown as typed instead of the detected region
alter table users add column if not exists based_in_override text;

-- address book uploads (Settings > Contacts); emails kept lowercase for matching
create table if not exists contacts (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	vcard text not null,
	emails text[] not null default '{}',
	created_at timestamptz not null default now()
);
create index if not exists contacts_user_idx on contacts (user_id, id);

-- news and sports cards at the top of Explore (explore-cards.ts)
create table if not exists explore_cards (
	id bigint primary key,
	kind text not null check (kind in ('news', 'sports')),
	title text not null,
	summary text not null default '',
	category text not null default '',
	query text not null,
	image bytea,
	image_mime text,
	image_width integer,
	image_height integer,
	home text not null default '',
	away text not null default '',
	home_score text not null default '',
	away_score text not null default '',
	state text check (state in ('Scheduled', 'InProgress', 'Completed', 'Postponed', 'Cancelled')),
	clock text not null default '',
	starts_at timestamptz,
	ends_at timestamptz,
	hidden boolean not null default false,
	position integer not null default 0,
	created_at timestamptz not null default now()
);

-- sign-ins (login-history.ts); sessions keep the address they started from
create table if not exists login_events (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	ip text,
	country text,
	app text not null,
	user_agent text,
	created_at timestamptz not null default now()
);
create index if not exists login_events_user_idx on login_events (user_id, created_at desc);
alter table sessions add column if not exists ip text;

-- a community's own banner (an upload of its admin) and its topic (one of topics.ts)
alter table communities add column if not exists banner_width integer;
alter table communities add column if not exists banner_height integer;
alter table communities add column if not exists topic_id bigint references topics (id) on delete set null;

-- grey badges: 'government' is an organisation (square picture), 'government_individual' an official
-- (replaced only while it lacks the new value: adding it checks every row)
do $$ begin
	if not exists (select 1 from pg_constraint where conname = 'users_verified_type_check' and pg_get_constraintdef(oid) like '%government_individual%') then
		alter table users drop constraint if exists users_verified_type_check;
		alter table users add constraint users_verified_type_check check (verified_type in ('blue', 'business', 'government', 'government_individual'));
	end if;
end $$;

-- every mail the instance tried to send (mail.ts)
create table if not exists mail_log (
	id bigint primary key,
	user_id bigint references users (id) on delete set null,
	to_addr text not null,
	kind text not null,
	subject text not null,
	status text not null check (status in ('sent', 'failed', 'skipped')),
	error text,
	created_at timestamptz not null default now()
);
create index if not exists mail_log_created_idx on mail_log (created_at desc);
-- when the activity and message digests last went to this account
alter table users add column if not exists activity_mailed_at timestamptz;
alter table users add column if not exists messages_mailed_at timestamptz;
-- when a digest last found nothing to mail (mail-digest.ts)
alter table users add column if not exists activity_checked_at timestamptz;
alter table users add column if not exists messages_checked_at timestamptz;

-- browser push subscriptions (push.ts); settings are the per-type switches
create table if not exists push_subscriptions (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	endpoint text not null unique,
	p256dh text not null,
	auth text not null,
	settings jsonb not null default '{}',
	last_pushed_at timestamptz not null default now(),
	created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- X's translator globe after the name: translator (blue), moderator (gold), approver (yellow)
alter table users add column if not exists translator text check (translator in ('translator', 'moderator', 'approver'));

-- email-address.ts: whether the address was proven (a sign-up code or a confirmation link)
alter table users add column if not exists email_verified boolean not null default false;
create table if not exists email_confirmations (
	token_hash text primary key,
	user_id bigint not null references users (id) on delete cascade,
	email text not null,
	used boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists email_confirmations_user_idx on email_confirmations (user_id);
-- a sign-up waiting for its emailed code keeps its checked form here (password hashed)
alter table signup_sessions add column if not exists pending jsonb;
alter table signup_sessions add column if not exists email_code_hash text;
alter table signup_sessions add column if not exists email_code_at timestamptz;
alter table signup_sessions add column if not exists email_attempts integer not null default 0;

-- errors.ts: server and browser errors for Admin > Errors, one row per distinct error;
-- a resolved error that happens again opens again
create table if not exists error_log (
	fingerprint text primary key,
	source text not null check (source in ('server', 'client', 'job')),
	message text not null,
	stack text,
	path text,
	user_id bigint,
	count integer not null default 1,
	first_at timestamptz not null default now(),
	last_at timestamptz not null default now(),
	resolved boolean not null default false
);
create index if not exists error_log_last_idx on error_log (last_at desc);

-- org-manage.ts: an organisation's own people manage its affiliates. A manager
-- is an affiliate who may; a request waits for the account to accept.
alter table affiliations add column if not exists manager boolean not null default false;
create table if not exists affiliation_requests (
	org_id bigint not null references users (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	requested_by bigint references users (id) on delete set null,
	created_at timestamptz not null default now(),
	primary key (org_id, user_id)
);
create index if not exists affiliation_requests_user_idx on affiliation_requests (user_id);

-- Account analytics: what isn't kept elsewhere. Unfollows as they happen, and
-- profile visits once per visitor and day.
create table if not exists unfollows (
	follower_id bigint not null references users (id) on delete cascade,
	followee_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now()
);
create index if not exists unfollows_followee_idx on unfollows (followee_id, created_at);
create table if not exists profile_visits (
	profile_id bigint not null references users (id) on delete cascade,
	visitor_id bigint not null references users (id) on delete cascade,
	day date not null default current_date,
	created_at timestamptz not null default now(),
	primary key (profile_id, visitor_id, day)
);
create index if not exists post_views_created_idx on post_views (created_at);

-- Sticker packs made by staff. A sticker is an image the composer attaches
-- like any other upload; the packs only feed the picker.
create table if not exists sticker_packs (
	id bigint primary key,
	name text not null check (char_length(name) between 1 and 40),
	position int not null default 0,
	created_at timestamptz not null default now()
);
create table if not exists stickers (
	id bigint primary key,
	pack_id bigint not null references sticker_packs (id) on delete cascade,
	name text not null default '' check (char_length(name) <= 40),
	image bytea not null,
	mime text not null,
	position int not null default 0,
	created_at timestamptz not null default now()
);
create index if not exists stickers_pack_idx on stickers (pack_id, position);

-- Personal API tokens (/account/api) for the public API under /api/v1. Only
-- the SHA-256 of a token is kept; "read" or "write" (which includes read).
create table if not exists api_tokens (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	name text not null check (char_length(name) between 1 and 40),
	token_hash text not null unique,
	scope text not null check (scope in ('read', 'write')),
	created_at timestamptz not null default now(),
	last_used_at timestamptz
);
create index if not exists api_tokens_user_idx on api_tokens (user_id);
-- Public OAuth clients use authorization-code + PKCE. They never receive a
-- client secret; users can revoke grants independently of personal tokens.
create table if not exists oauth_clients (
	id bigint primary key,
	owner_id bigint not null references users(id) on delete cascade,
	name text not null check (char_length(name) between 1 and 80),
	redirect_uri text not null,
	revoked boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists oauth_clients_owner_idx on oauth_clients(owner_id);
create table if not exists oauth_codes (
	code_hash text primary key,
	client_id bigint not null references oauth_clients(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	redirect_uri text not null,
	scope text not null check (scope in ('read', 'write')),
	code_challenge text not null,
	expires_at timestamptz not null
);
create index if not exists oauth_codes_expires_idx on oauth_codes(expires_at);
-- Apps identified by a client ID metadata document URL (oauth-metadata.ts)
-- get a row the first time someone approves them; they have no owner here.
alter table oauth_clients add column if not exists metadata_url text unique;
alter table oauth_clients alter column owner_id drop not null;
-- staff blocks (Admin > OAuth apps); a blocked app is also revoked
alter table oauth_clients add column if not exists blocked_at timestamptz;
alter table oauth_clients add column if not exists blocked_reason text;
-- the app's icon: uploaded by its developer (icon, icon_mime, icon_at), or the
-- logo_uri of its client ID metadata document
alter table oauth_clients add column if not exists icon bytea;
alter table oauth_clients add column if not exists icon_mime text;
alter table oauth_clients add column if not exists icon_at timestamptz;
alter table oauth_clients add column if not exists logo_uri text;
alter table api_tokens add column if not exists client_id bigint references oauth_clients(id) on delete cascade;
alter table api_tokens add column if not exists expires_at timestamptz;
create index if not exists api_tokens_client_idx on api_tokens(client_id, user_id) where client_id is not null;

-- Branded hashtags (X's hashflags): for a while, posts with the hashtag get a
-- custom like animation (Lottie JSON), and the hashtag an emoji after it.
create table if not exists hashflags (
	id bigint primary key,
	hashtag text not null,
	starts_at timestamptz not null,
	ends_at timestamptz not null,
	like_animation text,
	emoji bytea,
	emoji_mime text,
	hashfetti boolean not null default false,
	created_at timestamptz not null default now(),
	check (ends_at > starts_at),
	check (like_animation is not null or emoji is not null)
);

-- Staff tools on posts and accounts. notice: a label under a post, X's
-- softInterventionPivot ({type, text, url}; "Fosnr" also keeps it out of For
-- you and search). count_overrides: the counts shown, set by hand.
alter table posts add column if not exists notice jsonb;
alter table posts add column if not exists count_overrides jsonb;
alter table users add column if not exists count_overrides jsonb;

-- Replies the author of a conversation's first post hid from it (X's "Hide
-- reply"). They leave the conversation and show under "Hidden replies".
alter table posts add column if not exists reply_hidden_at timestamptz;
-- hidden-reply checks look up one conversation and only its hidden replies
create index if not exists posts_hidden_replies_idx on posts (conversation_id) where reply_hidden_at is not null;

-- X's Delegate: an account (owner) shares itself with members, who then act as
-- it from their own sign-in. Each account has one group, so the group's id is
-- the owner's. An invite stays Pending until the member accepts it.
create table if not exists delegation_members (
	id bigint primary key,
	owner_id bigint not null references users (id) on delete cascade,
	member_id bigint not null references users (id) on delete cascade,
	role text not null check (role in ('Admin', 'Contributor')),
	status text not null default 'Pending' check (status in ('Pending', 'Accepted')),
	invited_by bigint references users (id) on delete set null,
	created_at timestamptz not null default now(),
	unique (owner_id, member_id),
	check (owner_id <> member_id)
);
create index if not exists delegation_members_member_idx on delegation_members (member_id);
-- who may invite this account into theirs: Nobody, Everyone or OnlyFollowing
-- (people it follows), as the client names them. Everyone by default: an
-- invite still needs accepting, and with Nobody every invite failed with the
-- client's bare "Something went wrong". Accounts from before that are moved
-- over once, while the old default is still on the column.
alter table users add column if not exists delegation_invites text not null default 'Everyone'
	check (delegation_invites in ('Nobody', 'Everyone', 'OnlyFollowing'));
do $$ begin
	if (select column_default from information_schema.columns where table_name = 'users' and column_name = 'delegation_invites') = '''Nobody''::text' then
		update users set delegation_invites = 'Everyone' where delegation_invites = 'Nobody';
		alter table users alter column delegation_invites set default 'Everyone';
	end if;
end $$;
-- X's automated account label: the account that runs this one
alter table users add column if not exists automated_by bigint references users (id) on delete set null;

-- X's parody, commentary and fan account label (Settings > Your account >
-- Profile label), shown on the profile and the account's posts
alter table users add column if not exists parody_label text not null default 'None'
	check (parody_label in ('None', 'Parody', 'Commentary', 'Fan'));
-- when it last changed: the client warns further changes wait 48 hours
alter table users add column if not exists parody_label_at timestamptz;

create table if not exists link_previews (
	url text primary key,
	ok boolean not null,
	title text not null default '',
	description text not null default '',
	site text not null default '',
	image text,
	width int not null default 0,
	height int not null default 0,
	fetched_at timestamptz not null default now()
);
create index if not exists login_events_ip_idx on login_events (ip, created_at desc);
do $$ begin
	if not exists (select 1 from schema_steps where name = 'suspended_not_deactivated') then
		update users u set deactivated_at = null where u.deactivated_at is not null and u.status = 'suspended' and exists (
			select 1 from audit_log l where l.target = u.id::text and l.created_at > u.deactivated_at
				and l.action in ('set_status', 'temporary_status', 'bulk_status', 'auto_suspend_name', 'suspend_blocked_names', 'escalate'));
		insert into schema_steps (name) values ('suspended_not_deactivated');
	end if;
end $$;
create table if not exists retired_identities (
	kind text not null check (kind in ('handle', 'email', 'ip')),
	value text not null,
	user_id bigint,
	reason text not null default '',
	created_at timestamptz not null default now(),
	primary key (kind, value)
);

do $$ begin
	if not exists (select 1 from schema_steps where name = 'unretire_deactivated') then
		delete from retired_identities r where r.reason like 'deleted while suspended%' and not exists (
			select 1 from audit_log l where (l.target = r.user_id::text or (l.action = 'bulk_status' and l.detail->'ids' ? r.user_id::text))
				and l.action in ('set_status', 'temporary_status', 'bulk_status', 'auto_suspend_name', 'suspend_blocked_names', 'escalate'));
		insert into schema_steps (name) values ('unretire_deactivated');
	end if;
end $$;

-- Profile labels staff make in the admin panel, worn where X shows "Parody
-- account": the text, a custom badge as its icon (the parody mask without
-- one) and an optional link. Staff and parody/commentary/fan labels don't
-- share an account; an automated account can wear either (hiddenLabels).
create table if not exists account_labels (
	id bigint primary key,
	text text not null check (char_length(text) between 1 and 40),
	badge_id bigint references custom_badges(id) on delete set null,
	url text,
	created_at timestamptz not null default now()
);
alter table users add column if not exists label_id bigint references account_labels(id) on delete set null;

do $$ begin
	if not exists (select 1 from schema_steps where name = 'reply_to_user_id') then
		update posts p set reply_to_user_id = r.user_id from posts r where r.id = p.reply_to_id and p.reply_to_user_id is null;
		update posts set reply_to_id = conversation_id where reply_to_id is null and conversation_id <> id;
		insert into schema_steps (name) values ('reply_to_user_id');
	end if;
end $$;

alter table users add column if not exists role_granted_by bigint;
do $$ begin
	if not exists (select 1 from schema_steps where name = 'role_granted_by') then
		update users u set role_granted_by = (select a.actor_id from audit_log a where a.action = 'set_role' and a.target = u.id::text order by a.created_at desc limit 1)
			where u.role is not null and u.role_granted_by is null;
		insert into schema_steps (name) values ('role_granted_by');
	end if;
end $$;

do $$ begin
	if not exists (select 1 from schema_steps where name = 'chat_trust') then
		insert into chat_trust (user_id, trusted_id)
			select distinct e.sender_id, m.user_id from chat_events e join chat_members m on m.conversation_id = e.conversation_id and m.user_id <> e.sender_id
			where e.kind = 1 and e.conversation_id ~ '^[0-9]+[-:][0-9]+$'
			on conflict do nothing;
		update chat_members m set accepted = true where not m.accepted and m.conversation_id ~ '^[0-9]+[-:][0-9]+$'
			and exists (select 1 from chat_members peer join chat_trust t on t.user_id = m.user_id and t.trusted_id = peer.user_id
				where peer.conversation_id = m.conversation_id and peer.user_id <> m.user_id);
		insert into schema_steps (name) values ('chat_trust');
	end if;
end $$;

-- Account counters for userCols (users.ts), kept by the triggers below: counted
-- on every read, one account with 60k posts cost 80 ms on each of its post
-- cards. Posts with media go by the uploader, who is always the post's author
-- (media.ts attachMedia).
create table if not exists user_stats (
	user_id bigint primary key references users (id) on delete cascade,
	posts int not null default 0,
	articles int not null default 0,
	media_posts int not null default 0,
	likes int not null default 0,
	highlights int not null default 0,
	followers int not null default 0,
	following int not null default 0
);
create index if not exists media_user_post_idx on media (user_id, post_id) where post_id is not null;

create or replace function user_stats_posts() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		insert into user_stats (user_id, posts, articles)
			select user_id, count(*), count(article_id) from new_rows where not ad_only group by user_id
			on conflict (user_id) do update set posts = user_stats.posts + excluded.posts, articles = user_stats.articles + excluded.articles;
	else
		update user_stats s set posts = s.posts - d.posts, articles = s.articles - d.articles
			from (select user_id, count(*) as posts, count(article_id) as articles from old_rows where not ad_only group by user_id) d where s.user_id = d.user_id;
	end if;
	return null;
end $$;
create or replace trigger user_stats_posts_insert after insert on posts referencing new table as new_rows for each statement execute function user_stats_posts();
create or replace trigger user_stats_posts_delete after delete on posts referencing old table as old_rows for each statement execute function user_stats_posts();

create or replace function user_stats_likes() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		insert into user_stats (user_id, likes) select user_id, count(*) from new_rows group by user_id
			on conflict (user_id) do update set likes = user_stats.likes + excluded.likes;
	else
		update user_stats s set likes = s.likes - d.n from (select user_id, count(*) as n from old_rows group by user_id) d where s.user_id = d.user_id;
	end if;
	return null;
end $$;
create or replace trigger user_stats_likes_insert after insert on likes referencing new table as new_rows for each statement execute function user_stats_likes();
create or replace trigger user_stats_likes_delete after delete on likes referencing old table as old_rows for each statement execute function user_stats_likes();

create or replace function user_stats_highlights() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		insert into user_stats (user_id, highlights) select user_id, count(*) from new_rows group by user_id
			on conflict (user_id) do update set highlights = user_stats.highlights + excluded.highlights;
	else
		update user_stats s set highlights = s.highlights - d.n from (select user_id, count(*) as n from old_rows group by user_id) d where s.user_id = d.user_id;
	end if;
	return null;
end $$;
create or replace trigger user_stats_highlights_insert after insert on highlights referencing new table as new_rows for each statement execute function user_stats_highlights();
create or replace trigger user_stats_highlights_delete after delete on highlights referencing old table as old_rows for each statement execute function user_stats_highlights();

create or replace function user_stats_follows() returns trigger language plpgsql as $$
begin
	if tg_op = 'INSERT' then
		insert into user_stats (user_id, followers, following)
			select id, sum(followers), sum(following) from (
				select followee_id as id, 1 as followers, 0 as following from new_rows
				union all select follower_id, 0, 1 from new_rows
			) x group by id
			on conflict (user_id) do update set followers = user_stats.followers + excluded.followers, following = user_stats.following + excluded.following;
	else
		update user_stats s set followers = s.followers - d.followers, following = s.following - d.following
			from (select id, sum(followers) as followers, sum(following) as following from (
				select followee_id as id, 1 as followers, 0 as following from old_rows
				union all select follower_id, 0, 1 from old_rows
			) x group by id) d where s.user_id = d.id;
	end if;
	return null;
end $$;
create or replace trigger user_stats_follows_insert after insert on follows referencing new table as new_rows for each statement execute function user_stats_follows();
create or replace trigger user_stats_follows_delete after delete on follows referencing old table as old_rows for each statement execute function user_stats_follows();

-- posts with media are counted again for the uploaders whose attachments
-- changed: one index range each. An account being deleted is skipped, its
-- counters go with it.
create or replace function user_stats_media() returns trigger language plpgsql as $$
declare
	affected bigint[];
begin
	if tg_op = 'INSERT' then
		select array_agg(distinct user_id) into affected from new_rows where post_id is not null;
	elsif tg_op = 'DELETE' then
		select array_agg(distinct user_id) into affected from old_rows where post_id is not null;
	else
		select array_agg(distinct n.user_id) into affected from new_rows n join old_rows o on o.id = n.id where n.post_id is distinct from o.post_id;
	end if;
	if affected is null then return null; end if;
	insert into user_stats (user_id, media_posts)
		select a, (select count(distinct m.post_id) from media m where m.user_id = a and m.post_id is not null)
		from unnest(affected) a where exists (select 1 from users where id = a)
		on conflict (user_id) do update set media_posts = excluded.media_posts;
	return null;
end $$;
create or replace trigger user_stats_media_insert after insert on media referencing new table as new_rows for each statement execute function user_stats_media();
create or replace trigger user_stats_media_update after update on media referencing new table as new_rows old table as old_rows for each statement execute function user_stats_media();
create or replace trigger user_stats_media_delete after delete on media referencing old table as old_rows for each statement execute function user_stats_media();

do $$ begin
	if not exists (select 1 from schema_steps where name = 'user_stats') then
		insert into user_stats (user_id, posts, articles, media_posts, likes, highlights, followers, following)
			select u.id,
				(select count(*) from posts x where x.user_id = u.id),
				(select count(*) from posts x where x.user_id = u.id and x.article_id is not null),
				(select count(distinct m.post_id) from media m where m.user_id = u.id and m.post_id is not null),
				(select count(*) from likes x where x.user_id = u.id),
				(select count(*) from highlights x where x.user_id = u.id),
				(select count(*) from follows x where x.followee_id = u.id),
				(select count(*) from follows x where x.follower_id = u.id)
			from users u
			on conflict (user_id) do update set posts = excluded.posts, articles = excluded.articles, media_posts = excluded.media_posts,
				likes = excluded.likes, highlights = excluded.highlights, followers = excluded.followers, following = excluded.following;
		insert into schema_steps (name) values ('user_stats');
	end if;
end $$;

-- federation (federation.ts, federation-sync.ts): accounts, posts and media
-- from other instances are kept here as rows of their own, mapped to their id
-- on the instance they come from
alter table users add column if not exists instance text;
alter table users add column if not exists remote_id bigint;
alter table users add column if not exists instance_blocked boolean not null default false;
create unique index if not exists users_remote_idx on users (instance, remote_id) where instance is not null;
alter table media add column if not exists remote_instance text;
alter table media add column if not exists remote_id bigint;
alter table sessions add column if not exists expires_at timestamptz;
alter table sessions add column if not exists superadmin boolean not null default false;
alter table sessions add column if not exists impersonator_id bigint references users(id) on delete cascade;
create table if not exists federated_objects (
	instance text not null,
	kind text not null check (kind in ('user', 'post', 'media')),
	remote_id bigint not null,
	local_id bigint not null,
	primary key (instance, kind, remote_id)
);
create unique index if not exists federated_objects_local_idx on federated_objects (kind, local_id);
create table if not exists federation_outbox (
	seq bigserial primary key,
	kind text not null check (kind in ('user', 'post', 'like', 'repost', 'follow')),
	a bigint not null,
	b bigint,
	created_at timestamptz not null default now()
);
create index if not exists federation_outbox_created_idx on federation_outbox (created_at);
create table if not exists federation_peers (
	instance text primary key,
	cursor bigint not null default 0,
	key text,
	last_ok_at timestamptz,
	last_error text,
	last_error_at timestamptz
);
do $$ begin
	if not exists (select 1 from pg_constraint where conname = 'federation_peers_key_check') then
		update federation_peers set key = null where key !~ '^[A-Za-z0-9_-]{43}$';
		alter table federation_peers add constraint federation_peers_key_check check (key ~ '^[A-Za-z0-9_-]{43}$');
	end if;
end $$;
create table if not exists federation_blocks (
	instance text primary key,
	source text not null check (source in ('local', 'emergency', 'registry')),
	reason text not null default '',
	by_id bigint,
	by_name text,
	created_at timestamptz not null default now()
);
alter table federation_blocks add column if not exists kept_local jsonb;
create table if not exists federation_state (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists federation_emergencies (
	seq bigint primary key,
	instance text not null,
	action text not null check (action in ('block', 'lift')),
	reason text not null default '',
	by_name text not null,
	issuer text not null,
	envelope jsonb not null,
	created_at timestamptz not null default now()
);
create table if not exists superadmin_tickets (nonce text primary key, used_at timestamptz not null default now());

create or replace function federation_local(uid bigint) returns boolean language sql stable as $$
	select exists (select 1 from users where id = uid and instance is null)
$$;
create or replace function federation_post_changed() returns trigger language plpgsql as $$
begin
	if tg_op = 'DELETE' then
		if federation_local(old.user_id) then insert into federation_outbox (kind, a) values ('post', old.id); end if;
		return old;
	end if;
	if federation_local(new.user_id) then insert into federation_outbox (kind, a) values ('post', new.id); end if;
	return new;
end $$;
create or replace trigger federation_post_insert after insert on posts for each row execute function federation_post_changed();
create or replace trigger federation_post_update after update of text, hidden, edited_at, sensitive, count_overrides on posts for each row
	when (old.text is distinct from new.text or old.hidden is distinct from new.hidden or old.edited_at is distinct from new.edited_at or old.sensitive is distinct from new.sensitive
		or old.count_overrides is distinct from new.count_overrides)
	execute function federation_post_changed();
create or replace trigger federation_post_delete before delete on posts for each row execute function federation_post_changed();

create or replace function federation_pair_changed() returns trigger language plpgsql as $$
declare
	actor bigint;
	target bigint;
begin
	if tg_table_name = 'follows' then
		actor := coalesce(new.follower_id, old.follower_id);
		target := coalesce(new.followee_id, old.followee_id);
	else
		actor := coalesce(new.user_id, old.user_id);
		target := coalesce(new.post_id, old.post_id);
	end if;
	if federation_local(actor) then
		insert into federation_outbox (kind, a, b) values (case tg_table_name when 'likes' then 'like' when 'reposts' then 'repost' else 'follow' end, actor, target);
	end if;
	return null;
end $$;
create or replace trigger federation_like_change after insert or delete on likes for each row execute function federation_pair_changed();
create or replace trigger federation_repost_change after insert or delete on reposts for each row execute function federation_pair_changed();
create or replace trigger federation_follow_change after insert or delete on follows for each row execute function federation_pair_changed();

create or replace function federation_user_changed() returns trigger language plpgsql as $$
begin
	if tg_op = 'DELETE' then
		if old.instance is null then insert into federation_outbox (kind, a) values ('user', old.id); end if;
		return old;
	end if;
	if new.instance is null then insert into federation_outbox (kind, a) values ('user', new.id); end if;
	return new;
end $$;
create or replace trigger federation_user_insert after insert on users for each row execute function federation_user_changed();
alter table users add column if not exists decoration jsonb;
create or replace trigger federation_user_update after update of screen_name, name, bio, location, website, avatar_url, banner_url, protected, status, deactivated_at, verified_type, translator, flag, pronouns, parody_label, count_overrides, decoration, org_badge_id on users for each row
	when (old.screen_name is distinct from new.screen_name or old.name is distinct from new.name or old.bio is distinct from new.bio or old.location is distinct from new.location or old.website is distinct from new.website
		or old.avatar_url is distinct from new.avatar_url or old.banner_url is distinct from new.banner_url or old.protected is distinct from new.protected
		or old.status is distinct from new.status or old.deactivated_at is distinct from new.deactivated_at or old.verified_type is distinct from new.verified_type
		or old.translator is distinct from new.translator or old.flag is distinct from new.flag or old.pronouns is distinct from new.pronouns or old.parody_label is distinct from new.parody_label
		or old.count_overrides is distinct from new.count_overrides or old.decoration is distinct from new.decoration or old.org_badge_id is distinct from new.org_badge_id)
	execute function federation_user_changed();
create or replace function federation_badges_changed() returns trigger language plpgsql as $$
begin
	insert into federation_outbox (kind, a) select 'user', u.id from users u where u.id = coalesce(new.user_id, old.user_id) and u.instance is null;
	return null;
end $$;
create or replace trigger federation_user_badges after insert or delete on user_badges for each row execute function federation_badges_changed();
create or replace trigger federation_user_delete before delete on users for each row execute function federation_user_changed();
create table if not exists affiliation_votes (
	org_id bigint not null references users (id) on delete cascade,
	user_id bigint not null references users (id) on delete cascade,
	side text not null check (side in ('org', 'member')),
	primary key (org_id, user_id, side)
);
alter table federation_outbox drop constraint if exists federation_outbox_kind_check;
alter table federation_outbox add constraint federation_outbox_kind_check check (kind in ('user', 'post', 'like', 'repost', 'follow', 'affiliate', 'affiliation')) not valid;
create or replace function federation_affiliation_changed() returns trigger language plpgsql as $$
declare
	org bigint := coalesce(new.org_id, old.org_id);
	member bigint := coalesce(new.user_id, old.user_id);
begin
	if federation_local(org) then
		if tg_table_name = 'affiliations' or not federation_local(member) then
			insert into federation_outbox (kind, a, b) values ('affiliate', org, member);
		end if;
	elsif federation_local(member) and (tg_table_name = 'affiliations' or tg_op = 'DELETE') then
		insert into federation_outbox (kind, a, b) values ('affiliation', member, org);
	end if;
	return null;
end $$;
create or replace trigger federation_affiliation_change after insert or delete on affiliations for each row execute function federation_affiliation_changed();
create or replace trigger federation_affiliation_request_change after insert or delete on affiliation_requests for each row execute function federation_affiliation_changed();
do $$ begin
	if not exists (select 1 from schema_steps where name = 'federation_affiliations') then
		insert into federation_outbox (kind, a, b) select 'affiliate', a.org_id, a.user_id from affiliations a join users o on o.id = a.org_id where o.instance is null;
		insert into schema_steps (name) values ('federation_affiliations');
	end if;
end $$;

do $$ begin
	if not exists (select 1 from schema_steps where name = 'federation_backfill') then
		insert into federation_outbox (kind, a) select 'user', id from users where instance is null order by id;
		insert into federation_outbox (kind, a) select 'post', p.id from posts p join users u on u.id = p.user_id
			where u.instance is null and not u.protected and p.created_at > now() - interval '30 days' order by p.id;
		insert into schema_steps (name) values ('federation_backfill');
	end if;
end $$;

create or replace function federated_object_gone() returns trigger language plpgsql as $$
begin
	delete from federated_objects where kind = tg_argv[0] and local_id = old.id;
	return old;
end $$;
create or replace trigger federated_user_gone after delete on users for each row when (old.instance is not null) execute function federated_object_gone('user');
create or replace trigger federated_post_gone after delete on posts for each row execute function federated_object_gone('post');
create or replace trigger federated_media_gone after delete on media for each row when (old.remote_instance is not null) execute function federated_object_gone('media');
do $$ begin
	if not exists (select 1 from schema_steps where name = 'federated_objects_prune') then
		delete from federated_objects f where kind = 'user' and not exists (select 1 from users where id = f.local_id);
		delete from federated_objects f where kind = 'post' and not exists (select 1 from posts where id = f.local_id);
		delete from federated_objects f where kind = 'media' and not exists (select 1 from media where id = f.local_id);
		insert into schema_steps (name) values ('federated_objects_prune');
	end if;
end $$;

create or replace function blocks_spare_admins() returns trigger language plpgsql as $$
begin
	if exists (select 1 from users b join users t on t.id = new.blocked_id where b.id = new.blocker_id and b.instance is null and t.role = 'admin' and t.instance is null) then
		return null;
	end if;
	return new;
end $$;
drop trigger if exists blocks_spare_admins on blocks;
create trigger blocks_spare_admins before insert on blocks for each row execute function blocks_spare_admins();
create or replace function admins_unblocked() returns trigger language plpgsql as $$
begin
	if new.role = 'admin' and old.role is distinct from 'admin' and new.instance is null then
		delete from blocks bl using users b where bl.blocked_id = new.id and b.id = bl.blocker_id and b.instance is null;
	end if;
	return new;
end $$;
drop trigger if exists users_admins_unblocked on users;
create trigger users_admins_unblocked after update of role on users for each row execute function admins_unblocked();
delete from blocks bl using users b, users t where b.id = bl.blocker_id and t.id = bl.blocked_id and b.instance is null and t.role = 'admin' and t.instance is null;

-- Imports of X archives (archive-import.ts): one per account, the latest. The
-- zip waits in ARCHIVE_DIR while it uploads and imports, and goes when done.
create table if not exists archive_imports (
	user_id bigint primary key references users (id) on delete cascade,
	state text not null check (state in ('uploading', 'queued', 'running', 'done', 'failed')),
	size bigint not null default 0,
	options jsonb not null default '{}',
	total int not null default 0,
	posts int not null default 0,
	media int not null default 0,
	skipped int not null default 0,
	error text,
	updated_at timestamptz not null default now()
);
-- posts the instance's rules left out, and when a paused import (the post
-- rate limit) carries on
alter table archive_imports add column if not exists refused int not null default 0;
alter table archive_imports add column if not exists waiting_until timestamptz;
-- 'pending': waiting for staff to approve it (Admin > Settings, Import from X)
alter table archive_imports drop constraint if exists archive_imports_state_check;
alter table archive_imports add constraint archive_imports_state_check check (state in ('uploading', 'pending', 'queued', 'running', 'done', 'failed'));

-- profile decor for gold-check accounts, from the Steam Points Shop (decor.ts)
alter table users add column if not exists decor jsonb;

alter table posts add column if not exists conversation_card jsonb;

alter table posts add column if not exists conversation_card_post_id bigint references posts (id) on delete set null;

create table if not exists post_translations (
	post_id bigint not null references posts (id) on delete cascade,
	version int not null,
	target_lang text not null,
	source_hash text not null,
	source_lang text not null,
	text text not null,
	created_at timestamptz not null default now(),
	primary key (post_id, version, target_lang)
);

create table if not exists bio_translations (
	user_id bigint not null references users (id) on delete cascade,
	target_lang text not null,
	source_hash text not null,
	source_lang text not null,
	text text not null,
	created_at timestamptz not null default now(),
	primary key (user_id, target_lang)
);

-- account migration between instances (migration.ts, migration-import.ts).
-- The old instance hands out a migration code (stored as its SHA-256) that
-- lets the new one read the account's archive and files; the new instance
-- keeps a job per import and maps every object it brought over, so running
-- the same import again resumes instead of duplicating.
create table if not exists migration_tokens (
	token_hash text primary key,
	user_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	expires_at timestamptz not null,
	-- the instance that last used it, and when the import there finished
	used_by text,
	used_at timestamptz,
	completed_at timestamptz
);
create index if not exists migration_tokens_user_idx on migration_tokens (user_id);
create table if not exists account_migrations (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	source text not null,
	source_user_id bigint not null,
	source_handle text not null,
	state text not null check (state in ('running', 'done', 'failed')),
	progress jsonb not null default '{}',
	report jsonb not null default '{}',
	error text,
	created_at timestamptz not null default now(),
	finished_at timestamptz
);
create index if not exists account_migrations_user_idx on account_migrations (user_id, created_at desc);
create unique index if not exists account_migrations_running_idx on account_migrations (user_id) where state = 'running';
-- when the old instance's wallet came over (money-federation.ts): once per move
alter table account_migrations add column if not exists balance_moved_at timestamptz;
create table if not exists migration_objects (
	user_id bigint not null references users (id) on delete cascade,
	source text not null,
	kind text not null,
	remote_id text not null,
	local_id bigint not null,
	created_at timestamptz not null default now(),
	primary key (user_id, source, kind, remote_id)
);
-- when it came over: a move gets a daily allowance of posts (migration-import.ts)
alter table migration_objects add column if not exists created_at timestamptz not null default now();
-- where an account went, as handle@instance; set by the new instance when the import finished
alter table users add column if not exists moved_to text;
alter table users add column if not exists moved_at timestamptz;
-- Equicoins (money.ts): each account's balance in cents, made on first use with
-- the instance's starting balance, and every transfer between accounts
create table if not exists money_wallets (
	user_id bigint primary key references users (id) on delete cascade,
	balance_cents bigint not null check (balance_cents >= 0),
	created_at timestamptz not null default now()
);
create table if not exists money_transfers (
	id bigint primary key,
	sender_id bigint not null references users (id) on delete cascade,
	recipient_id bigint not null references users (id) on delete cascade,
	amount_cents bigint not null check (amount_cents > 0),
	note text not null default '',
	-- the form's one-time key, so a double-pressed Send moves the money once
	idem text not null,
	created_at timestamptz not null default now(),
	check (sender_id <> recipient_id)
);
alter table money_transfers add column if not exists federation_status text not null default 'complete';
alter table money_transfers drop constraint if exists money_transfers_federation_status_check;
alter table money_transfers add constraint money_transfers_federation_status_check check (federation_status in ('pending', 'complete', 'failed'));
create table if not exists money_federation_outbox (
	transfer_id bigint primary key references money_transfers(id) on delete cascade,
	destination text not null,
	sender_id bigint not null references users(id) on delete cascade,
	recipient_id bigint not null,
	amount_cents bigint not null check (amount_cents > 0),
	note text not null default '',
	attempts int not null default 0,
	next_attempt timestamptz not null default now(),
	last_error text,
	created_at timestamptz not null default now()
);
create index if not exists money_federation_outbox_due_idx on money_federation_outbox (next_attempt);
create table if not exists money_federation_receipts (
	origin text not null,
	transfer_id bigint not null,
	created_at timestamptz not null default now(),
	primary key (origin, transfer_id)
);
-- what each peer sent, for money.peer_daily_cents; a moved account's balance doesn't count
alter table money_federation_receipts add column if not exists amount_cents bigint not null default 0;
alter table money_federation_receipts add column if not exists move boolean not null default false;
create index if not exists money_federation_receipts_day_idx on money_federation_receipts (origin, created_at);
alter table money_federation_outbox add column if not exists move boolean not null default false;
create unique index if not exists money_transfers_idem_idx on money_transfers (sender_id, idem);
create index if not exists money_transfers_sender_idx on money_transfers (sender_id, id desc);
create index if not exists money_transfers_recipient_idx on money_transfers (recipient_id, id desc);
-- money requests (money.ts): asked of one account, or of anyone (payer_id
-- null: a "Pay @name" card in a post, paid as often as people like)
create table if not exists money_requests (
	id bigint primary key,
	requester_id bigint not null references users (id) on delete cascade,
	payer_id bigint references users (id) on delete cascade,
	amount_cents bigint check (amount_cents > 0),
	note text not null default '',
	status text not null default 'open' check (status in ('open', 'paid', 'declined', 'cancelled')),
	created_at timestamptz not null default now(),
	resolved_at timestamptz,
	check (payer_id is null or amount_cents is not null),
	check (payer_id is distinct from requester_id)
);
create index if not exists money_requests_requester_idx on money_requests (requester_id, id desc);
create index if not exists money_requests_payer_idx on money_requests (payer_id, id desc) where payer_id is not null;
alter table money_transfers add column if not exists request_id bigint references money_requests (id) on delete set null;
-- merchant mode (Settings > Equicoins), for gold organisations: payments to
-- them read as purchases ("$3.52 at Taco Bell")
create table if not exists money_merchants (
	user_id bigint primary key references users (id) on delete cascade,
	name text not null default '',
	show_banner boolean not null default true,
	updated_at timestamptz not null default now()
);
-- what each like paid the post's author, once per post and account
create table if not exists money_like_rewards (
	post_id bigint not null,
	liker_id bigint not null references users (id) on delete cascade,
	author_id bigint not null references users (id) on delete cascade,
	cents bigint not null,
	created_at timestamptz not null default now(),
	primary key (post_id, liker_id)
);
create index if not exists money_like_rewards_author_idx on money_like_rewards (author_id, created_at desc);
-- Equicoins shop: listings can award an existing custom badge or submit an
-- instance announcement for staff approval. Orders hold the price until reviewed.
create table if not exists money_shop_items (
	id bigint primary key,
	name text not null check (char_length(name) between 1 and 60),
	description text not null default '' check (char_length(description) <= 240),
	price_cents bigint not null check (price_cents > 0),
	kind text not null check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost')),
	badge_id bigint references custom_badges(id) on delete set null,
	active boolean not null default true,
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	created_by bigint references users(id) on delete set null,
	approved_by bigint references users(id) on delete set null,
	approved_at timestamptz,
	created_at timestamptz not null default now(),
	check ((kind = 'badge' and badge_id is not null) or kind <> 'badge')
);
alter table money_shop_items add column if not exists status text not null default 'pending';
alter table money_shop_items add column if not exists created_by bigint references users(id) on delete set null;
alter table money_shop_items add column if not exists approved_by bigint references users(id) on delete set null;
alter table money_shop_items add column if not exists approved_at timestamptz;
alter table money_shop_items drop constraint if exists money_shop_items_status_check;
alter table money_shop_items add constraint money_shop_items_status_check check (status in ('pending', 'approved', 'rejected'));
-- Existing listings must be reviewed under the new policy before anyone can buy them.
update money_shop_items set active = false where status = 'pending';
alter table money_shop_items drop constraint if exists money_shop_items_kind_check;
alter table money_shop_items add constraint money_shop_items_kind_check check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost'));
alter table money_shop_items drop constraint if exists money_shop_items_check;
alter table money_shop_items add constraint money_shop_items_check check ((kind = 'badge' and badge_id is not null) or kind <> 'badge');
-- Federated listings are cached for review on every receiving instance. They
-- stay hidden until a local moderator approves them, and source changes reset
-- that approval so edited listings are reviewed again.
create table if not exists money_remote_shop_items (
	origin text not null,
	remote_id bigint not null,
	name text not null,
	description text not null default '',
	price_cents bigint not null check (price_cents > 0),
	kind text not null check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost')),
	badge_name text,
	badge_image bytea,
	badge_mime text,
	source_active boolean not null default true,
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	active boolean not null default false,
	reviewed_by bigint references users(id) on delete set null,
	reviewed_at timestamptz,
	updated_at timestamptz not null default now(),
	primary key (origin, remote_id),
	check ((kind = 'badge' and badge_name is not null and badge_image is not null and badge_mime is not null) or kind <> 'badge')
);
create index if not exists money_remote_shop_visible_idx on money_remote_shop_items (origin, updated_at desc) where source_active and active and status = 'approved';
create table if not exists money_shop_orders (
	id bigint primary key,
	user_id bigint not null references users(id) on delete cascade,
	item_id bigint references money_shop_items(id) on delete set null,
	item_name text not null,
	price_cents bigint not null check (price_cents > 0),
	kind text not null check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost')),
	payload jsonb not null default '{}'::jsonb,
	status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
	created_at timestamptz not null default now(),
	reviewed_at timestamptz,
	reviewed_by bigint references users(id) on delete set null
);
alter table money_shop_orders drop constraint if exists money_shop_orders_kind_check;
alter table money_shop_orders add constraint money_shop_orders_kind_check check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost'));
create index if not exists money_shop_orders_pending_idx on money_shop_orders (created_at) where status = 'pending';
create index if not exists money_shop_orders_user_idx on money_shop_orders (user_id, id desc);
alter table money_remote_shop_items drop constraint if exists money_remote_shop_items_kind_check;
alter table money_remote_shop_items add constraint money_remote_shop_items_kind_check check (kind in ('badge', 'custom_badge', 'announcement', 'checkmark', 'invite', 'hashflag', 'sticker_pack', 'explore_card', 'boost'));
-- a checkmark, hashflag, Explore card or boost lasts this many days
alter table money_shop_items add column if not exists days integer check (days between 1 and 365);
alter table money_remote_shop_items add column if not exists days integer;
alter table money_shop_orders add column if not exists days integer;
-- a gift: delivered to this account instead of the buyer
alter table money_shop_orders add column if not exists recipient_id bigint references users(id) on delete cascade;
create index if not exists money_shop_orders_gift_idx on money_shop_orders (recipient_id, reviewed_at desc) where recipient_id is not null;
-- pictures sent with a request (a sticker pack, a hashflag's emoji, an Explore
-- card's picture), kept until staff review it
create table if not exists money_shop_order_files (
	order_id bigint not null references money_shop_orders(id) on delete cascade,
	position integer not null,
	name text not null default '',
	image bytea not null,
	mime text not null,
	primary key (order_id, position)
);
-- a blue checkmark bought in the shop comes off when this passes (money-shop.ts);
-- one staff give has none
alter table users add column if not exists shop_verified_until timestamptz;
-- boosted posts: For you shows one, marked as an ad, on each page until ends_at
create table if not exists post_boosts (
	id bigint primary key,
	post_id bigint not null references posts(id) on delete cascade,
	user_id bigint not null references users(id) on delete cascade,
	order_id bigint references money_shop_orders(id) on delete set null,
	created_at timestamptz not null default now(),
	ends_at timestamptz not null
);
create index if not exists post_boosts_ends_idx on post_boosts (ends_at);
-- when the account accepted Equicoins' disclaimer (money-page.ts), shown the first time Equicoins opens
alter table money_wallets add column if not exists disclaimer_at timestamptz;
-- a payment staff reversed (Admin > Money): the money went back to its sender
alter table money_transfers add column if not exists reversed_at timestamptz;
alter table money_transfers add column if not exists reversed_by bigint references users (id) on delete set null;
-- a file media-compress.ts has already made smaller (or tried to): the sweep
-- over stored files passes it by, so a photo isn't encoded again and again
alter table media add column if not exists compressed boolean not null default false;

alter table posts add column if not exists reply_selections text[] not null default '{}';
alter table posts add column if not exists reply_allowed_values text[] not null default '{}';

do $$ begin
	if to_regclass('reply_country_catalog') is null then
		create table reply_country_catalog (value text primary key, account_count bigint not null);
		insert into reply_country_catalog (value, account_count)
		select value, count(*) from users u cross join lateral
			(select distinct trim(v) as value from unnest(array[u.country, u.based_in_override]) v where nullif(trim(v), '') is not null) c
		group by value;
	end if;
end $$;

create or replace function update_reply_country_catalog() returns trigger language plpgsql as $$
declare
	previous_values text[] := '{}';
	next_values text[] := '{}';
	entry text;
	delta integer;
begin
	if TG_OP <> 'INSERT' then
		select array_agg(distinct trim(v)) into previous_values from unnest(array[OLD.country, OLD.based_in_override]) v where nullif(trim(v), '') is not null;
	end if;
	if TG_OP <> 'DELETE' then
		select array_agg(distinct trim(v)) into next_values from unnest(array[NEW.country, NEW.based_in_override]) v where nullif(trim(v), '') is not null;
	end if;
	previous_values := coalesce(previous_values, '{}');
	next_values := coalesce(next_values, '{}');
	for entry in select distinct unnest(previous_values || next_values) order by 1 loop
		delta := (entry = any(next_values))::integer - (entry = any(previous_values))::integer;
		if delta = 1 then
			insert into reply_country_catalog (value, account_count) values (entry, 1)
				on conflict (value) do update set account_count = reply_country_catalog.account_count + 1;
		elsif delta = -1 then
			update reply_country_catalog set account_count = account_count - 1 where value = entry;
			delete from reply_country_catalog where value = entry and account_count = 0;
		end if;
	end loop;
	return null;
end $$;

drop trigger if exists users_reply_country_catalog on users;
create trigger users_reply_country_catalog after insert or delete or update of country, based_in_override on users
	for each row execute function update_reply_country_catalog();

-- Circles (circles.ts): the people who see an account's Circle posts, and on
-- each post in a Circle (replies too), whose Circle it is
create table if not exists circle_members (
	owner_id bigint not null references users (id) on delete cascade,
	member_id bigint not null references users (id) on delete cascade,
	created_at timestamptz not null default now(),
	primary key (owner_id, member_id)
);
create index if not exists circle_members_member_idx on circle_members (member_id);
alter table posts add column if not exists circle_owner_id bigint references users (id) on delete cascade;
create index if not exists posts_circle_owner_idx on posts (circle_owner_id) where circle_owner_id is not null;

-- Direct messages of the 2020 web client (legacy-dm.ts). Unencrypted, unlike
-- XChat, which that client can't read; these chats exist only in old clients.
-- A one-to-one conversation's id is "<smaller user id>-<larger user id>".
create table if not exists legacy_dm_participants (
	conversation_id text not null,
	user_id bigint not null references users (id) on delete cascade,
	last_read_event_id bigint not null default 0,
	-- left the conversation: hidden from the inbox until a new message arrives
	left_at_event_id bigint,
	primary key (conversation_id, user_id)
);
create index if not exists legacy_dm_participants_user_idx on legacy_dm_participants (user_id);
create table if not exists legacy_dm_events (
	id bigint primary key,
	conversation_id text not null,
	sender_id bigint not null references users (id) on delete cascade,
	text text not null,
	request_id text,
	created_at timestamptz not null default now()
);
create index if not exists legacy_dm_events_conversation_idx on legacy_dm_events (conversation_id, id);
alter table users add column if not exists legacy_dm_last_seen bigint not null default 0;
-- hidden by the Claude moderator (claude-mod.ts): gone for both sides, kept for staff
alter table legacy_dm_events add column if not exists hidden boolean not null default false;

-- media-scan.ts: when the photo's signed copy went through Cloudflare's cache,
-- when it was last asked for again, and when Cloudflare's CSAM tool blocked it
alter table media add column if not exists scan_warmed_at timestamptz;
alter table media add column if not exists scan_checked_at timestamptz;
alter table media add column if not exists scan_blocked_at timestamptz;
create index if not exists media_scan_todo_idx on media (id) where kind = 'photo' and scan_warmed_at is null;

create table if not exists grok_conversations (
	id bigint primary key,
	user_id bigint not null references users(id) on delete cascade,
	title text not null default '',
	pinned boolean not null default false,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create index if not exists grok_conversations_user on grok_conversations (user_id, updated_at desc);
create table if not exists grok_items (
	id bigint primary key,
	conversation_id bigint not null references grok_conversations(id) on delete cascade,
	sender text not null check (sender in ('User', 'Agent')),
	message text not null,
	created_at timestamptz not null default now()
);
create index if not exists grok_items_conversation on grok_items (conversation_id, id);

create table if not exists ads (
	id bigint primary key,
	user_id bigint not null references users (id) on delete cascade,
	text text not null,
	url text,
	budget_cents bigint not null check (budget_cents > 0),
	spent_cents bigint not null default 0 check (spent_cents >= 0 and spent_cents <= budget_cents),
	refunded_cents bigint not null default 0 check (refunded_cents >= 0),
	days int not null check (days > 0),
	status text not null check (status in ('pending', 'running', 'paused', 'ended', 'rejected', 'cancelled')),
	reject_reason text,
	created_at timestamptz not null default now(),
	reviewed_at timestamptz,
	reviewed_by bigint references users (id) on delete set null,
	starts_at timestamptz,
	ends_at timestamptz
);
create index if not exists ads_status_idx on ads (status, ends_at);
create index if not exists ads_user_idx on ads (user_id, id desc);
alter table ads add column if not exists ad_only boolean not null default true;
alter table ads add column if not exists post_id bigint references posts (id) on delete set null;
alter table ads add column if not exists spent_milli bigint not null default 0;
alter table ads add column if not exists views int not null default 0;
create table if not exists ad_views (
	ad_id bigint not null references ads (id) on delete cascade,
	viewer_id bigint not null references users (id) on delete cascade,
	day date not null default current_date,
	n int not null default 0,
	last_at timestamptz not null default now(),
	primary key (ad_id, viewer_id, day)
);
alter table ad_views add column if not exists shown int not null default 0;
alter table ad_views alter column day set default (now() at time zone 'utc')::date;
alter table ad_views alter column last_at set default '-infinity';
alter table ads add column if not exists paused_left interval;
alter table ads add column if not exists paused_at timestamptz;
alter table ads add column if not exists name text;
alter table ads add column if not exists existing_post boolean not null default false;
create index if not exists ads_post_idx on ads (post_id) where post_id is not null;
