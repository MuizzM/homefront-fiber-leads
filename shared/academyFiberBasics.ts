// ── Fiber 101 ─────────────────────────────────────────────────────────────────
//
// The vocabulary and the physical story a brand-new rep needs before anything
// else makes sense: what the words mean, and how the line actually travels
// underground from the hut to the wall of a house.
//
// EVERY TERM CARRIES AN ANALOGY
//   A definition tells a rep what something is. An analogy is what they can say
//   on a porch and have land. Both are here, plus a say-it-at-the-door line
//   where one exists, because the glossary is a speaking tool, not a study
//   sheet.
//
// NO FIGURES, SAME RULE AS THE REFERENCE CARDS
//   Speeds and prices live in shared/academyOffers.ts, resolved per market per
//   day. A glossary entry explains what a unit IS; it never quotes a plan.
//   Units are described in words so a stale number can never hide here.

export type GlossaryCategory = "line" | "build" | "numbers" | "home";

export const GLOSSARY_CATEGORIES: readonly GlossaryCategory[] = ["line", "build", "numbers", "home"];

export const GLOSSARY_CATEGORY_TITLES: Readonly<Record<GlossaryCategory, string>> = {
  line: "The line",
  build: "The build",
  numbers: "The numbers",
  home: "In the house",
};

export type GlossaryTerm = {
  /** Stable id for progress and deep links. */
  id: string;
  term: string;
  category: GlossaryCategory;
  /** What it is, in plain words. */
  plain: string;
  /** The picture that makes it stick, usable verbatim on a porch. */
  analogy: string;
  /** A one-sentence line for the door, or null where the term is internal. */
  atTheDoor: string | null;
};

export const FIBER_GLOSSARY: readonly GlossaryTerm[] = [
  // ── The line ────────────────────────────────────────────────────────────────
  {
    id: "term-fiber",
    term: "Fiber optic line",
    category: "line",
    plain:
      "A strand of glass thinner than a hair that carries data as pulses of light instead of electricity. Light does not fade or pick up interference the way an electrical signal does, so what goes in one end comes out the other unchanged.",
    analogy:
      "Copper is like shouting down a long hallway: the farther it goes, the muddier it gets. Fiber is like flashing a light down a mirror-lined tube: the message arrives exactly as it left.",
    atTheDoor:
      "It is a strand of glass carrying your internet as light, which is why it stays steady when the old lines get noisy.",
  },
  {
    id: "term-ftth",
    term: "FTTH, fiber to the home",
    category: "line",
    plain:
      "Glass the entire way, from the hut to the wall of the house. Some services advertise fiber but run it only to a neighborhood box, with the old coax line finishing the trip.",
    analogy:
      "A paved highway all the way into your driveway, instead of pavement that ends a mile out with gravel for the last stretch. The gravel decides how the ride feels.",
    atTheDoor:
      "The build on this street is fiber to the house itself, not fiber to a box down the road with the old cable finishing the job.",
  },
  {
    id: "term-backbone",
    term: "Backbone",
    category: "line",
    plain:
      "The heavy trunk lines that carry the whole market's traffic between the hut and the wider internet. Neighborhood lines branch off it.",
    analogy: "The interstate. Your street is an exit ramp off it, and your house is a driveway off the ramp.",
    atTheDoor: null,
  },
  {
    id: "term-drop",
    term: "Drop",
    category: "line",
    plain:
      "The final piece of line that serves exactly one home, run from the street's access box to the house on install day.",
    analogy: "Your private driveway off the shared road. Nobody else's traffic is ever on it.",
    atTheDoor:
      "Install day is mostly running your own drop from the street to the house, a line that only your home uses.",
  },
  {
    id: "term-pon",
    term: "PON, passive optical network",
    category: "line",
    plain:
      "The way one light source at the hut is split out to many homes with no powered equipment sitting in the field between. Passive means nothing out there needs electricity, which means less to fail in heat, storms and outages.",
    analogy:
      "One water main feeding a street of houses through simple splitters, with no pumps buried in anyone's yard to break down in August.",
    atTheDoor:
      "Between the hut and your house there is nothing powered to fail, which is a big part of why fiber outages are rare.",
  },
  {
    id: "term-copper",
    term: "Copper and coax, the old lines",
    category: "line",
    plain:
      "The phone-era copper pair and the cable-era coaxial line both carry data as electricity. Electrical signal fades with distance, picks up interference, and shares capacity with the neighbors on the same segment.",
    analogy:
      "A message whispered down a line of people. Every handoff loses a little, and on a busy day the room is loud.",
    atTheDoor: null,
  },

  // ── The build ───────────────────────────────────────────────────────────────
  {
    id: "term-conduit",
    term: "Conduit",
    category: "build",
    plain:
      "The buried pipe the fiber is pulled through. The pipe is the expensive part to place; once it is in, the glass inside it can be added to or replaced without digging anything up again.",
    analogy: "A straw under the yard. The drink can change; the straw stays put.",
    atTheDoor: null,
  },
  {
    id: "term-bore",
    term: "Directional bore",
    category: "build",
    plain:
      "The machine that installs conduit underground without digging a trench. It enters at a small pit, steers under yards, driveways and streets, and surfaces at the next pit, leaving everything above untouched.",
    analogy:
      "A mole that goes down at one corner of the block and comes up at the other. Two small holes, and the lawn between them never knows it happened.",
    atTheDoor:
      "The crew bores underneath the yards rather than trenching through them, so the grass above the line is not disturbed.",
  },
  {
    id: "term-vault",
    term: "Vault and handhole",
    category: "build",
    plain:
      "Buried access boxes placed every few homes, where the street's fiber is stored, spliced and connected. The lid at grade is often the only visible sign the build is done.",
    analogy:
      "A junction drawer set into the curb. A tech opens the drawer to work on the street's wiring instead of excavating the street.",
    atTheDoor:
      "That small lid near the curb is the access point; your line would run from there to the house.",
  },
  {
    id: "term-pedestal",
    term: "Pedestal",
    category: "build",
    plain:
      "The small green cabinet above ground doing the same job as a vault where burying a box is impractical. If a line is coiled at one, it is staged for a connection, not abandoned.",
    analogy: "The same junction drawer, standing up instead of set into the ground.",
    atTheDoor: null,
  },
  {
    id: "term-splice",
    term: "Splice",
    category: "build",
    plain:
      "Joining two glass strands by fusing them end to end in a machine that aligns them to a fraction of a hair's width. A good splice is invisible to the light passing through it.",
    analogy:
      "Welding two hairs together so cleanly that a beam of light cannot find the seam.",
    atTheDoor: null,
  },
  {
    id: "term-locates",
    term: "Locates and flags",
    category: "build",
    plain:
      "Before any boring, the utilities already underground are marked with paint and flags so the new conduit is steered around them. The colors are a national code: each color is a different kind of buried line.",
    analogy:
      "An X-ray taken before surgery. The flags mean the crew looked before it drilled, which is exactly what a homeowner should want.",
    atTheDoor:
      "The paint and flags are not damage, they are the markout of what is already buried, done before any machine arrives so nothing gets hit.",
  },

  // ── The numbers ─────────────────────────────────────────────────────────────
  {
    id: "term-bandwidth",
    term: "Bandwidth",
    category: "numbers",
    plain:
      "How much data can flow at once. It is capacity, not quickness: a bigger figure means more things can happen at the same time without crowding each other.",
    analogy:
      "Lanes on a road, not the speed limit. Four cars on a one-lane road queue up; on four lanes they travel side by side.",
    atTheDoor:
      "The question is not whether one thing works, it is whether everything works at once on a weeknight.",
  },
  {
    id: "term-symmetrical",
    term: "Symmetrical",
    category: "numbers",
    plain:
      "Upload and download at the same figure. Cable is built asymmetric: a wide path into the house and a narrow one out, which is why sending anything is where it struggles.",
    analogy:
      "A road with as many lanes leaving as arriving. Cable is a highway inbound and an alley outbound, and your camera, your voice and your backups all live in the alley.",
    atTheDoor:
      "Look at the upload figure on your own bill next to the download. Fiber quotes one figure both directions.",
  },
  {
    id: "term-latency",
    term: "Latency",
    category: "numbers",
    plain:
      "The delay before data starts moving, measured in milliseconds. Gaming, calls and live video feel latency; a movie stream mostly does not, because it buffers ahead.",
    analogy:
      "Reaction time, not top speed. A sports car with slow reflexes still loses the first second of the race, and video calls are made of first seconds.",
    atTheDoor: null,
  },
  {
    id: "term-jitter",
    term: "Jitter",
    category: "numbers",
    plain:
      "Variation in latency from moment to moment. A call can survive a steady delay; it stutters when the delay keeps changing size.",
    analogy: "A drummer who cannot hold tempo. The song survives a slow tempo, not a wandering one.",
    atTheDoor: null,
  },
  {
    id: "term-units",
    term: "Mbps and Gbps",
    category: "numbers",
    plain:
      "Megabits and gigabits per second, the units plans are quoted in. A gigabit is a thousand megabits. Note the small b: bits, not the bytes file sizes use, which is why a download's figure never matches the plan's on paper.",
    analogy:
      "Gallons per minute, for data. The unit describes the pipe, and the pipe is what you are actually buying.",
    atTheDoor: null,
  },

  // ── In the house ────────────────────────────────────────────────────────────
  {
    id: "term-ont",
    term: "ONT, optical network terminal",
    category: "home",
    plain:
      "The small box on the wall where the glass ends. It turns light back into a normal network signal the home's equipment understands. On fiber it plays the role a modem played on cable.",
    analogy:
      "The translator at the border: light speaks on one side, your house speaks on the other, and the ONT stands between them.",
    atTheDoor:
      "The install ends at a small box on the wall where the light becomes normal internet, and your WiFi plugs into that.",
  },
  {
    id: "term-router",
    term: "Router, and why it is not the modem",
    category: "home",
    plain:
      "The router makes the WiFi and shares the connection between devices. The ONT brings the internet in; the router spreads it around. A weak router on a strong line still feels weak in the back bedroom.",
    analogy:
      "The ONT is the front door; the router is the hallway speaker repeating what comes through it. A great door with a quiet speaker is still hard to hear upstairs.",
    atTheDoor:
      "Fiber replaces the line into the house. Coverage inside is the router's job, and it is honest to keep those two sentences separate.",
  },
  {
    id: "term-mesh",
    term: "Mesh WiFi",
    category: "home",
    plain:
      "Several access points around the home sharing one network name, so a device talks to the nearest point instead of one box far away.",
    analogy:
      "Ceiling speakers in every room instead of one loud speaker in the kitchen. Nobody has to shout, including the equipment.",
    atTheDoor: null,
  },
];

const TERM_BY_ID: ReadonlyMap<string, GlossaryTerm> = new Map(FIBER_GLOSSARY.map((t) => [t.id, t]));

export function getGlossaryTerm(id: string): GlossaryTerm | undefined {
  return TERM_BY_ID.get(id);
}

export function glossaryIn(category: GlossaryCategory): GlossaryTerm[] {
  return FIBER_GLOSSARY.filter((t) => t.category === category);
}

/** Case-insensitive match on the term, the definition and the analogy. */
export function searchGlossary(query: string): GlossaryTerm[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...FIBER_GLOSSARY];
  return FIBER_GLOSSARY.filter((t) =>
    [t.term, t.plain, t.analogy, t.atTheDoor ?? ""].some((s) => s.toLowerCase().includes(q)),
  );
}

// ── Fiber, in their words ─────────────────────────────────────────────────────
// The part of the job that is not vocabulary: what fiber IS to a homeowner,
// what it changes about their evening, how it compares to the cable they have,
// why neighbors actually switch, and how to say all of it without a single
// spec. Nobody buys megabits. They buy the call that stops freezing.
//
// HONESTY IS LOAD-BEARING HERE TOO
//   Every comparison row carries the thing the customer can check themselves,
//   the switch list ends with who should NOT switch, and nothing quotes a
//   price or a speed figure, because those live in the offer catalog.

export type WhyFiberCard = {
  id: string;
  /** The benefit, in homeowner words. */
  benefit: string;
  /** What actually changes in their week. */
  feel: string;
  /** The porch line, usable verbatim. */
  sayIt: string;
};

export const WHY_FIBER: readonly WhyFiberCard[] = [
  {
    id: "why-everyone-online",
    benefit: "Everyone online at once",
    feel:
      "The evening pile-up is the problem most households actually have: shows, calls, games and homework all landing on the line at the same hour, and everything getting a little worse.",
    sayIt:
      "When everybody gets home and gets on at once, nobody's show, call or game has to wait for the house to catch up.",
  },
  {
    id: "why-both-directions",
    benefit: "Your side of the call works",
    feel:
      "Everything a household sends out, a face on a call, a voice, homework turned in, photos backing up, squeezes through the narrow half of a cable line. Fiber gives sending the same room as receiving.",
    sayIt:
      "It is not just what comes into the house. What you send out, your face and your voice on a call, gets the same full lane.",
  },
  {
    id: "why-steady",
    benefit: "Steady when it matters",
    feel:
      "Peak speed on a quiet afternoon is a brochure number. The hours a household cares about are weeknight evenings, and steadiness through those hours is what fiber is for.",
    sayIt:
      "The number that matters is not the fastest it ever goes. It is what you get at eight on a weeknight, and that is where fiber holds.",
  },
  {
    id: "why-own-line",
    benefit: "The last stretch is yours",
    feel:
      "The drop from the street serves one address. Nothing a neighbor does on their line happens on yours.",
    sayIt: "From the street to your wall, the line carries your house and nobody else's.",
  },
  {
    id: "why-built-ahead",
    benefit: "Built past what you need",
    feel:
      "The glass in the ground carries far more than any home uses today. When faster service comes, it arrives by changing the equipment at the ends, not by digging the yard again.",
    sayIt:
      "This is the last line that needs to go in. When things get faster later, the glass already handles it.",
  },
];

export type CableVsFiberRow = {
  id: string;
  /** The question as the homeowner would ask it. */
  question: string;
  /** What is honestly true of cable. Never a swipe. */
  cable: string;
  /** What is honestly true of fiber. */
  fiber: string;
  /** The thing the customer can verify without trusting the rep. */
  check: string;
};

export const CABLE_VS_FIBER: readonly CableVsFiberRow[] = [
  {
    id: "vs-download",
    question: "Isn't cable already fast?",
    cable:
      "Genuinely, yes. Modern cable download speeds are fast, and a rep who suggests otherwise loses the conversation to a speed test.",
    fiber:
      "The difference is not the download brochure number. It is the other direction, and what happens to the line in the evening.",
    check: "Their own speed test on a weeknight evening, next to the plan they pay for.",
  },
  {
    id: "vs-upload",
    question: "So what is actually different?",
    cable:
      "Cable is built wide into the house and narrow back out. Upload is a small fraction of download, by design, and most people have never looked at that number.",
    fiber:
      "Fiber runs the same speed in both directions, so calls, backups and everything else the house sends out get a full lane.",
    check: "The upload figure printed on their own bill, next to the download figure.",
  },
  {
    id: "vs-evening",
    question: "Why does it crawl at night?",
    cable:
      "The last stretch of a cable line is shared with the neighborhood, so everyone's evening lands on the same wire. The slowdown is real, not imagined.",
    fiber:
      "The glass serving the street carries far more than the street can use, so the evening pile-up does not reach the point of hurting.",
    check: "Whether their slow hours line up with exactly when the street gets home.",
  },
  {
    id: "vs-honest",
    question: "Is cable ever the right choice?",
    cable:
      "If the household is happy, has no evening pain and likes its price, yes. Say so and leave well.",
    fiber:
      "Fiber should win on the checkable things: upload, evening steadiness, a private last stretch. It never needs to win by running the other side down.",
    check: "Everything in this table. Invite them to check it, and mean the invitation.",
  },
];

export type SwitchReason = {
  id: string;
  reason: string;
  /** The one-sentence story of how this shows up in a real house. */
  story: string;
};

export const WHY_PEOPLE_SWITCH: readonly SwitchReason[] = [
  {
    id: "switch-evening",
    reason: "The slowdown they stopped noticing",
    story:
      "Fine at noon, crawling at eight, for so long the household renamed it weather. The switch starts the day someone says it does not have to be.",
  },
  {
    id: "switch-upload",
    reason: "The day the camera froze",
    story:
      "The first video call from the kitchen table is how most houses find out what upload they actually bought.",
  },
  {
    id: "switch-creep",
    reason: "The bill that grew on its own",
    story:
      "The promo ended quietly and the number crept while the service stayed the same. People switch when they notice the creep, not the price.",
  },
  {
    id: "switch-rental",
    reason: "Rent on a box, forever",
    story:
      "Equipment rental is a line on their own bill, every month, for gear they will never own. Adding a year of it out loud is often the whole conversation.",
  },
  {
    id: "switch-first-choice",
    reason: "The first real choice",
    story:
      "On a lot of these streets there was one wired option for twenty years. The build finishing is the first time choosing was possible at all.",
  },
  {
    id: "switch-not",
    reason: "And who should not switch",
    story:
      "A household that is happy, feels no pain and likes its price. Leaving that door well is what earns the callback when any of that changes.",
  },
];

export type SimpleTranslation = {
  id: string;
  /** The jargon a rep is tempted to say. */
  jargon: string;
  /** What the homeowner actually hears when they say it. */
  theyHear: string;
  /** The plain version that lands. */
  sayInstead: string;
};

export const SAY_IT_SIMPLE: readonly SimpleTranslation[] = [
  {
    id: "simple-gig",
    jargon: "A gig",
    theyHear: "A number with no feeling attached to it.",
    sayInstead:
      "More than your whole house can use at once. Everyone on at the same time, and nobody waiting on anybody.",
  },
  {
    id: "simple-mbps",
    jargon: "Mbps",
    theyHear: "Letters. Possibly a typo.",
    sayInstead:
      "How wide the pipe is. A show needs a little of it, a call needs it in both directions, and a full house needs width more than it needs a record.",
  },
  {
    id: "simple-bandwidth",
    jargon: "Bandwidth",
    theyHear: "A word from a meeting they did not enjoy.",
    sayInstead: "Lanes on a road, not the speed limit. More lanes means nobody sits in a queue.",
  },
  {
    id: "simple-symmetrical",
    jargon: "Symmetrical",
    theyHear: "A shape from geometry class.",
    sayInstead: "The same speed out as in. Your camera and your voice get what your movies get.",
  },
  {
    id: "simple-upload",
    jargon: "Upload",
    theyHear: "Something about files, probably not about them.",
    sayInstead:
      "Everything that leaves your house: your face on the call, your voice, the photos quietly backing up. That is the half most plans starve.",
  },
  {
    id: "simple-latency",
    jargon: "Low latency",
    theyHear: "More letters.",
    sayInstead:
      "Reaction time. It is why a click feels instant or feels late, and why the game feels fair or feels rigged.",
  },
  {
    id: "simple-fiber",
    jargon: "Fiber optic",
    theyHear: "A cable brand, or breakfast cereal.",
    sayInstead:
      "Glass carrying light. The old lines carry electricity, and electricity fades and picks up noise on the way. Light arrives the way it left.",
  },
  {
    id: "simple-wifi",
    jargon: "WiFi",
    theyHear: "The internet itself. To most houses they are the same word.",
    sayInstead:
      "The line brings the internet to the house, and WiFi spreads it around inside. Two different jobs, and fixing one does not fix the other. Honest reps keep those two sentences apart.",
  },
];

// ── The underground journey ───────────────────────────────────────────────────
// The physical story, told in the order it happens on a real street. A rep who
// can walk a homeowner from the hut to the wall in six steps sounds like
// someone who knows the build, because at that point they do.

export type JourneyStep = {
  /** One-based position in the story. */
  step: number;
  title: string;
  /** What physically happens. */
  what: string;
  /** The picture to hand the homeowner. */
  analogy: string;
  /** The sentence a rep can use when this step comes up at a door. */
  atTheDoor: string;
};

export const UNDERGROUND_JOURNEY: readonly JourneyStep[] = [
  {
    step: 1,
    title: "The hut",
    what:
      "Every market has a hut or exchange building where the internet arrives on backbone trunk lines. Everything a neighborhood uses fans out from there as light.",
    analogy: "The water tower, for data. One source, feeding every street below it.",
    atTheDoor:
      "Your service would come from the local hut that already feeds this area, not from somewhere across the country.",
  },
  {
    step: 2,
    title: "Locates and flags",
    what:
      "Before anything is drilled, the lines already underground are marked out with paint and flags so the new conduit can be steered around gas, water and power.",
    analogy: "An X-ray before surgery. Look first, then cut, and only where it is safe.",
    atTheDoor:
      "The flags in a yard mean the crew checked what is already buried before drilling. They are the sign it is being done carefully, not carelessly.",
  },
  {
    step: 3,
    title: "The bore",
    what:
      "A directional boring machine pulls conduit under streets, sidewalks and yards from one small pit to the next. No trench is opened along the way, and the fiber is pulled through the conduit afterwards.",
    analogy:
      "A mole that goes down at one corner and surfaces at the next. Two modest holes, and untouched ground between them.",
    atTheDoor:
      "The machine tunnels underneath rather than digging through, which is why a finished street shows almost no sign the build happened.",
  },
  {
    step: 4,
    title: "The vault at the curb",
    what:
      "Every few homes the conduit reaches a buried vault or handhole where the street's fiber is spliced and stored. The lid at grade, or a small green pedestal, is the access point for the block.",
    analogy: "A junction drawer set into the curb, opened with a hand tool instead of an excavator.",
    atTheDoor:
      "Once the vault serving your address is live, connecting the house is a short, scheduled job rather than a construction project.",
  },
  {
    step: 5,
    title: "The drop to the house",
    what:
      "On install day a drop line is run from the vault to the home and buried shallow or routed along the edge of the property. It serves that one address and nothing else.",
    analogy: "Your own driveway getting paved off the road the crew already built.",
    atTheDoor:
      "The last piece is your own line from the curb, put in on install day, used by your house alone.",
  },
  {
    step: 6,
    title: "The ONT on the wall",
    what:
      "The glass ends at a small box on the wall inside or outside the home. The ONT turns light into a normal network signal, the router takes it from there, and the street construction becomes WiFi.",
    analogy: "The translator at the border between the glass outside and the house inside.",
    atTheDoor:
      "From the customer's side the whole build ends at one quiet box on the wall, and everything after that is ordinary home networking.",
  },
];
