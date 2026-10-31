import { createHash } from "node:crypto";
import { cleanDomain } from "../cookie-sites.ts";
import { stableText, SignedOut } from "./pages.ts";
import { extractScript } from "./pages.ts";
import type { Source, Item } from "./index.ts";

// Any site you're logged into in Chrome, read through your own session. Point it at a URL: with a selector it reads
// the matching items (a list), without one it watches the page's text and fires when it changes. This is how a
// teammate reads "my Amazon orders", "my bank balance", "my school portal" — anything behind your login.

type Config = { url: string; label: string; selector?: string };

const SIGNED_OUT = /\/(login|signin|sign-in|sign_in|auth|sso|account\/login)(\/|\?|$)/i;

export const site: Source<Config> = {
  id: "site",
  label: "A logged-in site",
  needs: (c) => cleanDomain(c.url) || "",
  doc: `any site the user is logged into in Chrome. config {"url":"https://www.amazon.com/gp/css/order-history","label":"Amazon orders"}
           watches the page and tells you when it changes; add "selector":"<css>" to read matching items as a list instead.
           Use this for anything the fixed modules don't cover. Connect the site first (Menu → Connectors → Add a site).`,
  validate(c) {
    let url: URL;
    try { url = new URL(String(c?.url || "")); } catch { return "A site needs a full URL (https://…)."; }
    if (!/^https?:$/.test(url.protocol) || !cleanDomain(url.hostname)) return "A site needs an http(s) URL.";
    const label = (typeof c?.label === "string" && c.label.trim() ? c.label.trim() : cleanDomain(url.hostname)!).slice(0, 60);
    const selector = typeof c?.selector === "string" && c.selector.trim() ? c.selector.trim().slice(0, 200) : undefined;
    return { url: url.toString(), label, selector };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => (c.selector ? `new items on ${c.label}` : `${c.label} changing`),
  async items(c, ctx) {
    const domain = cleanDomain(new URL(c.url).hostname)!;
    const cookies = ctx.cookies(domain);
    if (!cookies.length) throw new SignedOut(`${c.label} isn't connected. Add it in Menu → Connectors.`);
    const r = await ctx.readPage(c.url, { cookies, waitMs: 9000, ...(c.selector ? { waitFor: c.selector, extract: extractScript([c.selector]) } : {}) });
    if (SIGNED_OUT.test(r.url)) throw new SignedOut(`${c.label} signed Hearth out. Reconnect it in Menu → Connectors.`);
    if (r.url.startsWith("chrome-error:")) throw new Error(`${c.label} didn't load (${r.text.match(/ERR_[A-Z_]+/)?.[0] || "network error"}).`);
    if (c.selector) {
      const raw = (r.data as { text: string; href: string }[] | null) || [];
      return raw.map((x): Item => {
        const lines = stableText(x.text).split("\n");
        return { id: createHash("sha256").update(stableText(x.text)).digest("hex").slice(0, 24), title: (lines[0] || c.label).slice(0, 120), text: lines.slice(1).join("\n"), url: x.href || c.url };
      });
    }
    // No selector: the whole page is one item whose id changes when its words change -> a logged-in "watch".
    const text = stableText(r.text).slice(0, 8000);
    return [{ id: createHash("sha256").update(text).digest("hex").slice(0, 24), title: `${c.label} changed`, text, url: c.url }];
  },
};
