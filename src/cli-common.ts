import type { Config } from "./config.ts";
import { adminFetch } from "./admin.ts";

// What every `hearth` command shares: flags, --json output, and calling the hub running on this machine as its owner.
// Exit codes: 0 done, 1 it didn't work (the reason is printed), 2 wrong usage, 3 no hub running here.

export const has = (args: string[], f: string) => args.includes(f);
export const flag = (args: string[], f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
/** Words that aren't flags or a flag's value. */
export const positional = (args: string[], valued: string[] = ["--key", "--token", "--all-groups", "--archived", "--muted", "--to", "--env", "--update"]) =>
  args.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.includes(args[i - 1])));
export const onOff = (v?: string) => (v === undefined ? undefined : /^(on|yes|true|1)$/i.test(v));
export async function stdin(): Promise<string> { return (await new Response(Bun.stdin.stream()).text()).trim(); }

export function io(config: Config, args: string[]) {
  const json = has(args, "--json");
  return {
    json,
    out: (data: unknown, text: string) => { console.log(json ? JSON.stringify(data, null, 2) : text); },
    fail: (msg: string, code = 1) => { if (json) console.log(JSON.stringify({ error: msg })); else console.error(`  ${msg}`); return code; },
    hub: async (path: string, init?: { method?: string; body?: unknown }) => {
      const r = await adminFetch(config, path, init);
      if (!r) return { error: "No hub is running on this machine. Start it with `hearth start` (or `bun run start`).", code: 3 } as const;
      if (r.status >= 400) return { error: String(r.data?.error || `The hub answered ${r.status}`), code: 1 } as const;
      return { data: r.data } as const;
    },
  };
}
