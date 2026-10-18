import type { PostRow } from "./model";

const CHAIN_SIZE = 6;
const SELF_THREAD_SIZE = 50;
export const THREADS_PER_PAGE = 30;
export const MORE_PER_PAGE = 20;

export type Placed = { post: PostRow; parent?: string; indent?: boolean };
export type Thread = { root: PostRow; shown: Placed[]; rest: Placed[] };

const engagement = (p: PostRow) => p.like_count + p.reply_count;
const older = (a: PostRow, b: PostRow) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

export function conversationThreads(focal: PostRow, below: PostRow[], pinned: string | null) {
	const kids = new Map<string, PostRow[]>();
	for (const p of below) if (p.reply_to_id) kids.set(p.reply_to_id, [...(kids.get(p.reply_to_id) ?? []), p]);
	const childrenOf = (id: string) => kids.get(id) ?? [];
	const op = focal.author.id;

	const selfChain: PostRow[] = [];
	for (let at = focal; ; ) {
		const next = childrenOf(at.id)
			.filter((p) => p.author.id === op)
			.sort(older)[0];
		if (!next) break;
		selfChain.push(next);
		at = next;
	}
	const self = selfChain[0];

	const rank = (p: PostRow) => (p.id === pinned ? 0 : p === self ? 1 : p.author.id === op ? 2 : 3);
	const roots = [...childrenOf(focal.id)].sort((a, b) => rank(a) - rank(b) || engagement(b) - engagement(a) || older(b, a));

	const thread = (root: PostRow): Thread => {
		if (root === self) {
			const placed = selfChain.map((post, i) => ({ post, parent: i ? selfChain[i - 1].id : undefined }));
			return { root, shown: placed.slice(0, SELF_THREAD_SIZE), rest: placed.slice(SELF_THREAD_SIZE) };
		}
		const party = new Set([op, root.author.id]);
		const order = (list: PostRow[]) =>
			[...list].sort((a, b) => Number(party.has(b.author.id)) - Number(party.has(a.author.id)) || engagement(b) - engagement(a) || older(a, b));
		const place = (post: PostRow): Placed =>
			post === root ? { post } : { post, parent: post.reply_to_id ?? undefined, indent: childrenOf(post.reply_to_id ?? "").length > 1 };
		const shown = [place(root)];
		for (let at = root; shown.length < CHAIN_SIZE; ) {
			const [next, ...others] = order(childrenOf(at.id));
			if (!next) break;
			shown.push(place(next));
			at = next;
			if (others.length && !party.has(next.author.id)) break;
		}
		const seen = new Set(shown.map((s) => s.post.id));
		const rest: Placed[] = [];
		const walk = (p: PostRow) => {
			for (const k of order(childrenOf(p.id))) {
				if (!seen.has(k.id)) rest.push(place(k));
				walk(k);
			}
		};
		walk(root);
		return { root, shown, rest };
	};

	return { roots, thread };
}
