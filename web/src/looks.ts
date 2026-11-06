// Looks: the clay face turns into what the conversation is about (a plane for a flying chat, a rocket for a launch,
// a chef for dinner plans) and keeps its eyes. The orchestrator picks one when it names the ramble (thread.look);
// older rambles get one from their name. Built as SVG nodes (no innerHTML); fills are CSS classes (the CSP forbids
// inline styles): b = the teammate's clay, d = darker clay, k = ink, w = white, a = red, g = glass, y = flame,
// l = leaf, t = terracotta. Moving bits: spin, flick (propeller), flame, wave, sway, blinky, puff, float.

type Part = [string, Record<string, string | number>];
/** eyes: where the eyes sit (% of the box); parts: the drawing on a 100×100 box; move: how it acts while working. */
export type Look = { eyes: [number, number]; parts: Part[]; move: string; smile?: boolean };

const round = (cy = 60, r = 32): Part[] => [["ellipse", { class: "b", cx: 50, cy, rx: r + 2, ry: r }], ["ellipse", { class: "hi", cx: 38, cy: cy - r * 0.5, rx: r * 0.35, ry: r * 0.22 }]];

export const LOOKS: Record<string, Look> = {
  plane: { eyes: [60, 49], move: "fly", parts: [
    ["path", { class: "d", d: "M18 50 L9 25 C8 20 14 19 17 23 L33 45Z" }],
    ["path", { class: "b", d: "M10 53 C10 41 30 36 55 36 C77 36 89 44 89 52 C89 61 77 67 55 67 C30 67 10 63 10 53Z" }],
    ["ellipse", { class: "hi", cx: 50, cy: 42, rx: 22, ry: 4 }],
    ["path", { class: "d", d: "M38 56 L64 56 L51 82 C49 86 42 85 43 80Z" }],
    ["path", { class: "d", d: "M10 49 L4 41 C3 38 7 37 9 39 L18 47Z" }],
    ["circle", { class: "k", cx: 90, cy: 52, r: 3.5 }],
    ["rect", { class: "k flick", x: 89, y: 32, width: 3.2, height: 40, rx: 1.6 }],
  ] },
  rocket: { eyes: [50, 36], move: "rumble", parts: [
    ["path", { class: "y flame", d: "M42 69 Q50 98 58 69Z" }],
    ["path", { class: "a", d: "M33 46 L18 68 C17 71 20 72 22 70 L33 63Z" }],
    ["path", { class: "a", d: "M67 46 L82 68 C83 71 80 72 78 70 L67 63Z" }],
    ["path", { class: "b", d: "M50 6 C66 18 69 38 69 62 L31 62 C31 38 34 18 50 6Z" }],
    ["ellipse", { class: "hi", cx: 42, cy: 24, rx: 5, ry: 10 }],
    ["path", { class: "k", d: "M39 62 L61 62 L57 70 L43 70Z" }],
    ["circle", { class: "g", cx: 50, cy: 51, r: 5 }],
  ] },
  car: { eyes: [52, 41], move: "drive", smile: false, parts: [
    ["path", { class: "b", d: "M7 62 C7 53 13 49 23 49 L31 34 C33 30 37 28 43 28 L61 28 C67 28 71 30 74 34 L84 49 C90 49 94 53 94 60 L94 67 L7 67Z" }],
    ["path", { class: "g", d: "M37 33 L63 33 L72 48 L30 48Z" }],
    ["circle", { class: "y", cx: 91, cy: 57, r: 3 }],
    ["path", { class: "hi", d: "M14 54 L40 54 L40 57 L14 57Z" }],
    ["g", { class: "spin" }], ["circle", { class: "k", cx: 28, cy: 68, r: 10 }], ["circle", { class: "w", cx: 28, cy: 68, r: 4 }], ["rect", { class: "w", x: 27, y: 59, width: 2, height: 18 }], ["/g", {}],
    ["g", { class: "spin" }], ["circle", { class: "k", cx: 73, cy: 68, r: 10 }], ["circle", { class: "w", cx: 73, cy: 68, r: 4 }], ["rect", { class: "w", x: 72, y: 59, width: 2, height: 18 }], ["/g", {}],
  ] },
  boat: { eyes: [42, 68], move: "rock", parts: [
    ["rect", { class: "k", x: 47, y: 12, width: 3, height: 47, rx: 1.5 }],
    ["path", { class: "w sway", d: "M52 14 L52 54 L82 54Z" }],
    ["path", { class: "a", d: "M47 12 L36 16 L47 20Z" }],
    ["path", { class: "b", d: "M6 58 L94 58 L80 82 C78 85 75 86 72 86 L28 86 C25 86 22 85 20 82Z" }],
    ["ellipse", { class: "hi", cx: 30, cy: 63, rx: 14, ry: 2.5 }],
    ["path", { class: "wv wave", d: "M-10 92 q8 -6 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0" }],
  ] },
  train: { eyes: [50, 44], move: "drive", parts: [
    ["rect", { class: "b", x: 18, y: 18, width: 64, height: 58, rx: 16 }],
    ["rect", { class: "g", x: 26, y: 26, width: 48, height: 26, rx: 8 }],
    ["circle", { class: "y", cx: 32, cy: 64, r: 4 }], ["circle", { class: "y", cx: 68, cy: 64, r: 4 }],
    ["path", { class: "k", d: "M28 76 L18 90 L24 90 L34 76Z M72 76 L82 90 L76 90 L66 76Z" }],
    ["rect", { class: "k", x: 14, y: 88, width: 72, height: 3, rx: 1.5 }],
  ] },
  robot: { eyes: [50, 52], move: "beep", parts: [
    ["rect", { class: "k", x: 48.5, y: 10, width: 3, height: 16 }],
    ["circle", { class: "a blinky", cx: 50, cy: 10, r: 5 }],
    ["rect", { class: "d", x: 8, y: 42, width: 10, height: 20, rx: 4 }], ["rect", { class: "d", x: 82, y: 42, width: 10, height: 20, rx: 4 }],
    ["rect", { class: "b", x: 16, y: 24, width: 68, height: 58, rx: 18 }],
    ["ellipse", { class: "hi", cx: 34, cy: 32, rx: 10, ry: 4 }],
    ["rect", { class: "k", x: 38, y: 68, width: 24, height: 5, rx: 2.5 }],
  ] },
  chef: { eyes: [50, 62], move: "stir", parts: [
    ...round(64, 28),
    ["path", { class: "w", d: "M30 40 C20 40 18 24 30 22 C32 10 46 8 50 15 C56 6 72 10 70 22 C82 22 80 40 70 40Z" }],
    ["rect", { class: "w", x: 31, y: 34, width: 38, height: 10, rx: 3 }],
    ["path", { class: "puff", d: "M80 50 q4 -6 0 -12 q-4 -6 0 -12" }],
  ] },
  cat: { eyes: [50, 58], move: "hop", parts: [
    ["path", { class: "b", d: "M20 46 L22 14 L44 32Z" }], ["path", { class: "b", d: "M80 46 L78 14 L56 32Z" }],
    ["path", { class: "t", d: "M25 36 L26 22 L36 31Z" }], ["path", { class: "t", d: "M75 36 L74 22 L64 31Z" }],
    ...round(60, 32),
    ["path", { class: "wh", d: "M16 64 L32 66 M16 72 L32 70 M84 64 L68 66 M84 72 L68 70" }],
  ] },
  dog: { eyes: [50, 56], move: "hop", parts: [
    ...round(60, 32),
    ["path", { class: "d sway", d: "M22 34 C10 36 6 60 14 70 C20 74 26 60 28 44Z" }],
    ["path", { class: "d sway", d: "M78 34 C90 36 94 60 86 70 C80 74 74 60 72 44Z" }],
    ["ellipse", { class: "k", cx: 50, cy: 66, rx: 5, ry: 3.5 }],
  ] },
  house: { eyes: [42, 64], move: "puff", parts: [
    ["rect", { class: "d", x: 66, y: 16, width: 10, height: 20 }],
    ["path", { class: "puff", d: "M71 12 q4 -4 0 -8 q-4 -4 0 -8" }],
    ["rect", { class: "b", x: 18, y: 46, width: 64, height: 44, rx: 6 }],
    ["path", { class: "a", d: "M10 50 L50 16 L90 50 C92 52 90 55 87 54 L50 26 L13 54 C10 55 8 52 10 50Z" }],
    ["rect", { class: "d", x: 60, y: 66, width: 14, height: 24, rx: 3 }],
  ] },
  book: { eyes: [56, 44], move: "flick", parts: [
    ["rect", { class: "w", x: 28, y: 14, width: 54, height: 74, rx: 6 }],
    ["rect", { class: "b", x: 22, y: 10, width: 56, height: 74, rx: 8 }],
    ["rect", { class: "d", x: 22, y: 10, width: 10, height: 74, rx: 4 }],
    ["ellipse", { class: "hi", cx: 50, cy: 18, rx: 14, ry: 3 }],
    ["path", { class: "a", d: "M64 10 L64 32 L69 27 L74 32 L74 10Z" }],
  ] },
  music: { eyes: [50, 60], move: "groove", parts: [
    ...round(62, 30),
    ["path", { class: "band", d: "M16 60 C16 22 84 22 84 60" }],
    ["rect", { class: "k", x: 10, y: 52, width: 12, height: 22, rx: 6 }], ["rect", { class: "k", x: 78, y: 52, width: 12, height: 22, rx: 6 }],
    ["path", { class: "k float", d: "M86 14 L86 30 A4 4 0 1 1 83 26 L83 12 L94 10 L94 14Z" }],
  ] },
  plant: { eyes: [50, 50], move: "sway", parts: [
    ["path", { class: "l sway", d: "M50 24 C44 8 28 6 24 12 C32 14 40 20 50 28Z" }],
    ["path", { class: "l sway", d: "M50 24 C56 6 74 6 78 12 C68 14 60 20 50 28Z" }],
    ["ellipse", { class: "b", cx: 50, cy: 50, rx: 24, ry: 22 }],
    ["ellipse", { class: "hi", cx: 42, cy: 38, rx: 7, ry: 4 }],
    ["path", { class: "t", d: "M26 66 L74 66 L68 92 C67 94 65 95 63 95 L37 95 C35 95 33 94 32 92Z" }],
    ["rect", { class: "t", x: 22, y: 62, width: 56, height: 9, rx: 3 }],
  ] },
  money: { eyes: [50, 62], move: "jingle", parts: [
    ["path", { class: "b", d: "M50 32 C78 32 88 62 82 78 C78 90 22 90 18 78 C12 62 22 32 50 32Z" }],
    ["path", { class: "d", d: "M38 20 C44 26 56 26 62 20 L58 34 L42 34Z" }],
    ["rect", { class: "a", x: 38, y: 30, width: 24, height: 6, rx: 3 }],
    ["ellipse", { class: "hi", cx: 36, cy: 46, rx: 8, ry: 5 }],
    ["circle", { class: "y float", cx: 84, cy: 22, r: 7 }],
  ] },
  laptop: { eyes: [50, 42], move: "type", parts: [
    ["rect", { class: "b", x: 16, y: 16, width: 68, height: 50, rx: 8 }],
    ["rect", { class: "g", x: 22, y: 22, width: 56, height: 38, rx: 4 }],
    ["path", { class: "d", d: "M8 72 L92 72 L88 80 C87 82 85 83 83 83 L17 83 C15 83 13 82 12 80Z" }],
    ["rect", { class: "b", x: 14, y: 66, width: 72, height: 7, rx: 3 }],
  ] },
  ball: { eyes: [50, 46], move: "bounce", parts: [
    ...round(52, 36),
    ["path", { class: "seam", d: "M14 52 L86 52 M50 16 C34 30 34 74 50 88 M50 16 C66 30 66 74 50 88" }],
  ] },
  heart: { eyes: [50, 46], move: "beat", parts: [
    ["path", { class: "b", d: "M50 88 C20 66 8 50 8 34 C8 20 18 12 30 12 C40 12 46 18 50 26 C54 18 60 12 70 12 C82 12 92 20 92 34 C92 50 80 66 50 88Z" }],
    ["ellipse", { class: "hi", cx: 28, cy: 26, rx: 8, ry: 5 }],
    ["ellipse", { class: "cheek", cx: 30, cy: 54, rx: 6, ry: 4 }], ["ellipse", { class: "cheek", cx: 70, cy: 54, rx: 6, ry: 4 }],
  ] },
  cloud: { eyes: [50, 54], move: "drift", parts: [
    ["path", { class: "b", d: "M24 72 C10 72 6 56 18 50 C16 34 34 26 44 36 C50 20 76 22 76 42 C92 42 94 70 78 72Z" }],
    ["ellipse", { class: "hi", cx: 40, cy: 40, rx: 8, ry: 4 }],
    ["path", { class: "rain", d: "M32 80 l-3 8 M50 80 l-3 8 M68 80 l-3 8" }],
  ] },
  brick: { eyes: [50, 60], move: "stack", parts: [
    ["rect", { class: "b", x: 24, y: 18, width: 16, height: 14, rx: 4 }], ["rect", { class: "b", x: 60, y: 18, width: 16, height: 14, rx: 4 }],
    ["ellipse", { class: "hi", cx: 32, cy: 20, rx: 6, ry: 2.5 }], ["ellipse", { class: "hi", cx: 68, cy: 20, rx: 6, ry: 2.5 }],
    ["rect", { class: "b", x: 12, y: 28, width: 76, height: 60, rx: 10 }],
    ["ellipse", { class: "hi", cx: 34, cy: 36, rx: 14, ry: 4 }],
  ] },
  // No topic to go on: still not the same guy every time, a little outfit instead.
  partyhat: { eyes: [50, 62], move: "hop", parts: [...round(64, 28), ["path", { class: "a", d: "M36 40 L50 6 L64 40Z" }], ["circle", { class: "y", cx: 50, cy: 6, r: 5 }], ["path", { class: "w", d: "M41 28 L59 28 L61 33 L39 33Z" }]] },
  beanie: { eyes: [50, 64], move: "hop", parts: [...round(64, 28), ["path", { class: "a", d: "M20 46 C20 18 80 18 80 46Z" }], ["rect", { class: "d", x: 18, y: 42, width: 64, height: 10, rx: 5 }], ["circle", { class: "w", cx: 50, cy: 18, r: 7 }]] },
  crown: { eyes: [50, 62], move: "hop", parts: [...round(64, 28), ["path", { class: "y", d: "M30 42 L28 18 L40 30 L50 14 L60 30 L72 18 L70 42Z" }], ["circle", { class: "a", cx: 50, cy: 34, r: 3 }]] },
  bow: { eyes: [50, 58], move: "hop", parts: [...round(60, 32), ["path", { class: "a", d: "M50 26 L34 16 C28 14 26 34 34 32Z M50 26 L66 16 C72 14 74 34 66 32Z" }], ["circle", { class: "a", cx: 50, cy: 25, r: 5 }]] },
};

// Older rambles (named before looks existed) and when the orchestrator skips it: guess from the words.
const WORDS: [RegExp, string][] = [
  [/plane|flight|fly|flying|aircraft|airline|airport|pilot|drone|dogfight|jet|glider/i, "plane"],
  [/rocket|space|launch|mars|moon|nasa|satellite|orbit|astronaut/i, "rocket"],
  [/train|rail|subway|metro|amtrak/i, "train"],
  [/boat|ship|sail|cruise|ocean|kayak|ferry|yacht|sea\b|beach/i, "boat"],
  [/\bcar\b|cars\b|drive|driving|uber|lyft|tesla|road.?trip|vehicle|parking|garage/i, "car"],
  [/lego|brick|build(ing)? blocks?/i, "brick"],
  [/robot|\bai\b|\bllm|agent|\bbot\b|claude|gpt|model/i, "robot"],
  [/code|coding|bug|deploy|app\b|website|repo|github|api\b|server|linkedin|email|inbox|listing|glama/i, "laptop"],
  [/cook|recipe|meal|food|dinner|lunch|breakfast|restaurant|grocer|bake|chef/i, "chef"],
  [/\bcats?\b|kitten/i, "cat"], [/\bdogs?\b|puppy|pet\b|\bvet\b/i, "dog"],
  [/house|home|apartment|rent|landlord|move|moving|furniture/i, "house"],
  [/book|read|study|learn|school|class|exam|course|homework/i, "book"],
  [/music|song|playlist|concert|spotify|guitar|piano|band\b/i, "music"],
  [/plant|garden|tree|flower|grow/i, "plant"],
  [/money|budget|tax|invest|bill|bank|stock|pay|price|finance|crypto/i, "money"],
  [/gym|workout|soccer|football|basketball|tennis|run\b|running|sport|game\b/i, "ball"],
  [/love|date|dating|wedding|girlfriend|boyfriend|partner|anniversary|valentine/i, "heart"],
  [/weather|rain|storm|snow|forecast/i, "cloud"],
];
const OUTFITS = ["partyhat", "beanie", "crown", "bow"];

/** The look for a ramble: the one the orchestrator picked, else one from its words, else an outfit picked by its id. */
export function lookFor(thread: { id?: string; look?: string; channel?: string; title?: string } | null | undefined): string | null {
  if (!thread?.id || thread.id === "new" || thread.id.startsWith("tm-")) return null;
  if (thread.look && LOOKS[thread.look]) return thread.look;
  const words = `${thread.channel || ""} ${thread.title || ""}`.replace(/-/g, " ");
  const hit = WORDS.find(([re]) => re.test(words));
  if (hit) return hit[1];
  let n = 0;
  for (const c of thread.id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return OUTFITS[n % OUTFITS.length];
}

/** The drawing for a look, as an <svg>; ["g", …] … ["/g"] groups parts that move together. */
export function lookArt(name: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "lookart");
  let into: Element = svg;
  for (const [tag, attrs] of LOOKS[name].parts) {
    if (tag === "/g") { into = svg; continue; }
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    into.appendChild(el);
    if (tag === "g") into = el;
  }
  return svg;
}

export const LOOK_NAMES = Object.keys(LOOKS).filter((k) => !OUTFITS.includes(k));

// While working, the look picks up a small change every 10 minutes (shades, blush, goggles…), so a long run isn't the
// same face all along. Back to plain when it stops. The first stretch is plain.
const EXTRAS = ["", "shades", "blush", "goggles", "sweat", "sparkle", "stache"];
export const EXTRA_EVERY_MS = 10 * 60_000;
export const extraNow = (now = Date.now()) => EXTRAS[Math.floor(now / EXTRA_EVERY_MS) % EXTRAS.length];
