FROM oven/bun:1.4.2
# ffmpeg converts uploaded video; pg_dump (from PGDG, matching the server's
# Postgres 18) makes the scheduled backups
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates ffmpeg postgresql-common \
	&& /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
	&& apt-get install -y --no-install-recommends postgresql-client-18 \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src src
COPY public public
COPY scripts scripts
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint
# volumes mount here; created now so they belong to the bun user
RUN mkdir -p client media data && chown bun:bun client media data
USER bun
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["bun", "src/server.ts"]
