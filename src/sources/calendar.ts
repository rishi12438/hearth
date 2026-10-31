import type { Source } from "./index.ts";
import { describeLocal } from "../time.ts";

// Google Calendar: a new event or invite appears, or an event is about to start.

type Config = { when: "new" | "starting"; minutesBefore: number };

export const calendar: Source<Config> = {
  id: "calendar",
  label: "Google Calendar",
  needs: "google",
  doc: `Google Calendar. config {"when":"new"} (a new event or invite in the next 60 days) or
           {"when":"starting","minutesBefore":15} (an event starts within that many minutes). Minutes >= 5.`,
  validate(c) {
    const when = c?.when === "starting" ? "starting" : "new";
    const minutesBefore = Math.round(Number(c?.minutesBefore ?? 15));
    if (when === "starting" && !(minutesBefore >= 5 && minutesBefore <= 1440)) return "minutesBefore must be between 5 and 1440.";
    return { when, minutesBefore: when === "starting" ? minutesBefore : 15 };
  },
  minutes: (c) => (c.when === "starting" ? { min: 5, default: 5 } : { min: 5, default: 15 }),
  describe: (c) => (c.when === "starting" ? `${c.minutesBefore} min before each calendar event` : "a new calendar event or invite"),
  async items(c, { google, now, tz }) {
    const until = new Date(now.getTime() + (c.when === "starting" ? c.minutesBefore * 60_000 : 60 * 86_400_000));
    const events = await google.events(now, until, c.when === "starting" ? 20 : 250);
    // Newest first for "new" (by when it was created); soonest first for "starting".
    if (c.when === "new") events.sort((a, b) => b.created.localeCompare(a.created));
    return events.map((e) => {
      const when = e.allDay ? `${e.start} (all day)` : describeLocal(new Date(e.start), tz);
      return {
        // A moved event counts again for "starting", so its id includes the start time.
        id: c.when === "starting" ? `${e.id}@${e.start}` : e.id,
        title: e.title,
        at: when,
        url: e.link,
        text: [`When: ${when}`, e.location && `Where: ${e.location}`, e.organizer && `Organizer: ${e.organizer}`,
          e.myResponse && `Your response: ${e.myResponse}`, e.description].filter(Boolean).join("\n"),
      };
    });
  },
};
