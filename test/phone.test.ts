import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { Phone, pinnedFor, PHONE_IAM_POLICY, ENSURE_ANDROID, REDROID_IMAGE, redroidUserData, sign, amzDate, ec2List, xmlTag, xmlItems, ec2Error, type AwsCreds, type Ec2 } from "../src/phone.ts";

const vault = () => new Vault(mkdtempSync(join(tmpdir(), "hearth-phone-")), { masterKey: randomBytes(32) });

test("SigV4 matches AWS's published get-vanilla test vector", () => {
  // From AWS's Signature Version 4 test suite (the canonical AKIDEXAMPLE example).
  const creds: AwsCreds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const auth = sign({
    method: "GET", path: "/", query: "", headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: emptyHash, service: "service", creds, amzDate: "20150830T123600Z",
  });
  expect(auth).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
    "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("amzDate turns an ISO time into AWS's basic format", () => {
  expect(amzDate(new Date("2015-08-30T12:36:00.000Z"))).toBe("20150830T123600Z");
});

test("ec2List flattens into EC2's numbered params", () => {
  expect(ec2List("Filter", [{ Name: "name", Value: ["ubuntu-*"] }, { Name: "architecture", Value: ["arm64"] }])).toEqual({
    "Filter.1.Name": "name", "Filter.1.Value.1": "ubuntu-*",
    "Filter.2.Name": "architecture", "Filter.2.Value.1": "arm64",
  });
});

test("xml helpers read tags and repeated items", () => {
  const xml = "<DescribeImagesResponse><imagesSet><item><imageId>ami-1</imageId><creationDate>2024-01-01</creationDate></item><item><imageId>ami-2</imageId><creationDate>2024-06-01</creationDate></item></imagesSet></DescribeImagesResponse>";
  expect(xmlTag(xml, "imageId")).toBe("ami-1");
  expect(xmlItems(xml).length).toBe(2);
  expect(xmlItems(xml).map((b) => xmlTag(b, "imageId"))).toEqual(["ami-1", "ami-2"]);
});

test("ec2Error turns an auth failure into a plain reason, never echoing keys", () => {
  const msg = ec2Error("<Response><Errors><Error><Code>AuthFailure</Code><Message>bad</Message></Error></Errors></Response>", 403);
  expect(msg).toContain("service account");
  expect(msg).not.toContain("AuthFailure");
});

test("setAccount rejects bad input and stores a good account encrypted", async () => {
  const v = vault();
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-d-")), vault: v, isBusy: () => false });
  expect(await phone.setAccount({ accessKeyId: "nope", secretAccessKey: "x", region: "us-west-2" })).toContain("access key");
  expect(await phone.setAccount({ accessKeyId: "AKIA" + "A".repeat(16), secretAccessKey: "short", region: "us-west-2" })).toContain("secret");
  expect(await phone.setAccount({ accessKeyId: "AKIA" + "A".repeat(16), secretAccessKey: "b".repeat(40), region: "nonsense" })).toContain("region");
  // Good input, skipping the live AWS check.
  const good = await phone.setAccount({ accessKeyId: "AKIA" + "A".repeat(16), secretAccessKey: "b".repeat(40), region: "us-west-2" }, false);
  expect(good).toBeNull();
  expect(phone.configured()).toBe(true);
  expect(v.get("phone-aws")).toContain("us-west-2");
  expect(phone.view().configured).toBe(true);
});

/** A pretend EC2 that records actions and answers with canned XML. */
function fakeEc2(answers: Record<string, string> = {}) {
  const calls: { action: string; params: Record<string, string> }[] = [];
  const ec2: Ec2 = async (_creds, action, params) => { calls.push({ action, params }); return answers[action] ?? "<ok/>"; };
  return { ec2, calls };
}

function configured(phone: Phone, v: Vault) {
  v.set("phone-aws", JSON.stringify({ accessKeyId: "AKIA" + "A".repeat(16), secretAccessKey: "b".repeat(40), region: "us-west-2" }));
}

test("idle tick stops a ready phone that's past its limit and has no busy job", async () => {
  const v = vault();
  let t = 1_000_000;
  const { ec2, calls } = fakeEc2();
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-i-")), vault: v, isBusy: () => false, ec2, now: () => t, idleStopMin: 15 });
  configured(phone, v);
  // Pretend it's up.
  (phone as any).save({ state: "ready", instanceId: "i-123", publicIp: "1.2.3.4", lastUseAt: t });
  await phone.tick();
  expect(phone.view().state).toBe("ready"); // still fresh
  t += 16 * 60_000;
  await phone.tick();
  expect(calls.some((c) => c.action === "StopInstances" && c.params["InstanceId.1"] === "i-123")).toBe(true);
  expect(phone.view().state).toBe("off");
});

test("a busy owner job keeps the phone alive", async () => {
  const v = vault();
  let t = 1_000_000;
  const { ec2, calls } = fakeEc2();
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-b-")), vault: v, isBusy: (id) => id === "job-1", ec2, now: () => t, idleStopMin: 15 });
  configured(phone, v);
  (phone as any).save({ state: "ready", instanceId: "i-123", publicIp: "1.2.3.4", lastUseAt: t, ownerJob: "job-1" });
  t += 60 * 60_000;
  await phone.tick();
  expect(calls.some((c) => c.action === "StopInstances")).toBe(false);
  expect(phone.view().state).toBe("ready");
});

test("after 30 idle days the phone is deleted (terminate + drop the key)", async () => {
  const v = vault();
  let t = Date.parse("2026-01-01T00:00:00Z");
  const { ec2, calls } = fakeEc2();
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-del-")), vault: v, isBusy: () => false, ec2, now: () => t });
  configured(phone, v);
  v.set("phone-sshkey", "KEY");
  (phone as any).save({ state: "off", instanceId: "i-123", keyName: "hearth-phone-abcd1234", sgId: "sg-1", stoppedAt: t });
  await phone.tick(); // same day: nothing
  expect(calls.some((c) => c.action === "TerminateInstances")).toBe(false);
  t += 31 * 86_400_000;
  await phone.tick(); // a new day, 31 days idle
  expect(calls.some((c) => c.action === "TerminateInstances" && c.params["InstanceId.1"] === "i-123")).toBe(true);
  expect(calls.some((c) => c.action === "DeleteKeyPair")).toBe(true);
  expect(v.get("phone-sshkey")).toBeNull();
  expect(phone.view().instanceId).toBeUndefined();
  expect(phone.view().sgId).toBe("sg-1"); // the free, reusable group is kept
});

test("open refuses when no account is configured", async () => {
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-no-")), vault: vault(), isBusy: () => false });
  expect(await phone.open()).toEqual({ error: expect.stringContaining("Settings") });
});

test("the IAM policy shown in Settings allows every EC2 call the phone makes, and nothing else", async () => {
  const src = await Bun.file(new URL("../src/phone.ts", import.meta.url)).text();
  const called = new Set([...src.matchAll(/ec2\(\)\(creds, "(\w+)"/g)].map((m) => `ec2:${m[1]}`));
  if (src.includes('"TagSpecification"')) called.add("ec2:CreateTags");
  expect(called.size).toBeGreaterThan(5);
  expect([...PHONE_IAM_POLICY.Statement[0].Action].sort()).toEqual([...called].sort());
});

test("live view: while a working job uses the phone, its screen goes to the job's thread; it stops when the job ends", async () => {
  const v = vault();
  configured(null as any, v);
  v.set("phone-sshkey", "KEY");
  const jpeg = Buffer.alloc(2000, 7).toString("base64");
  const cmds: string[] = [];
  const ssh = { runner: () => ({ run: async (cmd: string, o: { onLine?: (l: string) => void }) => {
    cmds.push(cmd);
    if (cmd.includes("screencap")) o.onLine?.(jpeg);
    return { code: 0, stderr: "" };
  } }) } as any;
  let working = true;
  const frames: { jobId: string; mime: string; n: number }[] = [];
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-lv-")), vault: v, ssh, isBusy: () => working, frameEveryMs: 20,
    onFrame: (jobId, f) => frames.push({ jobId, mime: f.mime, n: f.data.length }) });
  (phone as any).save({ state: "ready", instanceId: "i-1", publicIp: "1.2.3.4", lastUseAt: Date.now() });
  await phone.control("tap", { x: "10", y: "20" }, "job-7");
  await Bun.sleep(150);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0]).toEqual({ jobId: "job-7", mime: "image/jpeg", n: 2000 });
  expect(cmds.some((c) => c.includes("convert png:- -resize"))).toBe(true); // made small on the box
  working = false;
  await Bun.sleep(80);
  const seen = frames.length;
  await Bun.sleep(100);
  expect(frames.length).toBe(seen);
});

test("Android comes back after every stop: a real multi-arch image, restarted by Docker, healed on each open", () => {
  expect(REDROID_IMAGE).toMatch(/^redroid\/redroid:\d+\.\d+\.\d+-\d{6}$/); // pinned; there is no "-arm64" tag
  for (const script of [redroidUserData(), ENSURE_ANDROID]) {
    expect(script).toContain(REDROID_IMAGE);
    expect(script).toContain("--restart unless-stopped");
    expect(script).not.toContain("--rm");
  }
  expect(ENSURE_ANDROID).toContain("adb connect 127.0.0.1:5555"); // after a reboot nothing else connects adb
});

test("owner screen: a picture once ready, the step while starting; owner input is limited to taps, swipes, typing, keys", async () => {
  const v = vault();
  configured(null as any, v);
  v.set("phone-sshkey", "KEY");
  const cmds: string[] = [];
  const ssh = { runner: () => ({ run: async (cmd: string, o: { onLine?: (l: string) => void }) => {
    cmds.push(cmd);
    if (cmd.includes("screencap")) o.onLine?.(Buffer.alloc(3000, 1).toString("base64"));
    return { code: 0, stderr: "" };
  } }) } as any;
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-own-")), vault: v, ssh, isBusy: () => false });
  (phone as any).save({ state: "starting", step: "Waiting for Android to finish booting", instanceId: "i-1" });
  expect(await phone.ownerScreen()).toEqual({ state: "starting", step: "Waiting for Android to finish booting", error: undefined });
  (phone as any).save({ state: "ready", instanceId: "i-1", publicIp: "1.2.3.4", lastUseAt: Date.now() });
  const r = await phone.ownerScreen();
  expect(r.state).toBe("ready");
  expect(r.src).toStartWith("data:image/jpeg;base64,");
  expect(cmds.some((c) => c.includes("-resize 720x"))).toBe(true);
  await phone.ownerInput("type", { text: "p@ss w'rd&1" });
  // Quoted for the box's shell and again for Android's, so the password arrives as typed.
  expect(cmds.at(-1)).toBe(`touch /tmp/hearth-phone-lastseen 2>/dev/null; export ANDROID_SERIAL=127.0.0.1:5555; adb shell 'input text '"'"'p@ss%sw'"'"'"'"'"'"'"'"'rd&1'"'"''`);
  await expect(phone.ownerInput("open-app", { pkg: "com.x" })).rejects.toThrow();
  await expect(phone.ownerInput("close", {})).rejects.toThrow();
});

test("the phone skill hands sign-ins to the owner with hearth-phone handover and never types their passwords", async () => {
  const { phoneSkill } = await import("../src/phone.ts");
  const sk = phoneSkill("http://127.0.0.1:1", "k");
  expect(sk.body).toContain('hearth-phone handover "Sign in to Google Play"');
  expect(sk.body).toContain("[[answer-needed]]");
  expect(sk.body).toContain("com.android.vending");
  expect(sk.body).toMatch(/Never ask for a password in chat/);
  expect(sk.scripts!["hearth-phone"]).toContain("action=handover");
});

test("handover: the job that ran it gets the 'Open your phone' button once; it needs a job", async () => {
  const v = vault();
  configured(null as any, v);
  v.set("phone-sshkey", "KEY");
  const ssh = { runner: () => ({ run: async () => ({ code: 0, stderr: "" }) }) } as any;
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-ho-")), vault: v, ssh, isBusy: () => false });
  (phone as any).save({ state: "ready", instanceId: "i-1", publicIp: "1.2.3.4", lastUseAt: Date.now() });
  await expect(phone.control("handover", { text: "Sign in to Google Play" })).rejects.toThrow(/job/);
  expect((await phone.control("handover", { text: "Sign in to Google Play" }, "job-9")).ok).toBe(true);
  expect(phone.takeHandover("job-8")).toBe(false);
  expect(phone.takeHandover("job-9")).toBe(true);
  expect(phone.takeHandover("job-9")).toBe(false);
  expect(Phone.framesDir().startsWith(tmpdir())).toBe(true); // the hub's service can't write its home folder
});

test("open waits out a phone that's still stopping, then starts it; a second open shares the same start", async () => {
  const v = vault();
  configured(null as any, v);
  v.set("phone-sshkey", "KEY");
  const states = ["stopping", "stopping", "stopped", "pending", "running"];
  let i = 0, starts = 0;
  const ec2: Ec2 = async (_c, action) => {
    if (action === "StartInstances") { starts++; return "<ok/>"; }
    if (action === "DescribeInstances") {
      const st = states[Math.min(i++, states.length - 1)];
      return `<instanceState><name>${st}</name></instanceState>${st === "running" ? "<ipAddress>1.2.3.4</ipAddress>" : ""}`;
    }
    return "<ok/>";
  };
  const cmds: string[] = [];
  const ssh = { runner: () => ({ run: async (cmd: string, o: { onLine?: (l: string) => void }) => {
    cmds.push(cmd);
    if (cmd.includes("sys.boot_completed")) o.onLine?.("1");
    return { code: 0, stderr: "" };
  } }) } as any;
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-st-")), vault: v, ssh, ec2, isBusy: () => false, pollMs: 1 });
  (phone as any).save({ state: "off", instanceId: "i-1", keyName: "k", sgId: "sg-1" });
  const [a, b] = await Promise.all([phone.open("job-1"), phone.open("job-1")]);
  expect(a).toEqual({ ok: true });
  expect(b).toEqual({ ok: true });
  expect(starts).toBe(1); // only once it had stopped, and only one start for both opens
  expect(phone.view().state).toBe("ready");
  expect(cmds.every((c) => c.startsWith("touch /tmp/hearth-phone-lastseen 2>/dev/null; export ANDROID_SERIAL=127.0.0.1:5555;"))).toBe(true); // keeps the safety shutdown away; one adb device
  expect(cmds.some((c) => c.includes("hearth-phone-idle"))).toBe(true); // the old safety script is replaced on open
});

test("after a stop the box comes back on a new IP: its pinned key still matches, under the new address", () => {
  const pin = "|1|v/erqMEOedxuatCpUbawKZzeE8Y=|JDv1GCHgeZLDYHH0U3eXQkPYQHc= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH6Yzh";
  expect(pinnedFor(pin, "34.215.179.171")).toBe("34.215.179.171 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH6Yzh");
  expect(pinnedFor("52.12.4.91 ssh-ed25519 KEY1\n52.12.4.91 ecdsa-sha2-nistp256 KEY2", "1.2.3.4")).toBe("1.2.3.4 ssh-ed25519 KEY1\n1.2.3.4 ecdsa-sha2-nistp256 KEY2");
  expect(pinnedFor(undefined, "1.2.3.4")).toBeUndefined(); // first contact: pin it then
  expect(pinnedFor("garbage", "1.2.3.4")).toBeUndefined();
});

test("open-app starts the app's launcher screen, and says plainly when there's nothing to open", async () => {
  const v = vault();
  configured(null as any, v);
  v.set("phone-sshkey", "KEY");
  let launcher = "com.android.vending/.AssetBrowserActivity";
  const cmds: string[] = [];
  const ssh = { runner: () => ({ run: async (cmd: string, o: { onLine?: (l: string) => void }) => {
    cmds.push(cmd);
    if (cmd.includes("resolve-activity")) { if (!launcher) { o.onLine?.("NO_LAUNCHER"); return { code: 4, stderr: "" }; } o.onLine?.("Starting: Intent { cmp=" + launcher + " }"); }
    return { code: 0, stderr: "" };
  } }) } as any;
  const phone = new Phone({ dataDir: mkdtempSync(join(tmpdir(), "hearth-phone-oa-")), vault: v, ssh, isBusy: () => false });
  (phone as any).save({ state: "ready", instanceId: "i-1", publicIp: "1.2.3.4", lastUseAt: Date.now() });
  expect(await phone.control("open-app", { pkg: "com.android.vending" })).toEqual({ ok: true });
  expect(cmds.at(-1)).toContain("am start -n");
  launcher = "";
  await expect(phone.control("open-app", { pkg: "com.nope.app" })).rejects.toThrow(/isn't installed/);
  await expect(phone.control("open-app", { pkg: "x; rm -rf /" })).rejects.toThrow(/package name/);
});
