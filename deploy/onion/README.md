# .onion address for an instance

Two containers next to a running Xitter, no change to Xitter itself:

- `tor`: a v3 onion service. Its keys sit in `./hs`; that folder is the
  address, keep a copy of it.
- `gateway` (`gateway.ts`): tor hands it every connection, it passes them to
  Xitter as if they came to `PUBLIC_ORIGIN`, and swaps the two addresses in
  what goes through (pages, scripts, JSON, headers, socket text frames; in
  requests the other way). The patched client only knows the address Xitter
  printed into it, so every call stays on the onion: API, media, uploads,
  the chat socket, Juicebox.

It runs as a single onion service (`HiddenServiceNonAnonymousMode`): the
server's address is public anyway, so this skips the server-side hops and
pages load faster. Visitors stay as anonymous as on any onion.

## Run

On the box, next to the instance (gateway must share a Docker network with
the Xitter container):

```sh
mkdir -p /opt/xitter-onion/hs && cd /opt/xitter-onion
# copy Dockerfile.tor torrc tor-start.sh gateway.ts compose.yaml here
cat > .env <<EOF
NAME=xitter
UPSTREAM=http://xitter:3000
PUBLIC_ORIGIN=https://xitter.example
NETWORK=proxy
EOF
docker compose up -d --build
cat hs/hostname
```

To keep an address you already have, put its `hs_ed25519_secret_key`,
`hs_ed25519_public_key` and `hostname` into `hs/` before the first start.

Optional: send `Onion-Location: http://<onion>/` from the clearnet site, and
Tor Browser offers the onion there. Caddy: `header Onion-Location http://<onion>{uri}`.

## Notes

- Tor Browser treats `http://*.onion` as a secure context, so the session
  cookies (`Secure`, `__Host-`) and the chat crypto work over plain http.
- Every onion visitor reaches Xitter from the gateway's address, so they
  share one IP for rate limits and the admin panel's address lists. The
  gateway drops any `CF-Connecting-IP` a visitor sends.
- Passkeys don't work on the onion (WebAuthn needs a real domain).
- Things the client builds as `https://<host>` from parts (ads-api and the
  like) are blocked by Xitter's CSP on the clearnet site too.
