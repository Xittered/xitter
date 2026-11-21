// Local Community Notes rule. Use a 95% Wilson lower bound so a tiny or
// closely split sample cannot put context on a post. This is deliberately
// conservative; it does not claim to reproduce X's cross-perspective model.
export type NoteStatus = "Helpful" | "NotHelpful" | "NeedsMoreRatings";

function lowerBound(positive: number, total: number): number {
	if (!total) return 0;
	const z = 1.96;
	const p = positive / total;
	return (p + z * z / (2 * total) - z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)) / (1 + z * z / total);
}

export function noteStatus(ratings: number, helpful: number, notHelpful: number, staff = false): NoteStatus {
	if (staff) return "Helpful";
	if (!Number.isInteger(ratings) || ratings < 5) return "NeedsMoreRatings";
	if (lowerBound(helpful, ratings) > 0.5) return "Helpful";
	if (lowerBound(notHelpful, ratings) > 0.5) return "NotHelpful";
	return "NeedsMoreRatings";
}
