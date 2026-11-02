import type { Hub } from "../hub.ts";
import type { Vault } from "../vault.ts";
import type { VoiceSettings } from "../voice.ts";
import type { WhatsApp } from "./whatsapp.ts";
import type { Slack } from "./slack.ts";

// The shape every connector module fills in. One file per connector (serper.ts, whatsapp.ts…); the list of them is in
// index.ts. The grid in the app, the API and the `hearth` CLI all go through the same modules.

export type ConnectorKind = "brain" | "key" | "account";
/** How you add it: sign a brain in, paste a key or token, scan a QR code, bring cookies, or sign in with OAuth. */
export type AddHow = "login" | "key" | "token" | "qr" | "cookies" | "oauth";

export type ConnectorDef = {
  id: string;
  label: string;
  kind: ConnectorKind;
  how: AddHow;
  /** One line under the name on its tile. */
  blurb: string;
  /** Unofficial: breaks the site's terms. The owner accepts the ban risk once before it connects. */
  risk?: string;
  /** Where to get the key or token. */
  getFrom?: string;
};

export type TileState = "connected" | "off" | "needs-you" | "not-installed";
/** What a tile shows. */
export type Tile = ConnectorDef & { state: TileState; detail: string | null; riskAccepted?: boolean; usage?: unknown };
export type TileStatus = { state: TileState; detail: string | null; usage?: unknown };

/** What connector modules can reach. Built once by Connect. */
export type Ctx = {
  hub: Hub;
  vault: Vault | null;
  voice: VoiceSettings | null;
  whatsapp: WhatsApp;
  slack: Slack;
};

/** What `add` gets: the fields its tile asks for. */
export type AddInput = { key?: string; token?: string; cookies?: string; auth?: unknown; acceptRisk?: boolean };

export interface Connector {
  def: ConnectorDef;
  /** Its tile's state right now. */
  status(ctx: Ctx): Promise<TileStatus> | TileStatus;
  /** Add or replace it. Returns an error message, or null when it worked. */
  add(ctx: Ctx, input: AddInput): Promise<string | null>;
  /** Take it off. Returns an error message, or null. */
  remove(ctx: Ctx): Promise<string | null>;
  /** Called once when the hub starts (e.g. WhatsApp reconnects its link). */
  start?(ctx: Ctx): Promise<void>;
}

export const RISK = (site: string) =>
  `This uses your own ${site} login in a way ${site} doesn't officially allow. It breaks ${site}'s terms, and your account could be limited or banned. It's your choice.`;

export const hint = (k: string | null | undefined) => (k ? `••••${k.slice(-4)}` : null);
