// Tiles: results that are better shown than told (weather, a list of places, a checklist, a number).
// The brain and scripts send DATA in one of a few fixed shapes; the app draws them with its own components.
// No generated code ever reaches the app, so tiles always look right and can't do anything but display.

export const TILE_TYPES = ["weather", "places", "checklist", "stat", "note"] as const;
export type Tile = { type: (typeof TILE_TYPES)[number]; title?: string; data: Record<string, any>; options?: TileOptions };
/** How a tile looks, saved on the skill so "show hourly" or "use °F" sticks. */
export type TileOptions = Record<string, string | number | boolean>;

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v.slice(0, 500) : undefined);

export function cleanOptions(o: unknown): TileOptions | undefined {
  if (!o || typeof o !== "object") return undefined;
  const out: TileOptions = {};
  for (const [k, v] of Object.entries(o).slice(0, 10)) {
    if (!/^[a-z][a-zA-Z0-9]{0,24}$/.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 40);
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanTile(t: any): Tile | null {
  if (!t || typeof t !== "object" || !TILE_TYPES.includes(t.type)) return null;
  const d = t.data && typeof t.data === "object" ? t.data : {};
  let data: Record<string, any>;
  switch (t.type as Tile["type"]) {
    case "weather":
      data = {
        place: str(d.place, 60), temp: num(d.temp), feels: num(d.feels), summary: str(d.summary, 60),
        high: num(d.high), low: num(d.low), rain: num(d.rain), wind: num(d.wind),
        hours: (Array.isArray(d.hours) ? d.hours : []).slice(0, 12).map((x: any) => ({ t: str(x?.t, 8), temp: num(x?.temp), rain: num(x?.rain) })),
      };
      if (data.temp === undefined) return null;
      break;
    case "places":
      data = { items: (Array.isArray(d.items) ? d.items : []).slice(0, 8).map((x: any) => ({ name: str(x?.name, 80), detail: str(x?.detail, 160), url: url(x?.url) })).filter((x: any) => x.name) };
      if (!data.items.length) return null;
      break;
    case "checklist":
      data = { items: (Array.isArray(d.items) ? d.items : []).slice(0, 15).map((x: any) => ({ text: str(x?.text, 160), done: !!x?.done })).filter((x: any) => x.text) };
      if (!data.items.length) return null;
      break;
    case "stat":
      data = { label: str(d.label, 60), value: str(d.value, 30), sub: str(d.sub, 100) };
      if (!data.value) return null;
      break;
    case "note":
      data = { body: str(d.body, 1200) };
      if (!data.body) return null;
      break;
  }
  return { type: t.type, title: str(t.title, 80), data, options: cleanOptions(t.options) };
}

/** Scripts print "@tile {json}" lines to show a tile; everything else is their text output. */
export function extractTiles(output: string): { text: string; tiles: Tile[] } {
  const tiles: Tile[] = [];
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("@tile ")) {
      try { const t = cleanTile(JSON.parse(line.slice(6))); if (t) tiles.push(t); } catch {}
    } else lines.push(line);
  }
  return { text: lines.join("\n").trim(), tiles: tiles.slice(0, 4) };
}
