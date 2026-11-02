// description: Google results through Serper (your own key). Args: <query>. Prints the top results with links.
// needs: serper
const q = process.argv.slice(2).join(" ").trim();
if (!q) { console.log("Give me something to search for."); process.exit(0); }
const key = process.env.SERPER_API_KEY;
if (!key) { console.log("Serper isn't connected. Add your key in Settings → Connectors → Serper."); process.exit(1); }
const res = await fetch(`https://google.serper.dev/search?q=${encodeURIComponent(q)}&num=8`, { headers: { "X-API-KEY": key } });
if (!res.ok) { console.log(`Serper answered ${res.status}`); process.exit(1); }
const d: any = await res.json();
const lines: string[] = [];
if (d.answerBox?.answer || d.answerBox?.snippet) lines.push(`Answer: ${d.answerBox.answer || d.answerBox.snippet}`);
if (d.knowledgeGraph?.title) lines.push(`${d.knowledgeGraph.title}${d.knowledgeGraph.description ? ` — ${d.knowledgeGraph.description}` : ""}`);
for (const r of (d.organic || []).slice(0, 8)) lines.push(`- ${r.title}\n  ${r.link}\n  ${r.snippet || ""}`.trimEnd());
console.log(lines.join("\n") || "No results.");
