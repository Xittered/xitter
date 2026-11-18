#!/bin/sh
# the onion's keys live in /var/lib/tor/hs (a volume); tor refuses a
# hidden service directory anyone else can read
set -e
mkdir -p /var/lib/tor/hs
chown -R tor /var/lib/tor
chmod 700 /var/lib/tor /var/lib/tor/hs
exec su-exec tor tor -f /etc/tor/torrc
