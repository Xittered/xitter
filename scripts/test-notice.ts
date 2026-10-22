import { expect, test } from "bun:test";
import { newId } from "../src/ids";
import { mediaUpload } from "../src/media";
import { failOperation, runOperation } from "../src/graphql";
import { StorageFailure } from "../src/disk";
import { NOTICE_HEADER, RESOURCE_NOTICE_SCRIPT, STORAGE_SENTENCE } from "../src/notices";
import { bootFor, bootScript } from "../src/shell";

const viewer = { id: newId() } as any;

test("an oversized upload carries the notice and an unknown one does not", async () => {
	const huge = new Request("http://localhost/i/media/upload.json?command=INIT&total_bytes=999999999999&media_type=image/jpeg", { method: "POST" });
	const res = await mediaUpload(huge, new URL(huge.url), viewer);
	expect(res.status).toBe(400);
	expect(res.headers.get(NOTICE_HEADER)).toBe("File is too large or empty.");
	const missing = new Request("http://localhost/i/media/upload.json?command=APPEND&media_id=1&segment_index=0", { method: "POST" });
	const unknown = await mediaUpload(missing, new URL(missing.url), viewer);
	expect(unknown.status).toBe(404);
	expect(unknown.headers.get(NOTICE_HEADER)).toBeNull();
	expect(RESOURCE_NOTICE_SCRIPT).not.toContain("innerHTML");
	expect(RESOURCE_NOTICE_SCRIPT).toContain("textContent");
	expect(RESOURCE_NOTICE_SCRIPT).toContain(STORAGE_SENTENCE);
});

test("posting failures that already say the sentence do not add the notice header", async () => {
	const res = await failOperation(new StorageFailure(), () => runOperation("CreateTweet", { id: "1" } as any, { tweet_text: "hi" }));
	expect(res.status).toBe(200);
	expect(res.headers.get(NOTICE_HEADER)).toBeNull();
	expect((await res.json()).errors[0].message).toBe(`Error: ${STORAGE_SENTENCE}`);
});

test("the boot script toasts an allowlisted notice and ignores the rest", async () => {
	// the signed-in and signed-out boot scripts both carry the hook; shell() links
	// bootFor(!!user).path, and needs the fetched client build, so it isn't called here
	for (const signedIn of [true, false]) {
		const { path } = bootFor(signedIn);
		expect(path).toMatch(/^\/i\/xitter\/boot-[a-z0-9]+\.js$/);
		expect(bootScript(path)!.toString()).toContain(RESOURCE_NOTICE_SCRIPT);
	}
	const nodes: any[] = [];
	const canned = { textContent: "Some of your media failed to upload. Try a smaller file.", style: {} as Record<string, string> };
	const document = {
		documentElement: {},
		body: { appendChild(node: any) { nodes.push(node); node.isConnected = true; } },
		createElement() {
			const el: any = { style: {}, attrs: {} as Record<string, string>, text: "", isConnected: false };
			el.setAttribute = (key: string, value: string) => { el.attrs[key] = value; };
			el.remove = () => { el.isConnected = false; };
			Object.defineProperty(el, "textContent", { set(value: string) { el.text = value; }, get() { return el.text; } });
			return el;
		},
		querySelectorAll() { return [canned]; },
	};
	class XHR {
		listeners: Record<string, Array<(this: XHR) => void>> = {};
		header: string | null = null;
		addEventListener(name: string, fn: (this: XHR) => void) { (this.listeners[name] ??= []).push(fn); }
		getResponseHeader() { return this.header; }
		send() { for (const fn of this.listeners.load ?? []) fn.call(this); }
	}
	let next = new Response(null);
	const g = globalThis as any;
	const saved = { fetch: g.fetch, window: g.window, document: g.document, MutationObserver: g.MutationObserver, XMLHttpRequest: g.XMLHttpRequest };
	g.document = document;
	g.window = g;
	g.MutationObserver = class { observe() {} };
	g.XMLHttpRequest = XHR;
	g.fetch = () => Promise.resolve(next);
	try {
		new Function(RESOURCE_NOTICE_SCRIPT)();
		next = new Response("{}", { headers: { [NOTICE_HEADER]: STORAGE_SENTENCE } });
		await g.fetch("http://localhost/i/media/upload.json");
		expect(nodes).toHaveLength(1);
		expect(nodes[0].text).toBe(STORAGE_SENTENCE);
		expect(nodes[0].attrs["data-testid"]).toBe("xitter-notice");
		expect(nodes[0].attrs.role).toBe("alert");
		expect(canned.style.display).toBe("none");
		next = new Response("{}", { headers: { [NOTICE_HEADER]: "ENOSPC on /tmp/media" } });
		await g.fetch("http://localhost/i/api/2/media/upload.json");
		expect(nodes).toHaveLength(1);
		expect(nodes[0].text).toBe(STORAGE_SENTENCE);
		next = new Response("{}", { headers: { [NOTICE_HEADER]: "Videos can be up to 10 minutes long." } });
		await g.fetch("http://localhost/i/media/upload.json");
		expect(nodes[0].text).toBe("Videos can be up to 10 minutes long.");
		const xhr = new XHR();
		xhr.header = "File is too large.";
		xhr.send();
		expect(nodes).toHaveLength(1);
		expect(nodes[0].text).toBe("File is too large.");
		xhr.header = "<script>alert(1)</script>";
		xhr.send();
		expect(nodes[0].text).toBe("File is too large.");
	} finally {
		g.fetch = saved.fetch;
		g.window = saved.window;
		g.document = saved.document;
		g.MutationObserver = saved.MutationObserver;
		g.XMLHttpRequest = saved.XMLHttpRequest;
	}
});
