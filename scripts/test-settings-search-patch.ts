import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

const SETTINGS_INDEXES = [
    `let e=(0,d.Dp)(),t=[];for(let n of e)for(let e of(t.push(n.getRoute?.(n.path)),n.synonyms.push((0,s.kF)(n.title)),n.items))t.push(e.getRoute?.(e.path));`,
    `let routes=(0,module.aB)(),items=[];for(let route of routes)for(let setting of(items.push(route.getRoute?.(route.path)),route.synonyms.push((0,text.kF)(route.title)),route.items))items.push(setting.getRoute?.(setting.path));`,
];

test("GIF provider is searchable in Settings", () => {
    for (const source of SETTINGS_INDEXES) {
        const patched = patchText(source);
        expect(patched).toContain('find(group=>group.path==="/settings/account")?.items.push({id:"xitterGifProvider",path:"/settings/xitter/gifs",title:"GIF provider"');
        expect(patched).toContain('synonyms:["gif","provider","klipy","tenor","giphy"]');
        expect(() => new Function(patched)).not.toThrow();
    }
});

test("GIF provider is nested under Your Account", () => {
    const patched = patchText(SETTINGS_INDEXES[0]!);
    const groups = [
        { id: "account", path: "/settings/account", title: "Your Account", synonyms: [], items: [{ id: "accountInformation", path: "/settings/your_twitter_data", title: "Account information" }] },
        { id: "privacy", path: "/settings/privacy_and_safety", title: "Privacy and safety", synonyms: [], items: [] },
    ];
    const result = new Function("d", "s", `${patched};return e;`)({ Dp: () => groups }, { kF: (title: string) => title.toLowerCase() });
    expect(result).toHaveLength(2);
    expect(result[0].items.map((item: { id: string }) => item.id)).toEqual(["accountInformation", "xitterGifProvider", "xitterPostDetails", "xitterProfileLabels", "xitterEquicoins"]);
    const paths = result[0].items.map((item: { path: string }) => item.path);
    expect(paths).toContain("/settings/xitter/post-details");
    expect(paths).toContain("/settings/xitter/merchant");
    expect(result[1].items).toEqual([]);
});

test("unrelated source does not gain a Settings search result", () => {
    const source = "let e=(0,d.NotSettings)(),t=[];";
    expect(patchText(source)).toBe(source);
});