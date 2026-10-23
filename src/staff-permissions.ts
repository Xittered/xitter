// What moderators and support may do in the admin panel, chosen by an admin
// (Admin > Staff permissions). Each permission is a group of panel actions
// with the role that has it by default (a Privacy one also hides some fields
// from what every staff member reads, see `allows`); an admin turns it on or off for each
// role below admin. Admins always have every permission. Actions outside the
// list (roles, settings, security, backups, the client build, these
// permissions themselves) stay with the role written on them in admin.ts.

import { settings } from "./settings";

export type Role = "admin" | "moderator" | "support";
export const RANK: Record<Role, number> = { support: 1, moderator: 2, admin: 3 };
// the roles an admin can give or take permissions from
export const GRANTABLE = ["moderator", "support"] as const;
export type GrantableRole = (typeof GRANTABLE)[number];

type Permission = { group: string; label: string; role: Role; actions: string[] };

export const PERMISSIONS: Record<string, Permission> = {
	standing: { group: "Moderation", label: "Restrict, limit, suspend and reinstate accounts, for a while or until lifted, one at a time or many", role: "moderator", actions: ["setStatus", "setTemporaryStatus", "bulkStatus"] },
	reports: { group: "Moderation", label: "Close reports", role: "moderator", actions: ["resolveReport"] },
	appeals: { group: "Moderation", label: "See and answer appeals", role: "moderator", actions: ["appeals", "resolveAppeal"] },
	note_appeals: { group: "Moderation", label: "Review Community Note appeals", role: "moderator", actions: [] },
	messages: { group: "Moderation", label: "Send messages, warnings and strikes, and withdraw strikes", role: "moderator", actions: ["sendStaffMessage", "revokeStrike"] },
	delete_posts: { group: "Moderation", label: "Delete posts", role: "moderator", actions: ["deletePost"] },
	post_visibility: { group: "Moderation", label: "Hide posts and articles, mark them sensitive, label them", role: "moderator", actions: ["setPostVisibility", "setPostNotice", "setArticleVisibility"] },
	media: { group: "Moderation", label: "Delete uploaded media", role: "moderator", actions: ["deleteMedia"] },
	decor: { group: "Moderation", label: "Reset profile decor", role: "moderator", actions: ["resetDecor"] },
	automod_scan: { group: "Moderation", label: "Scan old posts and profiles with automod", role: "moderator", actions: ["automodScan"] },
	archive_imports: { group: "Moderation", label: "Approve and decline imports from X archives", role: "moderator", actions: ["archiveImports", "decideArchiveImport"] },
	release_identities: { group: "Moderation", label: "Release held handles, emails and addresses", role: "admin", actions: ["releaseIdentity"] },

	staff_notes: { group: "Accounts", label: "Write staff notes", role: "support", actions: ["addStaffNote"] },
	// whoever resets a password sees the new one and can sign in as the account
	passwords: { group: "Accounts", label: "Reset passwords (they see the new password, so they can sign in as the account)", role: "admin", actions: ["resetPassword"] },
	sessions: { group: "Accounts", label: "Sign accounts out and revoke their API tokens", role: "support", actions: ["signOut", "revokeSession", "revokeApiTokens"] },
	profiles: { group: "Accounts", label: "Edit profiles and the counts shown on profiles and posts", role: "admin", actions: ["updateUser", "setUserCounts", "setPostCounts"] },
	account_badges: { group: "Accounts", label: "Give badges, labels and flags", role: "admin", actions: ["setBadge", "setTranslator", "setFlag", "setBadges", "setProfileLabel", "setOrgBadge"] },
	notes_access: { group: "Accounts", label: "Give Community Notes writing access", role: "admin", actions: ["setNotesAccess"] },
	delete_accounts: { group: "Accounts", label: "Delete accounts", role: "admin", actions: ["deleteUser"] },
	orgs: { group: "Accounts", label: "Create organisations and manage their affiliates", role: "admin", actions: ["createOrg", "addAffiliate", "removeAffiliate"] },
	// without it the invite list shows no codes: an open one is a way in while sign-up is by invite
	invites: { group: "Accounts", label: "See, make and revoke invite codes", role: "admin", actions: ["createInvite", "revokeInvite"] },

	badges: { group: "Content", label: "Make and delete custom badges and profile labels", role: "admin", actions: ["createBadge", "deleteBadge", "createLabel", "deleteLabel"] },
	stickers: { group: "Content", label: "Manage sticker packs", role: "admin", actions: ["createStickerPack", "renameStickerPack", "moveStickerPack", "deleteStickerPack", "addSticker", "deleteSticker"] },
	hashflags: { group: "Content", label: "Manage branded hashtags", role: "admin", actions: ["createHashflag", "endHashflag", "deleteHashflag"] },
	explore: { group: "Content", label: "Manage Explore cards and topics", role: "admin", actions: ["saveCard", "deleteCard", "saveTopic", "deleteTopic"] },

	// stack traces show the server's paths and internals
	errors: { group: "Instance", label: "See and resolve server errors", role: "admin", actions: ["errors", "resolveErrors"] },
	mail: { group: "Instance", label: "Send test mail and digests", role: "admin", actions: ["sendTestMail", "runMailDigests"] },
	oauth_apps: { group: "Instance", label: "Block and unblock OAuth apps", role: "moderator", actions: ["blockOAuthApp", "unblockOAuthApp"] },

	ip_addresses: { group: "Privacy", label: "See IP addresses: where accounts sign in, other accounts seen at the same address, identities held after deletion", role: "moderator", actions: ["heldIdentities"] },
	emails: { group: "Privacy", label: "See email addresses in the mail log", role: "admin", actions: [] },
};

const PERMISSION_OF = new Map(Object.entries(PERMISSIONS).flatMap(([key, p]) => p.actions.map((a) => [a, key] as const)));
export const permissionOf = (action: string) => PERMISSION_OF.get(action);

export function actionNeed(action: string, needs: Role): string {
	const key = permissionOf(action);
	return key ? PERMISSIONS[key].label : `the ${needs} role`;
}

// the permissions each role has now: the defaults with the admin's choices over them
export function rolePermissions(role: GrantableRole): Record<string, boolean> {
	const chosen = settings().staff_permissions[role] ?? {};
	return Object.fromEntries(Object.entries(PERMISSIONS).map(([key, p]) => [key, typeof chosen[key] === "boolean" ? chosen[key] : RANK[role] >= RANK[p.role]]));
}

// whether a staff role has a permission, for the fields an action leaves out without it
export function allows(role: string | null | undefined, key: string): boolean {
	if (role === "admin") return true;
	return GRANTABLE.includes(role as GrantableRole) && rolePermissions(role as GrantableRole)[key];
}

// whether a staff role may run an action that otherwise needs `needs`
export function mayRun(role: string | null | undefined, action: string, needs: Role): boolean {
	if (!role || !(role in RANK)) return false;
	if (role === "admin") return true;
	const key = permissionOf(action);
	if (!key) return RANK[role as Role] >= RANK[needs];
	return rolePermissions(role as GrantableRole)[key];
}
