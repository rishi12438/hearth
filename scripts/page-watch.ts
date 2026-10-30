// description: Checks whether a web page contains some text. Args: <url> <text>. Prints FOUND or NOT FOUND, for watches like "tell me when tickets go on sale".
const [url, needle] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url) || !needle) { console.log("usage: page-watch <https://url> <text>"); process.exit(1); }
const res = await fetch(url, { headers: { "User-Agent": "hearth-page-watch/0.1" }, redirect: "follow" });
const html = await res.text();
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const i = text.toLowerCase().indexOf(needle.toLowerCase());
console.log(i >= 0 ? `FOUND: …${text.slice(Math.max(0, i - 120), i + needle.length + 120).trim()}…` : `NOT FOUND (HTTP ${res.status})`);
