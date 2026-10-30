// Wall-clock helpers in the user's time zone, with no date library.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export type Wall = { y: number; m: number; d: number; h: number; mi: number; wd: number };

export function wallParts(date: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: WEEKDAYS.indexOf(p.weekday) };
}

/** Wall time in tz -> UTC Date. Two passes settle DST edges. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = wallParts(new Date(guess), tz);
    guess += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  }
  return new Date(guess);
}

function addDays(w: Wall, n: number): Wall {
  const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
  return { ...w, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

export const REPEATS = ["none", "daily", "weekdays", "weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];

/** Next time a repeating reminder fires strictly after `after`, keeping its wall time. */
export function nextOccurrence(atIso: string, repeat: Repeat, tz: string, after = new Date()): Date | null {
  if (repeat === "none") return null;
  let w = wallParts(new Date(atIso), tz);
  const day = w.d;
  for (let i = 0; i < 800; i++) {
    if (repeat === "monthly") {
      const t = new Date(Date.UTC(w.y, w.m, 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      w = { ...w, y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: Math.min(day, last) };
    } else {
      w = addDays(w, repeat === "weekly" ? 7 : 1);
      if (repeat === "weekdays" && (w.wd === 0 || w.wd === 6)) continue;
    }
    const at = zonedToUtc(w.y, w.m, w.d, w.h, w.mi, tz);
    if (at > after) return at;
  }
  return null;
}

/** Schedules run at "HH:MM" on the listed weekdays (0 = Sunday). */
export function nextScheduledRun(time: string, days: number[], tz: string, after = new Date()): Date | null {
  const [h, mi] = time.split(":").map(Number);
  const allowed = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  const w = wallParts(after, tz);
  for (let i = 0; i < 9; i++) {
    const day = addDays(w, i);
    if (!allowed.includes(day.wd)) continue;
    const at = zonedToUtc(day.y, day.m, day.d, h, mi, tz);
    if (at > after) return at;
  }
  return null;
}

const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export function inQuietHours(date: Date, tz: string, start: string, end: string) {
  const w = wallParts(date, tz);
  const now = w.h * 60 + w.mi, s = toMin(start), e = toMin(end);
  return s <= e ? now >= s && now < e : now >= s || now < e;
}

/** The first moment after `date` that is outside quiet hours. */
export function quietEndsAt(date: Date, tz: string, end: string) {
  const [h, mi] = end.split(":").map(Number);
  const w = wallParts(date, tz);
  let at = zonedToUtc(w.y, w.m, w.d, h, mi, tz);
  if (at <= date) { const n = addDays(w, 1); at = zonedToUtc(n.y, n.m, n.d, h, mi, tz); }
  return at;
}

export function localDate(date: Date, tz: string) {
  const w = wallParts(date, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export function describeLocal(date: Date, tz: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(date);
}

export function isValidTimeZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
