import webpush from "web-push";
import { randomUUID } from "node:crypto";
import type { Store } from "./store/index.ts";
import type { Doc } from "./store/types.ts";

// Web Push straight from your hub to your phone's browser push service. No relay of ours.
// VAPID keys are generated on first run and stored with your data; nothing is hard-coded.

type PushSub = Doc & { deviceId: string; endpoint: string; keys: { p256dh: string; auth: string } };
type Vapid = Doc & { publicKey: string; privateKey: string };

export class Push {
  publicKey = "";
  constructor(private store: Store, private contact: string) {}

  async init() {
    let v = await this.store.get<Vapid>("settings", "vapid");
    if (!v) {
      const keys = webpush.generateVAPIDKeys();
      v = await this.store.put<Vapid>("settings", { id: "vapid", createdAt: new Date().toISOString(), ...keys });
    }
    this.publicKey = v.publicKey;
    webpush.setVapidDetails(this.contact, v.publicKey, v.privateKey);
  }

  async subscribe(deviceId: string, sub: any) {
    const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
    if (!/^https:\/\//.test(endpoint) || typeof sub?.keys?.p256dh !== "string" || typeof sub?.keys?.auth !== "string") {
      return { error: "Invalid push subscription." };
    }
    for (const s of await this.store.all<PushSub>("pushSubs")) if (s.endpoint === endpoint || s.deviceId === deviceId) await this.store.remove("pushSubs", s.id);
    await this.store.put<PushSub>("pushSubs", {
      id: randomUUID(), createdAt: new Date().toISOString(), deviceId, endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return { value: true };
  }

  async unsubscribeDevice(deviceId: string) {
    for (const s of await this.store.all<PushSub>("pushSubs")) if (s.deviceId === deviceId) await this.store.remove("pushSubs", s.id);
  }

  async hasDevice(deviceId: string) {
    return (await this.store.all<PushSub>("pushSubs")).some((s) => s.deviceId === deviceId);
  }

  async send(payload: { title: string; body: string; tag?: string; url?: string }) {
    const subs = await this.store.all<PushSub>("pushSubs");
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await this.store.remove("pushSubs", s.id);
        else console.warn(`push failed (${err?.statusCode ?? "?"})`);
      }
    }));
    return subs.length;
  }
}
