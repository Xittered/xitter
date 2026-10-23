// One place maps a full disk or a dead database to what the person gets back.
// GraphQL is the exception: runOperation already answers HTTP 200.

import { StorageFailure, STORAGE_SENTENCE } from "./disk";
import { DatabaseOutage, DATABASE_SENTENCE } from "./db";
import { outagePage } from "./login";
import { noticeHeaders } from "./notices";

const API_PREFIX = /^\/(i\/api\/|i\/jfapi\/|i\/media\/|1\.1\/|2\/|v2\/|graphql\/|fleets\/|live_pipeline\/)/;

export function failFor(req: Request, e: unknown): Response | undefined {
	const sentence = e instanceof StorageFailure ? STORAGE_SENTENCE : e instanceof DatabaseOutage ? DATABASE_SENTENCE : undefined;
	if (!sentence) return undefined;
	const path = new URL(req.url).pathname;
	const api = API_PREFIX.test(path) || path.startsWith("/admin/api/") || path === "/account/import/upload";
	if (!api && req.method === "GET") return outagePage(sentence);
	const headers = noticeHeaders(sentence);
	const body = /\/media\/upload/.test(path) || path.startsWith("/admin/api/") || path === "/account/import/upload"
		? { error: sentence, errors: [{ code: 130, message: sentence }] }
		: { errors: [{ code: 130, message: sentence }] };
	return Response.json(body, { status: 503, headers });
}
