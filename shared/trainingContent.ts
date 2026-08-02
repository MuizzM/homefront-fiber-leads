// ── D2D Training Curriculum ───────────────────────────────────────────────────
// The full door-to-door psychology + pitch curriculum, authored as typed data so
// the client renders it, the server validates progress against it, and tests pin
// its integrity (unique ids, valid quiz answers, no emoji). Written for fiber
// internet field reps: tight, second person, field-ready. Content is the single
// source of truth for lesson ids — the progress API rejects ids not in this file.

export type TrainingQuizQuestion = {
  question: string;
  options: string[];
  /** Index into options — pinned valid by tests/unit/training-content.test.ts. */
  answerIndex: number;
  /** Shown after the rep answers, right or wrong — the teach-back moment. */
  explanation: string;
};

export type TrainingSection = {
  heading: string;
  /** Each string renders as one paragraph. */
  body: string[];
};

/** A memorable "say this, not that" swap. Additive engagement element —
 *  optional, so old renderers and progress storage are unaffected. */
export type TrainingSayThisNotThat = {
  /** The dead, scripted line reps reach for by reflex. */
  instead: string;
  /** The line that actually lands at the door. */
  say: string;
};

export type TrainingLesson = {
  /** Stable id — stored in training_progress.lesson_id. Never rename. */
  id: string;
  title: string;
  /** One line under the title in the lesson list. */
  summary: string;
  /** Honest read-time estimate for the list view. */
  minutes: number;
  sections: TrainingSection[];
  keyTakeaways: string[];
  /** "Try this on your next 10 doors" card. */
  drillPrompt: string;
  quiz: TrainingQuizQuestion[];
  /** Spoken-pitch rehearsal script for the Pitch Recorder — present only on
   *  lessons where a rep practices a pitch out loud (openers, the skeleton,
   *  closes, situational pitches). Additive, optional, back-compatible. */
  pitchDrill?: string;
};

export type TrainingModule = {
  id: string;
  title: string;
  tagline: string;
  lessons: TrainingLesson[];
  /** Punchy one-liner that sets the module's energy — shown above the calmer
   *  tagline. Additive engagement element, optional. */
  hook?: string;
  /** Real-talk callout: a vivid 2-3 sentence scenario a rep will recognize the
   *  moment they read it. Additive engagement element, optional. */
  fieldStory?: string;
  /** One memorable say-this-not-that swap for the module, where useful. */
  sayThisNotThat?: TrainingSayThisNotThat;
};

/** One step of the "Get ready for doors in 15 minutes" fast-start track. It
 *  references an existing lesson by id — no content is duplicated here. */
export type FastStartStep = {
  /** Must be a real id in TRAINING_LESSONS (pinned by tests). */
  lessonId: string;
  /** One line on why this lesson is door-critical — derived guidance, not a
   *  copy of the lesson body. */
  why: string;
};

export const TRAINING_MODULES: TrainingModule[] = [
  // ── M1 — The Door Mindset ───────────────────────────────────────────────────
  {
    id: "m1",
    title: "The Door Mindset",
    tagline: "Rejection math, identity, and the habits that keep you knocking.",
    hook: "Every no is already paid for. Learn to hear it that way.",
    fieldStory:
      "Two reps knock the same street. One gets a slammed door at house six and knocks the next four like a whipped dog — no sales. The other logs the no, exhales on the walk, and knocks house seven exactly like house one. Same doors, same weather, same script. One of them just does the math, and the math does not flinch.",
    sayThisNotThat: {
      instead: "Sorry to bother you, do you have a quick second?",
      say: "I handle the fiber build on this street — thirty seconds and I'm gone either way.",
    },
    lessons: [
      {
        id: "m1-rejection-math",
        title: "Rejection math: the numbers behind every door",
        summary: "Why every no has a dollar value, and how top reps think in expected value.",
        minutes: 5,
        sections: [
          {
            heading: "Every door has a price on it",
            body: [
              "Door-knocking is a numbers game with knowable numbers. Suppose you close one sale per 40 doors and a sale pays you 200 dollars. That means every door you knock is worth 5 dollars to you on average, whether it ends in a sale, a no, or an empty porch. The no at door 12 is not a failure. It is a 5-dollar unit of work, completed.",
              "This is expected value, and it is the single most protective idea in this job. Reps who quit early quit because they price doors emotionally: a slammed door feels like it cost them something. Reps who last price doors mathematically: a slammed door just paid them, and the next one pays the same.",
            ],
          },
          {
            heading: "Know your own numbers",
            body: [
              "Generic averages are a starting point. Your numbers are the real asset. Track doors knocked, conversations held, and sales closed for two weeks and you will know your personal doors-per-sale figure. Once you know it, a slow afternoon stops being discouraging and becomes arithmetic: eleven doors down, twenty-nine to go.",
              "Your numbers also tell you where to improve. If you need 60 doors per sale and a teammate needs 35, the gap lives somewhere specific: your opener, your pitch, or your close. The math turns a vague feeling of being worse into a fixable stage of the funnel.",
            ],
          },
          {
            heading: "The no is the job",
            body: [
              "You are not paid to avoid rejection. You are paid to collect decisions, and most decisions in this business are no. A rep who hears no forty times a day and stays even-keeled will out-earn a naturally charming rep who folds after five. Treat the volume of no as proof you are doing the work, because it is.",
            ],
          },
        ],
        keyTakeaways: [
          "Expected value per door = commission per sale divided by doors per sale. Know your number.",
          "A no is a completed unit of paid work, not a loss.",
          "Track doors, conversations, and sales for two weeks to find your real doors-per-sale.",
          "Funnel math tells you exactly which skill to fix; feelings do not.",
        ],
        drillPrompt:
          "On your next 10 doors, say your per-door dollar value out loud before you knock. After each no, log it and move on within 10 seconds. Notice how the number changes what a slammed door feels like.",
        quiz: [
          {
            question: "You close 1 sale per 50 doors and earn 250 dollars per sale. What is each door worth on average?",
            options: ["50 cents", "5 dollars", "10 dollars", "250 dollars only if it converts"],
            answerIndex: 1,
            explanation: "250 divided by 50 is 5 dollars per door. Every knock earns that expected value regardless of outcome.",
          },
          {
            question: "What is the healthiest way to interpret a rude rejection at door 12?",
            options: [
              "Evidence the neighborhood is bad and you should relocate",
              "A signal to take a long break and reset",
              "One completed unit of work that carried your average per-door value",
              "Proof your pitch is broken",
            ],
            answerIndex: 2,
            explanation: "One rude no is noise. It carried the same expected value as any other door. Patterns across many doors are data; single doors are not.",
          },
          {
            question: "Your doors-per-sale is much worse than a teammate's. What does rejection math suggest you do first?",
            options: [
              "Knock more hours to compensate",
              "Compare funnel stages to find where you lose people, then fix that stage",
              "Copy their territory",
              "Assume they are lucky and keep going",
            ],
            answerIndex: 1,
            explanation: "The funnel isolates the problem: opener, pitch, or close. Fixing the leaking stage beats brute-forcing volume.",
          },
        ],
      },
      {
        id: "m1-identity-frames",
        title: "Identity frames: who is knocking this door",
        summary: "Confidence is a decision about your role, made before you step on the porch.",
        minutes: 5,
        sections: [
          {
            heading: "The frame decides the interaction",
            body: [
              "Homeowners read your self-image in the first two seconds, before you say a word. If you arrive as someone interrupting their evening to take something, they feel it and resist. If you arrive as the local fiber consultant who handles this street, they feel that instead. Same words, different frame, different door.",
              "The frame is not acting. Fiber genuinely saves most households money and fixes real problems. You have information about a buried infrastructure upgrade on their street that they probably do not have. Walking a neighborhood telling people about it is a legitimate, useful role. Believe that plainly and the porch behaves differently.",
            ],
          },
          {
            heading: "Helper, not hunter",
            body: [
              "Reps burn out when their identity is closer. Every no attacks a closer's identity. Anchor instead on helper with a quota of conversations: your job today is to have 15 real conversations about internet service. Sales are the byproduct. This frame survives rejection because a no does not stop you from having done your job.",
              "It also changes your behavior at the door. Hunters push past disinterest and create complaints. Helpers qualify, give the useful fact, and leave the porch better than they found it, which is exactly what makes the callback and the referral possible.",
            ],
          },
          {
            heading: "Borrowed authority is real authority",
            body: [
              "You represent the company bringing fiber to that street. You are allowed to speak with the calm of the whole operation behind you: the install crews, the network, the neighbors already connected. When you say we just finished installs on the next street over, you are not bragging. You are reporting. Speak like a representative, not an applicant.",
            ],
          },
        ],
        keyTakeaways: [
          "Homeowners mirror your frame: arrive as the street's fiber consultant, not an interrupter.",
          "Anchor identity on conversations held, not sales closed — that identity survives rejection.",
          "Helpers outperform hunters over a season because they earn callbacks and referrals.",
          "Speak with the authority of the operation you represent.",
        ],
        drillPrompt:
          "Before each of your next 10 doors, state your role in one sentence: I handle fiber for this street. Then knock. Track whether your first three seconds at the door feel different by door 10.",
        quiz: [
          {
            question: "Why does the helper frame hold up better than the closer frame across a long day?",
            options: [
              "Helpers do not have sales targets",
              "A no does not negate a conversation, so the day's identity goal stays achievable",
              "Homeowners tip helpers",
              "Closers talk too fast",
            ],
            answerIndex: 1,
            explanation: "If your job is 15 real conversations, rejection cannot make you fail at it. Identity that rejection cannot attack is identity that lasts.",
          },
          {
            question: "What is the honest basis for confidence at a fiber door?",
            options: [
              "Pretending to be more senior than you are",
              "You hold genuinely useful information about an infrastructure upgrade on their street",
              "Most homeowners will not check claims",
              "Confidence needs no basis",
            ],
            answerIndex: 1,
            explanation: "The frame works because it is true: fiber on their street is real, relevant news, and you are the person who knows the details.",
          },
          {
            question: "A rep says 'sorry to bother you' three times per door. What is the likely root cause?",
            options: [
              "Politeness training",
              "An interrupter self-frame the homeowner will mirror back as resistance",
              "A scripting error",
              "Talking to too many analytical customers",
            ],
            answerIndex: 1,
            explanation: "Serial apology signals you believe you are an imposition. Homeowners accept the frame you offer them.",
          },
        ],
      },
      {
        id: "m1-activity-goals",
        title: "Activity goals beat outcome goals",
        summary: "Control what you can control: doors, conversations, and asks.",
        minutes: 4,
        sections: [
          {
            heading: "You cannot will a sale into existence",
            body: [
              "Two sales today is not a goal you control. Whether a given homeowner buys depends on their contract, their mood, and who answers the door. Eighty doors, 15 conversations, and 5 full pitches is a goal you control completely. Set goals only over what your legs and mouth can guarantee, and let the closes fall out of the math.",
              "Outcome goals also corrupt behavior late in the day. A rep chasing two sales who has zero at 6 p.m. starts pressing: overtalking, discounting, arguing with objections. A rep chasing 80 doors just keeps knocking with the same calm process, which is exactly the state that closes deals.",
            ],
          },
          {
            heading: "The daily scoreboard",
            body: [
              "Pick three activity numbers and track them every shift: doors knocked, real conversations (a real exchange, not a wave-off), and complete pitches delivered. Review them against sales weekly, not daily. Daily sales are noisy; weekly ratios are signal. When a week dips, the scoreboard shows whether you had an effort problem (doors down) or a skill problem (ratios down), and those have different fixes.",
            ],
          },
          {
            heading: "Streaks and minimums",
            body: [
              "Set a floor, not just a target: no shift ends before 50 doors, no exceptions for weather or mood. Floors protect you from the compounding cost of quitting early, because skipped doors do not just cost today's expected value — they erode the habit that produces every future paycheck. Keep the streak alive and the streak keeps you alive.",
            ],
          },
        ],
        keyTakeaways: [
          "Set goals only over what you control: doors, conversations, pitches.",
          "Outcome-chasing late in the day produces pressing, and pressing kills closes.",
          "Review activity-to-sale ratios weekly; daily sales are noise.",
          "A non-negotiable daily door floor protects the habit that pays you.",
        ],
        drillPrompt:
          "For your next 10 doors, score yourself only on process: did you knock, open, and ask? Give yourself a point per completed step and total it at the end. Ignore outcomes entirely for this set.",
        quiz: [
          {
            question: "Which of these is a well-formed daily goal?",
            options: [
              "Close two sales",
              "Deliver five complete pitches",
              "Have a great day",
              "Beat yesterday's revenue",
            ],
            answerIndex: 1,
            explanation: "Five complete pitches is fully within your control. Sales and revenue depend on factors you cannot command.",
          },
          {
            question: "It is 6 p.m., you have zero sales, and you feel yourself starting to push harder at each door. What does this lesson prescribe?",
            options: [
              "Push harder — urgency closes deals",
              "Return to the activity goal and run the same calm process on the remaining doors",
              "Stop for the day to avoid burning doors",
              "Offer discounts to force a close",
            ],
            answerIndex: 1,
            explanation: "Pressing is the symptom of outcome-chasing. The calm, repeatable process is what actually converts, so return to it.",
          },
          {
            question: "Why review ratios weekly instead of daily?",
            options: [
              "Weekly reviews take less time",
              "Managers only ask weekly",
              "Daily sales are statistically noisy; weekly ratios reveal real skill or effort changes",
              "Ratios cannot be computed daily",
            ],
            answerIndex: 2,
            explanation: "With one or two sales a day, a zero day says almost nothing. Across a week, the ratios separate effort problems from skill problems.",
          },
        ],
      },
      {
        id: "m1-reset-ritual",
        title: "The reset ritual between doors",
        summary: "A 20-second routine that stops one bad door from costing you the next five.",
        minutes: 4,
        sections: [
          {
            heading: "Emotional residue is the silent killer",
            body: [
              "The most expensive door of your day is the one after a bad one. Carry frustration from a rude no onto the next porch and the next homeowner meets a tense, flat version of you — and passes. One bad interaction quietly converts into three or four weak ones unless you cut the chain. That is what a reset ritual is for.",
            ],
          },
          {
            heading: "Build a physical reset",
            body: [
              "The reset must be physical, not just mental, because your body carries the tension. A proven sequence for the walk between doors: exhale hard and drop your shoulders, say a closing phrase that files the last door (that one's done), state the next micro-intention (next door: smile, slow opener), and square your posture on the last three steps of the driveway. Twenty seconds, every door, good or bad.",
              "Run it after wins too. Excitement distorts the next door just like anger does — a rep riding a sale tends to rush the next opener and skip qualifying. The ritual returns you to neutral, and neutral is where your trained skills live.",
            ],
          },
          {
            heading: "The 10-door circuit breaker",
            body: [
              "Some stretches are genuinely brutal. If three doors in a row leave you rattled, take a two-minute circuit breaker: walk one lap, drink water, check your activity scoreboard to see the math still working, then resume. Two minutes spent resetting beats twenty doors knocked in a defeated tone.",
            ],
          },
        ],
        keyTakeaways: [
          "A bad door taxes the next several doors unless you deliberately reset.",
          "Make the reset physical: exhale, shoulders down, closing phrase, next-door intention.",
          "Reset after wins too — excitement distorts as much as anger.",
          "Use a two-minute circuit breaker after any three-door rough patch.",
        ],
        drillPrompt:
          "Run the full 20-second reset between every one of your next 10 doors: exhale, shoulders, closing phrase, intention. No exceptions, including after good doors. Note at door 10 whether your energy is flatter or steadier than usual.",
        quiz: [
          {
            question: "Why is the door immediately after a rude rejection statistically dangerous?",
            options: [
              "Homeowners talk to their neighbors instantly",
              "You carry visible residue that flattens your opener and the homeowner mirrors it",
              "Rejections cluster geographically",
              "It is not dangerous — doors are independent",
            ],
            answerIndex: 1,
            explanation: "Doors are independent, but you are not. Un-reset frustration changes your tone and posture, and the next homeowner responds to what shows up.",
          },
          {
            question: "Why should the reset ritual run after a sale as well?",
            options: [
              "To avoid jinxing the sale",
              "Excitement also distorts the next interaction — rushing, skipping qualification",
              "Managers require it",
              "It should not run after sales",
            ],
            answerIndex: 1,
            explanation: "The goal is neutral, not happy. Your trained process executes best from neutral, and both anger and adrenaline pull you away from it.",
          },
          {
            question: "What makes a reset ritual actually work?",
            options: [
              "Making it purely mental so it is fast",
              "Involving the body — breath and posture — because tension is physical",
              "Doing it only when you notice you are upset",
              "Keeping it under five seconds",
            ],
            answerIndex: 1,
            explanation: "Tension lives in shoulders, jaw, and breath. A physical sequence clears what a mental note cannot, and running it every door means it is there when you need it.",
          },
        ],
      },
    ],
  },

  // ── M2 — The First Seven Seconds ────────────────────────────────────────────
  {
    id: "m2",
    title: "The First Seven Seconds",
    tagline: "Approach, opener, and tone — the window where doors are won or lost.",
    hook: "The homeowner decides in seven seconds. Give them the right seven.",
    fieldStory:
      "You knock, and before you say a word the homeowner's face is already halfway to no — arms crossing, weight shifting back. That is not about your offer. That is the salesperson-at-my-door reflex firing on schedule, and it fires for every rep on the street. Your whole job in the first seven seconds is to not look like the person that reflex is built for.",
    sayThisNotThat: {
      instead: "Hi! How are you doing today?",
      say: "You've seen the crews on the road up here — I'm with the fiber build, that's what the flags are about.",
    },
    lessons: [
      {
        id: "m2-approach",
        title: "Approach body language",
        summary: "Angle, distance, and hands: how to look safe before you look persuasive.",
        minutes: 5,
        sections: [
          {
            heading: "The homeowner's first question is not about internet",
            body: [
              "Before a homeowner processes a single word, their brain answers one question: is this person a threat? Everything about your approach should answer no. Until that question is settled, nothing you say lands, because they are not listening — they are assessing.",
            ],
          },
          {
            heading: "Angle and distance",
            body: [
              "After you knock, step back off the doormat — two to three feet from the threshold — and stand at a 45-degree angle to the door rather than square to it. Facing a door head-on reads as confrontation; the angle reads as someone mid-visit, relaxed, on their way through. Standing back also lets them open the door fully instead of guarding a six-inch gap.",
              "On the approach itself, walk the path, not the lawn, at a normal unhurried pace. A rep who hurries looks like pressure; a rep who creeps looks like trouble. Aim for the gait of someone who has done this all day and is fine either way.",
            ],
          },
          {
            heading: "Hands, badge, and props",
            body: [
              "Keep both hands visible at all times — never in pockets, never behind your back. Hold your tablet or door literature low and in one hand, at your side or waist level, not clutched to your chest like a shield or raised like a clipboard ambush. Wear your badge where it can be read without you touching it.",
              "Look at the door, not into windows, while you wait. Take one small step back as the door opens. That single step is the highest-value body-language move at the door: it visibly hands control of the space to the homeowner right at the moment they are deciding whether to engage.",
            ],
          },
        ],
        keyTakeaways: [
          "The first evaluation is threat assessment — win that before persuading anyone.",
          "Stand two to three feet back, angled 45 degrees, never square to the door.",
          "Both hands visible, materials held low, badge readable.",
          "Step back as the door opens — it hands the homeowner control of the space.",
        ],
        drillPrompt:
          "On your next 10 doors, run a three-point check while you wait after knocking: feet angled, hands visible, one step back ready. Rate yourself out of three on each door and get to ten out of ten by the last three doors.",
        quiz: [
          {
            question: "Why stand at a 45-degree angle instead of facing the door directly?",
            options: [
              "It looks more casual in photographs",
              "A square stance reads as confrontation; an angle reads as relaxed and passing through",
              "It hides your tablet",
              "It helps you hear inside the house",
            ],
            answerIndex: 1,
            explanation: "Head-on positioning triggers the same read as someone blocking a path. The angle defuses the threat assessment before words start.",
          },
          {
            question: "What is the single most valuable movement at the moment the door opens?",
            options: [
              "Extending your hand for a handshake",
              "Raising your tablet to show the offer",
              "A small step backward",
              "Leaning in to be heard",
            ],
            answerIndex: 2,
            explanation: "The step back gives the homeowner the space, visibly, at the exact moment they are judging whether to engage. It lowers guard faster than any sentence.",
          },
          {
            question: "How should you hold your tablet or literature during the approach?",
            options: [
              "Against your chest so it is safe",
              "Raised and ready to present",
              "Low, in one hand, at your side or waist",
              "Behind your back until needed",
            ],
            answerIndex: 2,
            explanation: "Held low it is a tool; clutched or raised it becomes either a shield or an ambush cue. Behind your back hides a hand, which fails the threat check.",
          },
        ],
      },
      {
        id: "m2-pattern-interrupt",
        title: "The pattern interrupt opener",
        summary: "Break the salesperson script in your first sentence, or be dismissed by reflex.",
        minutes: 5,
        sections: [
          {
            heading: "The homeowner has a script for you",
            body: [
              "Every adult has rehearsed the doorstep brush-off: not interested, thanks, door closes. It runs on autopilot the instant you match the pattern they expect — bright greeting, company name, how are you today. A pattern interrupt is any opener that does not match that template, forcing an extra second of actual attention. That second is all you need.",
            ],
          },
          {
            heading: "Openers that break the script",
            body: [
              "Lead with the reason you are on their street, stated like a neighbor would: You have probably seen the crews on the road up here — I am with the fiber build, just letting folks know what the flags and digging are about. No pitch in the first breath. You are explaining a thing they have already noticed, which makes you the answer to an existing question instead of a new demand.",
              "Honest disarmament also interrupts: I will be straight with you — I am a salesperson, and I will be quick. Naming the thing they were about to accuse you of removes the accusation. Pair it with a real time cap: Thirty seconds and then I am gone either way — say it and honor it.",
            ],
          },
          {
            heading: "What kills the interrupt",
            body: [
              "Do not follow a good interrupt with the corporate script. If your second sentence is a rehearsed features monologue, the brush-off resumes with double force because now you also broke trust. The interrupt buys one genuine question or one relevant fact — spend it on their street, their bill, or their current provider, not on your product sheet.",
              "And never fake the interrupt. Do not pretend to be a utility inspector, imply you are from their current provider, or invent an appointment. It works once and costs you the neighborhood.",
            ],
          },
        ],
        keyTakeaways: [
          "Homeowners run an automatic brush-off script triggered by salesperson patterns.",
          "Open with the street-level reason you are there, like a neighbor explaining the crews.",
          "Honest disarmament plus a real time cap breaks the pattern without tricks.",
          "Spend the attention you win on them, not on a product monologue.",
        ],
        drillPrompt:
          "Write one street-specific opener for the area you are knocking (name the visible construction, the recent installs, or the street itself). Use it word for word on your next 10 doors and count how many homeowners ask a question back.",
        pitchDrill:
          "Record your street-level opener as if the door just opened. Aim for a neighbor explaining the crews, not a salesperson starting a pitch: \"You've probably seen the crews on the road up here — I'm with the fiber build, just letting folks know what the flags and digging are about.\" Play it back and check one thing: did the last word land down, or did it lift up into a question?",
        quiz: [
          {
            question: "What does a pattern interrupt actually buy you?",
            options: [
              "A guaranteed pitch opportunity",
              "One extra second of genuine attention before the brush-off reflex fires",
              "The homeowner's trust for the whole conversation",
              "A callback appointment",
            ],
            answerIndex: 1,
            explanation: "The interrupt only suspends the autopilot briefly. What you do with that second — a relevant question or fact — determines everything after.",
          },
          {
            question: "Which opener best fits this lesson's guidance?",
            options: [
              "Hi! How are you today? I am with a company you are going to love",
              "You have seen the orange flags along the road? I am with the fiber build — that is what those are",
              "I was just speaking with your neighbor and they said you would be interested",
              "This is not a sales call",
            ],
            answerIndex: 1,
            explanation: "It explains something they already noticed, in neighbor language, with no pitch in the first breath. The others are either the classic script or dishonest framing.",
          },
          {
            question: "Why is faking authority (posing as a utility inspector) a bad interrupt even though it works?",
            options: [
              "It does not actually interrupt the pattern",
              "It takes too long to explain",
              "It burns trust across the whole neighborhood once discovered, and it is dishonest",
              "Inspectors are not allowed to knock",
            ],
            answerIndex: 2,
            explanation: "D2D lives on repeat passes, referrals, and reputation. A trick that works at one door poisons the street.",
          },
        ],
      },
      {
        id: "m2-tone",
        title: "Tone over words",
        summary: "The same sentence closes or kills depending on how it sounds.",
        minutes: 4,
        sections: [
          {
            heading: "They hear the music before the lyrics",
            body: [
              "In the first seconds, homeowners process your tone, pace, and volume far more than your vocabulary. A calm, downward-inflected sentence reads as a person with real information. The same sentence, rushed and pitched upward, reads as a person who needs something from them. Reps obsess over word choice; doors are decided by delivery.",
            ],
          },
          {
            heading: "Downswing beats upswing",
            body: [
              "End statements with a falling pitch. Upward inflection at the end of every line — the asking-permission sound — signals uncertainty, and uncertainty invites refusal. Practice your opener until the last word lands down. Questions can rise; statements must settle.",
              "Slow down about 20 percent from your instinct. Nervous reps rush, and rushing sounds like the wind-up to a trick. A measured pace with small pauses says you are comfortable, and comfortable is contagious.",
            ],
          },
          {
            heading: "Match, then lead",
            body: [
              "Open at roughly the homeowner's energy, then guide. If they answer the door quiet and wary, a booming greeting blows them backward; start softer, then warm up together. If they open big and friendly, flat calm reads as cold. Meet them where they are for the first two lines, then lead the exchange toward relaxed and unhurried — the state where decisions happen.",
            ],
          },
        ],
        keyTakeaways: [
          "Delivery decides the first seconds; vocabulary barely registers.",
          "End statements with falling pitch — the upswing sound invites refusal.",
          "Speak about 20 percent slower than your nervous instinct.",
          "Match the homeowner's energy first, then lead it toward calm.",
        ],
        drillPrompt:
          "Record your opener on your phone before your shift. Listen for upswing on the last word and re-record until it lands down. Then, on your next 10 doors, consciously match each homeowner's opening energy before saying line two.",
        quiz: [
          {
            question: "What does habitual upward inflection at the end of statements communicate?",
            options: [
              "Friendliness",
              "Enthusiasm for the product",
              "Uncertainty and permission-seeking, which invites refusal",
              "Regional accent",
            ],
            answerIndex: 2,
            explanation: "The rising end turns statements into requests for approval. Homeowners refuse requests reflexively; they accept information delivered with settled confidence.",
          },
          {
            question: "A homeowner opens the door quiet and guarded. What is the right energy move?",
            options: [
              "Come in loud and warm to lift them",
              "Start near their level, then gradually lead toward relaxed",
              "Stay silent until they speak",
              "Mirror them exactly for the whole conversation",
            ],
            answerIndex: 1,
            explanation: "Matching first prevents the mismatch shock; leading second moves the exchange somewhere useful. Pure mirroring never gets to calm; pure projection blows them back.",
          },
          {
            question: "Why does deliberately slowing down improve door outcomes?",
            options: [
              "It gives you time to remember the script",
              "Rushed speech patterns read as the setup to a trick; measured pace reads as comfort and legitimacy",
              "Homeowners have trouble hearing",
              "It extends the conversation length metric",
            ],
            answerIndex: 1,
            explanation: "Pace is a trust signal. People with real information and nothing to hide do not sprint through it.",
          },
        ],
      },
      {
        id: "m2-energy-name",
        title: "Energy calibration and the name exchange",
        summary: "Real smiles, right-sized energy, and the two-second move that makes you a person.",
        minutes: 4,
        sections: [
          {
            heading: "Smile like you mean it, because you can",
            body: [
              "A forced grin reads instantly as fake and pushes the salesperson pattern you are trying to break. The workable alternative is a genuine low-grade warmth: think of the last door that went well as you walk up, and let that sit on your face. Aim for pleasant and unhurried, not thrilled. Nobody legitimate is thrilled to be on a porch.",
              "Energy should sit slightly above the homeowner's, never double it. High energy against a tired homeowner does not lift them; it exhausts them and shortens the door.",
            ],
          },
          {
            heading: "The name exchange",
            body: [
              "Give your first name early and unprompted — I'm Marcus, by the way — because named people are harder to dismiss than roles. Then ask theirs, and use it once soon after, naturally. Once is warm; three times in a minute is a technique they can smell.",
              "If they do not offer a name, do not push. The offer itself did its work: you presented as a person. When they do give it, that is a small yes — the first deposit in a chain of small agreements that ends at the close.",
            ],
          },
        ],
        keyTakeaways: [
          "Genuine low-grade warmth beats a performed grin every time.",
          "Set your energy slightly above the homeowner's — never double it.",
          "Offer your first name early; a named person is harder to brush off than a role.",
          "Use their name once, naturally. Repetition reads as a technique.",
        ],
        drillPrompt:
          "On your next 10 doors, offer your first name within the first three sentences at every door and ask for theirs at any door that engages. Track how many names you collect — five or more out of ten means the exchange is landing.",
        quiz: [
          {
            question: "What is the right target energy at a door?",
            options: [
              "Maximum enthusiasm at every door",
              "Flat and neutral to seem professional",
              "Slightly above the homeowner's energy",
              "Exactly matched to theirs forever",
            ],
            answerIndex: 2,
            explanation: "Slightly above lifts the exchange without overwhelming it. Doubling a tired homeowner's energy reads as manic; flat reads as disinterest.",
          },
          {
            question: "Why does giving your first name early change the interaction?",
            options: [
              "It is required by solicitation permits",
              "It converts you from a dismissible role into a person, and people get more courtesy",
              "It makes them remember the brand",
              "It does not — names are small talk",
            ],
            answerIndex: 1,
            explanation: "Brush-offs are aimed at the salesperson category. A name pulls you out of the category, and the reciprocated name is the door's first small yes.",
          },
          {
            question: "The homeowner gives you their name. How often should you use it?",
            options: [
              "Every sentence, to build rapport fast",
              "Once, soon after, naturally",
              "Never — using names is manipulative",
              "Only at the close",
            ],
            answerIndex: 1,
            explanation: "One natural use signals attention. Repeated use is a recognizable sales technique and reverses the trust it was meant to build.",
          },
        ],
      },
    ],
  },

  // ── M3 — The Pitch That Lands ───────────────────────────────────────────────
  {
    id: "m3",
    title: "The Pitch That Lands",
    tagline: "Problem-first framing, the 30-second skeleton, and numbers that stick.",
    hook: "Nobody buys internet. They fire the one they've got. Start with the pain.",
    fieldStory:
      "A rep leads with speeds and features and watches the homeowner glaze over in four seconds flat. Next door, a rep asks one question — did your bill do the jump after the first year? — and the homeowner talks for a minute straight about the forty dollars that appeared out of nowhere. Same product, same street. One rep pitched. The other let the homeowner sell themselves.",
    sayThisNotThat: {
      instead: "We offer blazing-fast symmetrical gigabit fiber with no data caps.",
      say: "Evenings, when everyone's on it at once — does it hold up, or does it start dragging?",
    },
    lessons: [
      {
        id: "m3-problem-first",
        title: "Problem-first framing",
        summary: "Sell the pain of the current bill and buffering before you mention fiber.",
        minutes: 5,
        sections: [
          {
            heading: "Nobody buys internet; they fire their current internet",
            body: [
              "A homeowner who feels fine about their service will not switch for a better product, but a homeowner reminded of a specific pain will listen to almost anything that ends it. Your pitch therefore starts with their problem, not your product. Two pains carry this industry: the bill that crept up (bill pain) and the connection that fails when the household needs it (speed pain).",
            ],
          },
          {
            heading: "Surface the pain with questions, not claims",
            body: [
              "Telling a homeowner their internet is bad triggers defense — they picked it. Asking does not: Out of curiosity, what is the bill running these days — did yours do the thing where it jumps after the first year? Or: Evenings, when everyone is on it at once — does it hold up? Their own answer does the selling. A pain they name out loud is ten times heavier than a pain you assert.",
              "Then sit in it for one beat before pitching. Yeah, that jump after the promo period is the standard move. A moment of agreement proves you listened, and it makes the pivot to fiber feel like an answer instead of an ambush.",
            ],
          },
          {
            heading: "Map the pain to the fix",
            body: [
              "Bill pain maps to flat, promotional-game-free pricing. Speed pain maps to fiber's symmetrical bandwidth and evening stability — no shared neighborhood bottleneck at 7 p.m. Match the fix to the pain they voiced, and only that pain. A rep who answers bill pain with a speed monologue has stopped listening, and the homeowner notices immediately.",
            ],
          },
        ],
        keyTakeaways: [
          "Switching is firing the current provider — the pitch starts at their pain, not your product.",
          "Ask questions that let them name the pain; a self-named pain outweighs any claim.",
          "Hold one beat of agreement before pivoting to the fix.",
          "Answer the pain they actually voiced: bill pain gets pricing, speed pain gets stability.",
        ],
        drillPrompt:
          "On your next 10 doors, do not mention fiber until the homeowner has answered one pain question about their bill or their evening speeds. Count how many doors reach a named pain — that number is your real pitch count.",
        pitchDrill:
          "Record your two pain-finding questions back to back, the way you'd actually ask them on a porch: \"Out of curiosity, what's the bill running these days — did yours do the thing where it jumps after the first year?\" and \"Evenings, when everyone's on it at once — does it hold up?\" Listen back for tone. Do they sound curious and easy, or like a form you're reading? Re-record until they sound like a neighbor wondering out loud.",
        quiz: [
          {
            question: "Why does asking about the bill beat stating that their bill is probably too high?",
            options: [
              "Questions are more polite",
              "A pain the homeowner names themselves carries far more weight and triggers no defense of their past choice",
              "It gathers data for the CRM",
              "Statements are legally riskier",
            ],
            answerIndex: 1,
            explanation: "Assertions attack their earlier decision and get defended. Their own answer is testimony — nobody argues with their own words.",
          },
          {
            question: "The homeowner says the bill jumped 40 dollars after the promo ended. What is the correct next move?",
            options: [
              "Immediately present fiber speeds",
              "One beat of agreement about the promo-jump pattern, then map to flat pricing",
              "Ask a second question about streaming quality",
              "Offer to review their bill line by line",
            ],
            answerIndex: 1,
            explanation: "Agree first — it proves you listened. Then answer the exact pain they named: pricing. Pivoting to speed answers a question they did not ask.",
          },
          {
            question: "What are the two pains that drive most fiber switches?",
            options: [
              "Contract length and installation fees",
              "Bill creep and unreliable speeds under household load",
              "Customer service wait times and equipment rental",
              "Data caps and streaming quality",
            ],
            answerIndex: 1,
            explanation: "The rising bill and the connection that folds when the whole house is online are the pains nearly every door recognizes instantly.",
          },
        ],
      },
      {
        id: "m3-pitch-skeleton",
        title: "The 30-second fiber pitch skeleton",
        summary: "Hook, credibility, value, micro-commitment — in that order, in half a minute.",
        minutes: 6,
        sections: [
          {
            heading: "Why 30 seconds",
            body: [
              "The homeowner granted you a short window, and honoring it is itself persuasive. The pitch skeleton has four beats: hook, credibility, value, micro-commitment. Learn the beats, not a word-for-word script — the beats survive interruptions, and doors are made of interruptions.",
            ],
          },
          {
            heading: "The four beats",
            body: [
              "Hook (about 5 seconds): tie yourself to something real and local. They are running the fiber line down this street right now — that is the digging you have seen. Credibility (about 5 seconds): make it concrete and checkable. We connected six houses on Maple last week; your neighbor at the corner is already on it. Value (about 15 seconds): one pain, one fix, one number. Most folks here are cutting the bill by about 30 a month and getting speeds that do not sag at night. Micro-commitment (about 5 seconds): the smallest possible yes. Worth checking if your address qualifies? Takes about a minute.",
              "The micro-commitment is the engine. You are not asking them to buy — you are asking permission for a one-minute address check. Small yeses compound: address check, then seeing the price, then picking an install window. Each step is easy because the previous one was.",
            ],
          },
          {
            heading: "Keep it modular",
            body: [
              "If they interrupt at the hook with a question, answer it and skip ahead — the beats are a checklist, not a monologue. If they show price interest at beat two, jump straight to value and the check. The worst version of this pitch is the rep who returns to the top of the script after every interruption. Track where you are, not what line you are on.",
            ],
          },
        ],
        keyTakeaways: [
          "Four beats: hook (local), credibility (checkable), value (one pain, one fix, one number), micro-commitment.",
          "Ask for the smallest yes — a one-minute address check, never the sale itself.",
          "Learn beats, not lines: the structure must survive interruptions.",
          "Jump beats forward when the homeowner shows interest; never restart the script.",
        ],
        drillPrompt:
          "Write your four beats as four short lines on a card. On your next 10 doors, deliver all four beats in under 40 seconds wherever a door engages, and end every pitch with the address-check question. Count completed skeletons.",
        pitchDrill:
          "This is the big one — record the full 30-second skeleton and time it. Hit all four beats: hook (\"they're running the fiber line down this street right now\"), credibility (\"we connected six houses on Maple last week — your neighbor at the corner is already on it\"), value (\"most folks here are cutting the bill about 30 a month and getting speeds that don't sag at night\"), and the micro-commitment (\"worth checking if your address qualifies? Takes about a minute\"). Play it back with a stopwatch. Under 40 seconds, all four beats present, and it ends on the small ask — not the sale.",
        quiz: [
          {
            question: "What is the correct micro-commitment at the end of the 30-second pitch?",
            options: [
              "Signing up for installation",
              "A one-minute address qualification check",
              "Scheduling a manager visit",
              "Taking a brochure",
            ],
            answerIndex: 1,
            explanation: "The address check is nearly free to say yes to, and each small yes makes the next step natural. Asking for the sale at 30 seconds skips the ladder.",
          },
          {
            question: "The homeowner interrupts your hook to ask what it costs. What do you do?",
            options: [
              "Ask them to hold questions until the end",
              "Restart the pitch so they get full context",
              "Answer with the value beat — one number — and move to the address check",
              "Deflect until you have built more credibility",
            ],
            answerIndex: 2,
            explanation: "A price question is interest. Jump to the beat that answers it and advance. Returning to the script top is how interested doors get bored.",
          },
          {
            question: "Which credibility line best fits the skeleton?",
            options: [
              "We are the fastest-growing provider in the country",
              "We connected six houses on Maple last week — the corner house is already running on it",
              "Our company has won multiple industry awards",
              "Everyone is switching to us",
            ],
            answerIndex: 1,
            explanation: "Credibility must be concrete, local, and checkable from their porch. National claims are wallpaper; the corner house is evidence.",
          },
        ],
      },
      {
        id: "m3-social-proof",
        title: "Localized social proof",
        summary: "Your neighbors on this street are the only testimonial that matters.",
        minutes: 4,
        sections: [
          {
            heading: "Proof shrinks with distance",
            body: [
              "A million customers nationwide moves nobody. Three houses on this street moves almost everybody. Humans weigh evidence by social distance: what people like me, near me, chose. Every install, every yard sign, every completed address check in the neighborhood is ammunition — if you track it and name it.",
              "Be specific to the edge of what is true and appropriate: We did installs on Hawthorne and the two cul-de-sacs behind it this month. Name streets, counts, and timeframes. Never name a specific neighbor's decision without their permission — specificity about streets builds trust, specificity about people burns it.",
            ],
          },
          {
            heading: "Build proof as you knock",
            body: [
              "Social proof compounds within a single shift. Every address check you complete becomes tomorrow's line: We checked eight addresses on this loop yesterday. After each sale, ask the simple question: Mind if I mention to your neighbors that this block is coming online? Most say yes, and now your proof is both specific and permissioned.",
              "The herd effect is real at the block level: the third sale on a street is easier than the first, and the sixth is easier than the third. Work blocks in passes rather than scattering across the map, and reference the visible momentum each pass.",
            ],
          },
        ],
        keyTakeaways: [
          "Proof strength is inversely proportional to distance — this street beats this nation.",
          "Name streets, counts, and timeframes; never name neighbors without permission.",
          "Ask each new customer for permission to reference the block coming online.",
          "Work blocks in passes: each sale on a street lowers the price of the next.",
        ],
        drillPrompt:
          "Before your next 10 doors, write down every true, local proof point you have for that block: installs, checks, visible construction. Use at least one in every conversation and note which one gets the strongest reaction.",
        quiz: [
          {
            question: "Which line is the strongest social proof at a door?",
            options: [
              "Over a million households trust us nationwide",
              "We are rated highly online",
              "We connected four houses one street over this month",
              "Most people love fiber once they try it",
            ],
            answerIndex: 2,
            explanation: "Near, recent, and countable beats big and distant. The homeowner can literally see the street you named.",
          },
          {
            question: "What is the rule about naming neighbors?",
            options: [
              "Name them freely — it is public knowledge",
              "Name streets and counts freely, but individual neighbors only with their permission",
              "Never mention the neighborhood at all",
              "Only name neighbors who complained",
            ],
            answerIndex: 1,
            explanation: "Street-level specificity is trust-building; disclosing an individual's decision without asking is a privacy violation that travels fast on a block.",
          },
          {
            question: "Why work a block in concentrated passes instead of scattering widely?",
            options: [
              "Less walking between doors",
              "The block-level herd effect: each visible sale makes the next one on that street easier",
              "Managers can find you more easily",
              "It looks more professional",
            ],
            answerIndex: 1,
            explanation: "Adoption is contagious at close range. Concentrated work converts early sales into proof for the rest of the street while the momentum is visible.",
          },
        ],
      },
      {
        id: "m3-concrete-numbers",
        title: "Concrete-number talk tracks",
        summary: "Vague claims bounce off; specific numbers stick and get repeated.",
        minutes: 4,
        sections: [
          {
            heading: "The brain trusts specifics",
            body: [
              "Save money is noise; save about 32 dollars a month is information. Specific numbers signal that a real calculation happened, and they survive in memory — the homeowner will repeat your number to their spouse at dinner, which means your number pitches the second decision-maker without you. Every claim in your pitch should carry exactly one number.",
              "Round-but-not-too-round lands best: about 30 a month reads honest, 32.47 reads like a trick, huge savings reads like nothing at all.",
            ],
          },
          {
            heading: "Talk tracks that use numbers well",
            body: [
              "Bill track: Most cable bills around here are sitting between 85 and 110 after the promo drops off. Fiber runs 65, flat — no promo cliff, so it is 65 next year too. Speed track: Cable shares the line with the block — at 7 p.m. everyone's Netflix is fighting for the same pipe. Fiber is a dedicated line: the speed you buy is the speed you get at 7 p.m., upload included. Annualize savings for weight: 30 a month is 360 a year — that is a car payment.",
              "Two cautions. First, only use numbers you can stand behind — one wrong figure discovered later kills the deal and the referral. Second, cap it at one or two numbers per beat. A pitch that is all numbers becomes a spreadsheet, and nobody buys from a spreadsheet.",
            ],
          },
        ],
        keyTakeaways: [
          "One specific number per claim — specifics signal real calculation and stick in memory.",
          "Your number gets repeated to the spouse; it pitches the absent decision-maker for you.",
          "Annualize savings to add weight: 30 a month is 360 a year.",
          "Only numbers you can defend, and never more than two per beat.",
        ],
        drillPrompt:
          "Pick your three numbers before the shift: the local post-promo cable range, the fiber price, and the annualized savings. Use all three on your next 10 engaged doors and listen for which one the homeowner repeats back.",
        quiz: [
          {
            question: "Why do specific numbers outperform phrases like big savings?",
            options: [
              "They are shorter to say",
              "They signal a real calculation happened and remain repeatable in the homeowner's memory",
              "Homeowners are all analytical types",
              "They meet compliance requirements",
            ],
            answerIndex: 1,
            explanation: "Vague claims are categorized as sales noise and discarded. A concrete figure is information — evaluated, remembered, and repeated at the dinner table.",
          },
          {
            question: "Which savings framing carries the most weight?",
            options: [
              "You will save money every month",
              "You will save 32.47 per month",
              "About 30 a month — which is 360 a year",
              "Savings vary by household",
            ],
            answerIndex: 2,
            explanation: "Round-but-specific reads honest, and annualizing converts a coffee-sized number into a car-payment-sized one.",
          },
          {
            question: "What is the risk of stacking five numbers into one pitch beat?",
            options: [
              "No risk — more data builds more trust",
              "The pitch becomes a spreadsheet: cognitive load replaces persuasion and nothing sticks",
              "The homeowner may check your math",
              "It extends the pitch past 30 seconds",
            ],
            answerIndex: 1,
            explanation: "Numbers persuade in ones and twos. Beyond that they compete with each other and the homeowner retains none of them.",
          },
        ],
      },
    ],
  },

  // ── M4 — Reading People ─────────────────────────────────────────────────────
  {
    id: "m4",
    title: "Reading People",
    tagline: "Archetypes, buying signals, and the discipline of disqualifying fast.",
    hook: "The pitch is for their brain, not yours. Read it, then flex.",
    fieldStory:
      "An analytical rep buries a driver in fine print and loses a door a single sentence would have won. Two houses down, that same driver would have signed on the spot for bottom line: same speeds, thirty less, one-minute check. The facts never changed. The shape they came in did — and the rep who can't change shape leaves money on every third porch.",
    sayThisNotThat: {
      instead: "Let me walk you through all our plans and features first.",
      say: "Bottom line: same speeds, about thirty less a month, one-minute check — want it?",
    },
    lessons: [
      {
        id: "m4-archetypes",
        title: "The four quick-read archetypes",
        summary: "Analytical, driver, amiable, expressive — and how each one buys at a door.",
        minutes: 6,
        sections: [
          {
            heading: "Read the style in the first exchange",
            body: [
              "Within two sentences most homeowners show you one of four buying styles. Analyticals answer precisely and ask about numbers, terms, and fine print. Drivers are brisk, interrupt, and want the point. Amiables are warm, unhurried, agreeable — and slow to commit. Expressives are animated, personal, and story-driven. None is better; each one buys through a different door, and your pitch flexes or it fails.",
            ],
          },
          {
            heading: "Flexing the pitch",
            body: [
              "Analytical: slow down, lead with the numbers, offer the fine print before they ask — no data caps, price fixed, here is the term. Never oversell; one exaggeration and you are done. Driver: compress everything. Bottom line: same speed, 30 less a month, one-minute check — want it? Give them control and choices, not stories. Amiable: warm up first, reference the neighbors, remove risk — no pressure, easy to cancel, everyone on the block found the install painless. Push an amiable hard and they say yes to end the pressure, then cancel tomorrow. Expressive: match energy, tell the story — the crews, the neighbors' reactions, what the household can do with it. Bond first; the details can follow.",
              "The most common rep failure is pitching your own style: analytical reps burying drivers in detail, expressive reps overwhelming analyticals with enthusiasm. The pitch is for their brain, not yours.",
            ],
          },
          {
            heading: "Hold the read loosely",
            body: [
              "The archetype is a starting stance, not a verdict. People blend styles and shift under stress. Read, flex, and keep watching — if the driver suddenly asks for the contract terms, the analytical part of them just showed up. Serve it.",
            ],
          },
        ],
        keyTakeaways: [
          "Four styles: analytical (numbers), driver (bottom line), amiable (safety), expressive (story).",
          "Flex the same facts into the shape each style buys through.",
          "Your default pitch is your own style — the discipline is pitching theirs.",
          "Hold reads loosely; people blend and shift mid-conversation.",
        ],
        drillPrompt:
          "On your next 10 doors, call the archetype silently within the first two exchanges, then change one concrete thing about your pitch to match it. Log the archetype and the adjustment for each door.",
        quiz: [
          {
            question: "The homeowner interrupts your opener: 'What is this about? I have two minutes.' Which flex is right?",
            options: [
              "Warm rapport building to slow things down",
              "The full numbers walk-through with fine print",
              "Bottom line in one sentence, then a choice: same speeds, 30 less, one-minute check — yes or no?",
              "A story about the neighbors' install",
            ],
            answerIndex: 2,
            explanation: "That is a driver. Compress, give the point, and hand them a decision. Slowing a driver down loses the door.",
          },
          {
            question: "Why is hard pressure uniquely counterproductive on an amiable?",
            options: [
              "They will call the police",
              "They may say yes to end the discomfort, then cancel once the pressure is gone",
              "They never buy anything",
              "They only respond to statistics",
            ],
            answerIndex: 1,
            explanation: "Amiables avoid conflict, so pressure produces false yeses that evaporate into next-day cancellations. Safety and neighbor proof are what hold.",
          },
          {
            question: "What should you do when a homeowner's style seems to shift mid-conversation?",
            options: [
              "Stick to your first read for consistency",
              "Follow the shift — serve the style that just showed up",
              "Restart the pitch",
              "Point out that they changed",
            ],
            answerIndex: 1,
            explanation: "Archetypes are working hypotheses. The driver who asks about contract terms is telling you what they need next; give it to them.",
          },
        ],
      },
      {
        id: "m4-buying-signals",
        title: "Buying signals at the door",
        summary: "The questions and shifts that mean stop pitching and start closing.",
        minutes: 4,
        sections: [
          {
            heading: "Signals hide inside ordinary questions",
            body: [
              "Buying signals at a door are rarely 'I want it.' They sound like logistics: How long does the install take? Does it work with my router? What happens to my current contract? When could someone come out? Each of those is the homeowner mentally living with the product. The correct response is never more pitch — it is a direct answer plus a step forward: Install is about 90 minutes, and I have Thursday morning open — does that work?",
            ],
          },
          {
            heading: "Physical and social signals",
            body: [
              "Watch the door and the body. The door opening wider, the homeowner stepping out onto the porch, arms uncrossing, leaning against the frame in no hurry — the physical wall is coming down with the mental one. Calling a spouse over is one of the strongest signals there is: they are recruiting the other decision-maker for you. When it happens, greet the spouse and give a 10-second recap of the pain and the number — do not make the homeowner re-pitch it badly on your behalf.",
            ],
          },
          {
            heading: "The overtalking failure",
            body: [
              "The most common way reps lose a sold door is answering a buying signal with three more minutes of features. Every sentence after the customer is internally sold gives them new material to object to. When the signals fire: answer, ask, and go quiet. Silence after a closing question is the close working — the first one to speak fills the space, and it should not be you.",
            ],
          },
        ],
        keyTakeaways: [
          "Logistics questions — install time, equipment, timing — are buying signals, not obstacles.",
          "Answer signals with a direct answer plus a forward step, never with more pitch.",
          "Door opening wider, stepping onto the porch, and summoning a spouse are strong yes-signals.",
          "Once signals fire, stop selling: answer, ask, silence.",
        ],
        drillPrompt:
          "On your next 10 doors, write down every logistics question you get, verbatim, right after the door. For each one, note whether you answered and advanced, or kept pitching. The goal for the last five doors: advance every time.",
        quiz: [
          {
            question: "The homeowner asks how long installation takes. What is this, and what do you do?",
            options: [
              "An objection — reassure them at length about the process",
              "Small talk — redirect to the savings number",
              "A buying signal — answer directly and offer a concrete install window",
              "A stall — create urgency",
            ],
            answerIndex: 2,
            explanation: "They are mentally scheduling it. Answer in one line and hand them a Thursday. More pitch here can only lose ground.",
          },
          {
            question: "The homeowner calls their spouse to the door. What is the right move?",
            options: [
              "Restart the full pitch from the top for the spouse",
              "Greet the spouse and give a 10-second recap of the pain and the number",
              "Ask the spouse if they are the real decision-maker",
              "Wait silently while the homeowner explains",
            ],
            answerIndex: 1,
            explanation: "Summoning the spouse means they are recruiting the co-decider. A crisp recap keeps the message accurate; a full restart bores the first buyer.",
          },
          {
            question: "Why does continuing to pitch after buying signals appear actively hurt you?",
            options: [
              "It wastes shift time",
              "Every additional claim gives an internally-sold customer fresh material to object to",
              "It violates the 30-second rule",
              "It does not hurt — reinforcement helps",
            ],
            answerIndex: 1,
            explanation: "A sold customer needs a next step, not more reasons. New claims reopen evaluation mode and can talk them back out of the yes.",
          },
        ],
      },
      {
        id: "m4-disqualify",
        title: "Disqualifying fast and politely",
        summary: "Your scarcest asset is daylight — spend it on doors that can buy.",
        minutes: 4,
        sections: [
          {
            heading: "Time at a dead door is stolen from a live one",
            body: [
              "Expected value math cuts both ways: if a door cannot buy, every minute there is a minute taken from a door that can. Hard disqualifiers deserve a fast, warm exit: renters whose landlord controls utilities (get the landlord angle or move on), addresses your build does not serve yet, households locked in a contract with a termination fee larger than the savings, and non-decision-makers home alone with no return time worth booking.",
            ],
          },
          {
            heading: "Qualify inside the first minute",
            body: [
              "Fold qualification into the address check you were already doing: Quick one — do you own the place, or rent? and Who else weighs in on the internet decision? Both sound like process questions, not interrogation, and both save you from pitching an empty chair. If the real decision-maker is out, do not pitch the proxy — book the return: When are you both usually around? I will swing back Thursday around six.",
            ],
          },
          {
            heading: "Exit warm, always",
            body: [
              "A polite exit from a dead door still pays. Renters know owners on the block; the contract-locked household unlocks in eight months; the non-buyer talks at barbecues. Leave every disqualified door with a genuine 'good talking to you' and a one-line seed: If you hear neighbors complaining about the cable bill, the fiber crew is around all month. Never let disappointment show — a door that cannot buy can still recommend, and next season it may be a door that can.",
            ],
          },
        ],
        keyTakeaways: [
          "Every minute at a can't-buy door is taken from a can-buy door.",
          "Fold owner/renter and decision-maker questions into the natural first-minute flow.",
          "Never pitch the proxy — book a return when the decision-makers are home.",
          "Exit disqualified doors warm: they refer now and may qualify later.",
        ],
        drillPrompt:
          "On your next 10 doors, get the two qualifiers — own or rent, and who decides — inside the first minute of every conversation. Time yourself. Any door that fails, exit warm in under 30 seconds with the seed line.",
        quiz: [
          {
            question: "You learn the homeowner rents and the landlord pays utilities. What is the best move?",
            options: [
              "Pitch anyway — enthusiasm might convert them",
              "Ask if they can pass the landlord's contact along, exit warm, and move on",
              "Explain why renting is a bad deal",
              "Leave immediately without another word",
            ],
            answerIndex: 1,
            explanation: "The tenant cannot buy, but the landlord angle and the warm exit both retain value. The worst outcomes are a full wasted pitch or a cold exit.",
          },
          {
            question: "Why should you never deliver the full pitch to a non-decision-maker?",
            options: [
              "It is against policy",
              "Your pitch will be badly re-transmitted secondhand, and you lose the chance to pitch the real buyer fresh",
              "Non-decision-makers are always hostile",
              "It counts against your conversion metrics",
            ],
            answerIndex: 1,
            explanation: "A garbled secondhand pitch inoculates the household against the real one. Book the return and deliver it yourself to the people who can say yes.",
          },
          {
            question: "What does a warm exit from a disqualified door actually buy you?",
            options: [
              "Nothing — the door was dead",
              "Referrals, block reputation, and a future prospect when their situation changes",
              "A better mood only",
              "Protection from complaints",
            ],
            answerIndex: 1,
            explanation: "Dead doors talk to live doors. The 20 seconds a warm exit costs is some of the highest-leverage time in the shift.",
          },
        ],
      },
    ],
  },

  // ── M5 — Objection Psychology ───────────────────────────────────────────────
  {
    id: "m5",
    title: "Objection Psychology",
    tagline: "Reflexes, the agree-bridge-close pattern, and the big six answered.",
    hook: "The first no isn't a decision. It's a reflex. Don't argue with weather.",
    fieldStory:
      "Not interested comes out three seconds in, before you've said what there is to not be interested in. Rookies hear a verdict and fold. Veterans hear a reflex, nod, and ask one real question — and watch the same door that just said no lean back in. Most doors that close, close on that second exchange. Fold at the first no and you're leaving your paycheck inside doors you already knocked.",
    sayThisNotThat: {
      instead: "But wait — if you'd just let me explain why we're better...",
      say: "Totally fair — quick thing though: did the bill do the post-promo jump yet?",
    },
    lessons: [
      {
        id: "m5-reflex",
        title: "Objections are reflexes, not decisions",
        summary: "The first no is a defense mechanism firing — treat it like weather, not a verdict.",
        minutes: 4,
        sections: [
          {
            heading: "The doorstep no is automatic",
            body: [
              "'Not interested' spoken three seconds into your opener cannot be a considered judgment — the homeowner does not yet know what they are not interested in. It is a reflex: the same rehearsed shield they raise at every solicitor, deployed before thought. This distinction changes everything about how you respond. You do not argue with a reflex, because there is no position to argue against. You let it fire, stay relaxed, and give the person a reason to actually think.",
            ],
          },
          {
            heading: "The second response is the real one",
            body: [
              "What the homeowner says after you calmly acknowledge the reflex is their actual position. Totally fair — quick thing though: did the bill do the post-promo jump yet? The reflex fired, you did not fight it, and now a real question invites a real answer. Most doors that convert convert on this second exchange. Reps who fold at the first no are leaving the majority of their sales inside doors they already knocked.",
              "The corollary: a second no is different. When someone has heard the one relevant question and declines again, that is a decision, and decisions get respected. The skill is bouncing past reflex-no and never bulldozing decision-no.",
            ],
          },
          {
            heading: "Stay unhooked",
            body: [
              "The reflex is not about you — it fires on the mailman's day off too. Reps who take the first no personally get visibly tense, and tension confirms the homeowner's instinct to close the door. Reps who receive it like weather — noted, expected, unremarkable — keep the porch calm, and calm porches produce second exchanges.",
            ],
          },
        ],
        keyTakeaways: [
          "A no in the first seconds is a reflex shield, not an evaluation of your offer.",
          "Acknowledge the reflex calmly and ask one relevant question — the second response is the real one.",
          "Reflex-no gets one graceful bounce; decision-no gets respect and a warm exit.",
          "Take nothing personally: tension at the first no is what actually closes the door.",
        ],
        drillPrompt:
          "On your next 10 doors, when the first no comes, acknowledge it and ask exactly one bill or speed question, then count how many doors give you a genuine second exchange. Do not bounce a second no even once.",
        quiz: [
          {
            question: "Why can a no at second three of the conversation not be a real decision?",
            options: [
              "Homeowners are not allowed to decide that fast",
              "No information has been exchanged yet — there is nothing to have decided about",
              "It is usually a joke",
              "It can be — treat every no as final",
            ],
            answerIndex: 1,
            explanation: "A decision requires something to evaluate. Three seconds in, the no is the standard solicitor shield firing on autopilot.",
          },
          {
            question: "What separates a reflex-no from a decision-no?",
            options: [
              "Volume and tone",
              "Whether it comes before or after a real exchange of information",
              "Whether the homeowner smiles",
              "The time of day",
            ],
            answerIndex: 1,
            explanation: "Before the exchange: reflex — bounce once, gently. After they have engaged with the substance and still decline: decision — respect it and exit warm.",
          },
          {
            question: "How many graceful bounces past a no does this lesson permit?",
            options: ["Zero", "One", "Three", "As many as it takes"],
            answerIndex: 1,
            explanation: "One calm acknowledgment plus one relevant question. Pushing past a second no converts you from persistent to pushy and burns the door for every future pass.",
          },
        ],
      },
      {
        id: "m5-agree-bridge",
        title: "The agree-bridge-close pattern",
        summary: "Never argue. Agree with something true, bridge to the reframe, close with a small ask.",
        minutes: 5,
        sections: [
          {
            heading: "Why agreement disarms",
            body: [
              "An objection answered with 'but' becomes an argument, and nobody has ever been argued into a purchase on their own porch. Agreement removes the thing resistance pushes against. There is always something true to agree with: the feeling ('switching is a hassle — agreed'), the fact ('yes, your current speed is fine at noon'), or the instinct ('you should be skeptical of people at your door').",
            ],
          },
          {
            heading: "The three moves",
            body: [
              "Agree: find the true kernel and validate it plainly, without sarcasm and without 'but' welded to the end. Bridge: add the piece of information that reframes the picture — often starting with 'the thing most folks here did not know is...'. Close: ask a small next-step question that lets them act on the new frame: worth the one-minute check? A full example against 'my internet is fine': Honestly, if it works, that is fair — most people here said the same. The one thing that changed minds was seeing the same speeds priced 30 lower without the promo games. Worth a minute to see your address's number?",
              "Keep the bridge to one piece of information. The pattern fails when the bridge becomes a second pitch. Agree in one sentence, bridge in one or two, close in one question.",
            ],
          },
          {
            heading: "Tone carries the pattern",
            body: [
              "Delivered flat, agree-bridge-close is a technique the homeowner has seen before. Delivered with genuine ease — like you actually do not mind if they pass — it is a conversation. The paradox of the doorstep: the less you appear to need the yes, the more yeses you get. Keep the tone of someone sharing a useful fact on their way past, not someone cornering a prospect.",
            ],
          },
        ],
        keyTakeaways: [
          "Never attach 'but' to your agreement — it converts validation into argument.",
          "Agree with the true kernel: the feeling, the fact, or the skeptical instinct.",
          "Bridge with exactly one piece of reframing information, then close with a small ask.",
          "The pattern only works delivered with genuine ease, not technique-voice.",
        ],
        drillPrompt:
          "Pick the objection you hear most. Script one agree sentence, one bridge sentence, and one closing question for it. Use it verbatim on your next 10 doors whenever that objection appears, and log the response each time.",
        pitchDrill:
          "Record your agree-bridge-close against the objection you hear most. One sentence each: agree with the true kernel, bridge with one reframing fact, close with a small ask. For \"my internet is fine,\" that's: \"Honestly, if it works, that's fair — most people here said the same. The one thing that changed minds was seeing the same speeds priced 30 lower without the promo games. Worth a minute to see your address's number?\" Play it back and listen for the word \"but\" — if it snuck in after your agreement, re-record without it.",
        quiz: [
          {
            question: "What does the word 'but' do to an agreement?",
            options: [
              "Strengthens it with contrast",
              "Cancels the validation and reopens the argument the agreement had just defused",
              "Nothing — it is a connector",
              "Makes it sound more natural",
            ],
            answerIndex: 1,
            explanation: "Everything before 'but' gets erased in the listener's ear. The bridge should add information alongside the agreement, not reverse it.",
          },
          {
            question: "A homeowner says switching is too much hassle. Which response follows the pattern?",
            options: [
              "It is actually very easy, you are wrong about that",
              "Fair — switching used to be a project. The install now is one visit, about 90 minutes, and we handle the old provider. Worth seeing if your address qualifies?",
              "But think about the savings you are leaving behind",
              "Okay, have a good day",
            ],
            answerIndex: 1,
            explanation: "It agrees with the true feeling, bridges with one reframing fact about the modern process, and closes on the smallest next step.",
          },
          {
            question: "Why does appearing not to need the yes produce more yeses?",
            options: [
              "It confuses the homeowner",
              "Neediness signals the deal serves you, not them; ease signals the information stands on its own",
              "It is reverse psychology that works on everyone",
              "It does not — urgency always wins",
            ],
            answerIndex: 1,
            explanation: "Pressure implies the offer cannot survive scrutiny. Relaxed delivery implies it can — which is exactly the frame a skeptical homeowner needs to lean in.",
          },
        ],
      },
      {
        id: "m5-big-six-1",
        title: "The big six, part one: busy, happy, and the spouse",
        summary: "Field-tested responses to the three most common brush-offs.",
        minutes: 6,
        sections: [
          {
            heading: "I'm busy right now",
            body: [
              "Usually true, and usually also a shield. Response one — honor and compress: Totally get it — 20 seconds: fiber hit this street, most folks are saving about 30 a month. Worth a real visit later? Then actually stop at 20 seconds; keeping the promise is the pitch. Response two — trade for a booked return: I will get out of your hair. When is a bad-time-proof window — tonight around six, or Saturday morning? A specific-time return beats a doorstep pitch to a distracted person every time.",
            ],
          },
          {
            heading: "I'm happy with my provider",
            body: [
              "Do not attack the provider — that attacks their judgment. Response one — agree and reframe to price: That is honestly great to hear, most people are not. Quick question though: happy at the current bill, or happy if the same thing cost 30 less? Response two — plant and pivot to the future: Fair enough. One thing worth knowing: the line is in on this street now, so if the bill ever does the post-promo jump, the switch is a 90-minute install. I will leave the number with you. Some happy customers are genuinely happy; the seed converts them the month the promo dies.",
            ],
          },
          {
            heading: "I need to ask my spouse",
            body: [
              "Sometimes real, sometimes a polite exit — treat it as real either way, because bulldozing it insults the household. Response one — validate and arm them: Of course — that is a two-person call. Let me leave you the two numbers that matter: same speeds, 30 less, no promo games. What would they want to know that I have not covered? That last question flushes out whether the spouse is the objection or the excuse. Response two — book the joint return: When are you both usually home? I would rather answer questions once for both of you than have you re-pitch me over dinner. Booked joint returns close at multiples of leave-behind rates.",
            ],
          },
        ],
        keyTakeaways: [
          "Busy: compress to 20 honest seconds or trade for a specific-time return.",
          "Happy: never attack the provider — reframe to price or plant the post-promo seed.",
          "Spouse: validate, arm them with two numbers, and push for the joint return visit.",
          "Ask what the spouse would want to know — it reveals whether the objection is real.",
        ],
        drillPrompt:
          "Before your shift, say each of the six responses in this lesson out loud twice. On your next 10 doors, use the matching response the moment one of these three objections appears, and log which objection and which response you used.",
        quiz: [
          {
            question: "The homeowner says they are busy. You promised 20 seconds. What matters most about what happens next?",
            options: [
              "Fitting the full pitch into the 20 seconds by talking fast",
              "Actually stopping at 20 seconds — keeping the promise is itself the trust pitch",
              "Extending to 60 seconds once they seem engaged",
              "Skipping the close to save time",
            ],
            answerIndex: 1,
            explanation: "The compressed pitch works because it demonstrates you do what you say. Blowing the cap proves the opposite and validates the brush-off.",
          },
          {
            question: "Why must you never criticize the current provider to a homeowner who says they are happy?",
            options: [
              "The provider might hear about it",
              "They chose that provider — attacking it attacks their judgment and triggers defense",
              "It violates advertising rules",
              "Happy customers cannot be converted anyway",
            ],
            answerIndex: 1,
            explanation: "People defend their past decisions. Reframing to price keeps their judgment intact: they made a good call, and now there is a better one available.",
          },
          {
            question: "What is the strongest play against the spouse objection?",
            options: [
              "Convince them to decide alone since the savings are obvious",
              "Leave a brochure and hope",
              "Book a specific return when both partners are home",
              "Ask for the spouse's phone number",
            ],
            answerIndex: 2,
            explanation: "A joint return puts the actual decision unit in front of you with your own words. Secondhand pitches and paper close at a fraction of that rate.",
          },
        ],
      },
      {
        id: "m5-big-six-2",
        title: "The big six, part two: price, bad experience, not interested — and when to walk",
        summary: "The heavier three objections, plus the discipline of the graceful exit.",
        minutes: 6,
        sections: [
          {
            heading: "It's too expensive",
            body: [
              "First find out what 'it' is — price objections are often comparison errors against a promo rate that is about to expire. Response one — anchor the comparison honestly: Fair question. What is the bill now? Because that 89 becomes 110 when the promo ends — this is 65 and stays 65. The 'expensive' option is usually the one they have. Response two — reduce to the daily unit and the trade: It comes out around two dollars a day. Most families here traded that against the buffering fights at 8 p.m. and called it cheap. If it is genuinely unaffordable, that is disqualification, not objection — exit warm.",
            ],
          },
          {
            heading: "I had a bad experience with a switch",
            body: [
              "This objection is a scar, and scars deserve respect, not rebuttal. Response one — hear it, then separate: That sounds genuinely frustrating — say more? Let them finish. Then: What burned you was a shared-line provider overselling the block. Fiber is a different architecture — a dedicated line — which is why the street's early installs are holding at full speed. Response two — de-risk the retry: Given that history, do this: take the address check only. If the numbers are not clearly better, keep what you have and you have lost one minute. Small stakes are the only honest answer to earned distrust.",
            ],
          },
          {
            heading: "Not interested, and the walk-away line",
            body: [
              "For the reflex version, use the one graceful bounce from lesson one: acknowledge plus one question. For the decision version — a no after real information — walk, warmly, immediately: No problem at all. If the bill ever jumps, the fiber is in the street now and the install is quick. Have a good one. Know your walk triggers cold: the second no after substance, any request to leave, real anger, or a hard disqualifier. Walking early from dead doors is not weakness; it is what funds the doors that buy. The rep who cannot walk away radiates neediness at every door, and neediness is the one smell every homeowner detects.",
            ],
          },
        ],
        keyTakeaways: [
          "Price objections are usually comparison errors — anchor against the real post-promo bill.",
          "Bad-experience objections are scars: hear them fully, then separate the architecture, then shrink the stakes.",
          "A decision-no gets an immediate warm exit with the seed line, never a third push.",
          "Fixed walk triggers: second no, asked to leave, anger, hard disqualifier. Walking funds your winners.",
        ],
        drillPrompt:
          "Write your walk-away line word for word and memorize it. On your next 10 doors, deliver it at every decision-no within five seconds, warm and unhurried, and rate yourself after each exit on whether any frustration showed.",
        quiz: [
          {
            question: "A homeowner calls fiber too expensive while paying a promo rate that expires next month. What is the first move?",
            options: [
              "Drop the price immediately",
              "Ask what they pay now, then anchor your flat rate against the real post-promo number",
              "Agree it is expensive and leave",
              "List the premium features that justify the cost",
            ],
            answerIndex: 1,
            explanation: "Most price objections compare your real rate to their temporary one. Surface the post-promo number and the comparison usually flips on its own.",
          },
          {
            question: "What does a homeowner with a bad past switching experience need before any facts?",
            options: [
              "A discount",
              "To be fully heard — the scar acknowledged without rebuttal",
              "A comparison chart",
              "To speak with a manager",
            ],
            answerIndex: 1,
            explanation: "Answering a scar with a spec sheet proves you were not listening. Validation first opens the space where the architecture difference can land.",
          },
          {
            question: "Why is willingness to walk away a selling skill rather than giving up?",
            options: [
              "It is not — top reps never walk",
              "Time recovered from dead doors funds live ones, and non-neediness makes every remaining pitch more credible",
              "It reduces complaint risk only",
              "Walking triggers fear of missing out",
            ],
            answerIndex: 1,
            explanation: "The walk protects your hours and your frame. Homeowners trust a rep who plainly does not need them; the rep who cannot leave reeks of it.",
          },
        ],
      },
      {
        id: "m5-preemptive-strike",
        title: "The pre-emptive strike",
        summary: "Defuse your street's top objection inside the pitch, before it is ever voiced.",
        minutes: 5,
        sections: [
          {
            heading: "An objection voiced is a position defended",
            body: [
              "The moment a homeowner says an objection out loud, it stops being a thought and becomes a stance. People defend what they have said far harder than what they have merely felt — walking it back now costs them consistency in front of a stranger. Answering an objection after it is spoken means arguing with a position; answering it before it is spoken means the position never forms. That is the whole logic of the pre-emptive strike: raise the top objection yourself, casually, and resolve it in the same breath.",
              "It also flips the frame. An objection you raise about your own offer reads as honesty, not defense. The homeowner hears a rep confident enough to name the catch, and the skeptical part of their brain — the part hunting for the thing you are hiding — finds the search already done.",
            ],
          },
          {
            heading: "Find your one and fold it in",
            body: [
              "Every street has a dominant objection, and your door notes from the debrief habit tell you which one it is. If the block keeps saying I'm happy with what I have, fold the answer into the pitch: Most folks on this loop told me they were fine with their setup — right up until they saw the same speeds at 30 less without the promo games. If the block keeps flinching at switching hassle: People assume the switch is a project — it is one visit, about 90 minutes, and we handle the old provider. One sentence, delivered as an aside, in the value beat of the skeleton.",
              "The construction is always the same: name the objection as something other people had, then resolve it with one fact. Attributing it to most folks or your neighbors lets the homeowner absorb the answer without ever having to own the objection — nobody has to back down from a stance they never took.",
            ],
          },
          {
            heading: "One strike, small dose",
            body: [
              "Pre-empt exactly one objection — the street's top one — and keep the dose small. A rep who pre-answers three objections is arguing with ghosts, and worse, planting doubts the homeowner never had: they were not worried about contracts until you brought up contracts unprompted, twice. The strike is inoculation, not a rebuttal tour. One sentence inside the pitch, and if a different objection surfaces later, handle it live with agree-bridge-close like any other.",
            ],
          },
        ],
        keyTakeaways: [
          "A spoken objection becomes a defended position — resolve the top one before it is voiced.",
          "Attribute the objection to most folks so the homeowner never has to own or defend it.",
          "One sentence, one fact, inside the value beat — the strike is an aside, not a segment.",
          "Pre-empt only your street's number-one objection; pre-answering three plants doubts that were never there.",
        ],
        drillPrompt:
          "Check your door notes and name your area's most common objection. Script one pre-emptive sentence for it — most folks said X, until Y — and deliver it inside the pitch on your next 10 doors. Count how many doors still voice that objection afterward.",
        quiz: [
          {
            question: "Why is an objection easier to handle before the homeowner says it out loud?",
            options: [
              "Because you can talk faster than they can",
              "Once spoken, it becomes a stance they defend for consistency; unspoken, there is no position to walk back",
              "Because homeowners forget their objections quickly",
              "It is not easier — objections should always be drawn out first",
            ],
            answerIndex: 1,
            explanation: "People defend what they have said far harder than what they have felt. The pre-emptive strike resolves the doubt while it is still a doubt, not a declared position.",
          },
          {
            question: "What is the correct construction of a pre-emptive strike?",
            options: [
              "Ask the homeowner to list their concerns up front",
              "Warn them that most people object for bad reasons",
              "Attribute the objection to most folks around here, then resolve it with one fact, as an aside inside the pitch",
              "Present a slide of frequently asked questions",
            ],
            answerIndex: 2,
            explanation: "Attribution lets them absorb the answer without owning the objection, and the single-fact aside keeps the pitch a pitch instead of a debate with nobody.",
          },
          {
            question: "Why is pre-empting three objections worse than pre-empting one?",
            options: [
              "It takes too long to memorize",
              "Managers only allow one per pitch",
              "Three strikes require three facts, which is too many numbers",
              "You end up arguing with ghosts and planting doubts the homeowner never actually had",
            ],
            answerIndex: 3,
            explanation: "Every unprompted defense suggests a hidden problem. Inoculate against the street's top objection only, and handle anything else live if it actually appears.",
          },
        ],
      },
    ],
  },

  // ── M6 — Closing and Follow-through ─────────────────────────────────────────
  {
    id: "m6",
    title: "Closing and Follow-through",
    tagline: "Assumptive closes, honest urgency, callbacks that happen, and the debrief habit.",
    hook: "Stop asking whether. Start asking which. Then close your mouth.",
    fieldStory:
      "The pitch landed, the signals fired, and the rep — nervous — asks so, do you want to sign up? and hands the homeowner a fresh chance to re-litigate everything. Next door, the rep says mornings or afternoons for the install crew? and just waits. Same sold customer, two questions. One reopens the decision. The other schedules it.",
    sayThisNotThat: {
      instead: "So... do you want to go ahead and sign up?",
      say: "I've got Thursday at 10 or Saturday at 9 for your address — which works?",
    },
    lessons: [
      {
        id: "m6-closes",
        title: "Assumptive and choice closes at the door",
        summary: "Stop asking whether — start asking which.",
        minutes: 5,
        sections: [
          {
            heading: "The close is a continuation, not an event",
            body: [
              "Weak closes make buying a big decision: So... do you want to sign up? That question hands the homeowner a fresh chance to re-litigate everything. Strong closes make buying the natural next step of a conversation that has already gone well. If the pitch landed and the signals fired, the close should feel like scheduling, not deciding.",
            ],
          },
          {
            heading: "Assumptive and choice forms",
            body: [
              "The assumptive close proceeds as if the yes is settled and puts a logistics question on the table: Let me pull up the install calendar for your address. The choice close offers two yeses and no no: Mornings or afternoons better for the install crew? Both work for the same reason — they move the decision from whether to how, and how questions are easy. Use them only after genuine buying signals. An assumptive close against visible hesitation is pressure, and the homeowner feels the mismatch instantly.",
              "If they push back on an assumptive close — hold on, I have not said yes — do not apologize into a puddle. Calibrate honestly: You are right, I got ahead of us. What is the piece you are still weighing? The pushback just told you exactly where the real objection lives, which is more than most doors give you.",
            ],
          },
          {
            heading: "Ask, then hold the silence",
            body: [
              "Every close ends the same way: with your mouth closed. Ask the closing question and wait — five seconds, ten if needed. The silence is uncomfortable, and untrained reps break it by re-pitching, which reopens the decision they just asked for. The homeowner is doing the math; let them finish. Whoever speaks first buys or sells — make sure it is them.",
            ],
          },
        ],
        keyTakeaways: [
          "Move the question from whether to how: schedule, do not re-decide.",
          "Choice close: two yeses, no no. Assumptive close: proceed to logistics.",
          "Only close assumptively after real buying signals — against hesitation it is pressure.",
          "Ask the closing question once, then hold the silence until they answer.",
        ],
        drillPrompt:
          "On your next 10 engaged doors, end every pitch with a choice close — mornings or afternoons — and then count silently to ten before saying another word. Log how many homeowners answer inside the silence.",
        pitchDrill:
          "Record your choice close and the silence that follows it. Say it as the natural next step of a conversation that already went well: \"Mornings or afternoons better for the install crew?\" Then stop the recording after you've held a real five to ten seconds of silence. Play it back — the close should sound like scheduling, not asking permission, and the pause after it should be long enough to feel uncomfortable. That discomfort is the close working.",
        quiz: [
          {
            question: "What makes 'mornings or afternoons better for the install?' stronger than 'do you want to sign up?'",
            options: [
              "It is more polite",
              "It moves the decision from whether to how — both answers advance, and how questions are easy",
              "It hides the commitment from the homeowner",
              "It is faster to say",
            ],
            answerIndex: 1,
            explanation: "Whether-questions invite re-litigating the whole decision. How-questions assume the settled yes and offer two easy paths forward.",
          },
          {
            question: "The homeowner says 'hold on, I have not agreed yet' after your assumptive close. Best response?",
            options: [
              "Apologize repeatedly and restart the pitch",
              "Push through — they are almost there",
              "Own it lightly and ask what they are still weighing",
              "Switch immediately to a discount offer",
            ],
            answerIndex: 2,
            explanation: "Calibrate without collapsing. Their pushback locates the real remaining objection — ask for it directly and handle that one thing.",
          },
          {
            question: "Why must you stay silent after asking the closing question?",
            options: [
              "It is dramatic",
              "The homeowner is processing; filling the silence re-opens the decision and often talks them out of the yes",
              "Silence is a negotiation trick that lowers the price",
              "To listen for the spouse",
            ],
            answerIndex: 1,
            explanation: "The post-question silence is where the internal math finishes. Re-pitching into it hands them new inputs and restarts the loop you just closed.",
          },
        ],
      },
      {
        id: "m6-install-date",
        title: "The install-date close and honest urgency",
        summary: "The calendar is your strongest close — and the urgency you use must be true.",
        minutes: 5,
        sections: [
          {
            heading: "Close on the calendar, not the contract",
            body: [
              "The install-date close makes the concrete, pleasant part of the decision the whole decision: The crew is on this street through the end of the month — I have Thursday at 10 or Saturday at 9 for your address. Which works? A date is vivid and easy to say yes to; paperwork follows a chosen date far more easily than a date follows signed paperwork. Once Thursday at 10 is theirs, the household starts planning around it, and the mental ownership does the rest.",
            ],
          },
          {
            heading: "Urgency that is true",
            body: [
              "Real urgency exists in this business and you should use every ounce of it: the crew genuinely is on this street this month, and a later install genuinely may wait for the next pass; a promotional rate genuinely has an end date; install calendars genuinely fill. State these plainly, with their real limits: While the crew is staged here, installs are days out. After they move on, the same install waits for the next rotation.",
              "Fake scarcity — invented deadlines, last-spot-tonight pressure, offers that mysteriously expire when you leave the porch — is a different thing entirely. It closes a few weak deals, generates cancellations and complaints, and poisons the block for every future pass. The test is simple: if the homeowner repeated your urgency claim to your manager, would it hold? If not, it does not leave your mouth.",
            ],
          },
          {
            heading: "Lock the date on the porch",
            body: [
              "A close is not closed until the date is confirmed in the system while you are standing there. Fill out the order, confirm the slot, and tell them exactly what happens next: You will get a text confirming Thursday. The crew calls 30 minutes out. Nothing you need before then. Concrete next steps at the moment of yes cut buyer's remorse in half — remorse feeds on vagueness.",
            ],
          },
        ],
        keyTakeaways: [
          "Close on an install date — dates are vivid, easy yeses that create mental ownership.",
          "Use every ounce of real urgency: crew presence, true rate windows, filling calendars.",
          "The manager test: if the homeowner repeated your urgency line to your manager, would it hold?",
          "Confirm the slot in-system on the porch and narrate exactly what happens next.",
        ],
        drillPrompt:
          "Learn your actual crew schedule and calendar availability before the shift. On your next 10 engaged doors, close with two real install slots by name, and book any yes in-system before leaving the porch.",
        quiz: [
          {
            question: "Why does the install-date close outperform a paperwork-first close?",
            options: [
              "Dates avoid legal review",
              "A chosen date is vivid and low-friction, and the household's mental ownership of it pulls the paperwork along",
              "It skips the credit check",
              "Homeowners dislike pens",
            ],
            answerIndex: 1,
            explanation: "Thursday at 10 is concrete and easy to accept; the signature becomes the formality attached to a plan they already own.",
          },
          {
            question: "Which urgency line passes this lesson's test?",
            options: [
              "This offer disappears when I step off the porch",
              "I can only hold this price for the next hour",
              "The crew is staged on this street through the month — while they are here, installs are days out instead of waiting for the next rotation",
              "You are the last house I can sign today",
            ],
            answerIndex: 2,
            explanation: "It is verifiable, has real limits, and would hold if repeated to your manager. The others are invented pressure that generates cancellations and complaints.",
          },
          {
            question: "What should happen in the final minute on the porch after a yes?",
            options: [
              "Leave quickly before they reconsider",
              "Confirm the slot in-system and narrate the exact next steps: the text, the crew call, what they need to do",
              "Upsell add-on services",
              "Ask for referrals immediately",
            ],
            answerIndex: 1,
            explanation: "Remorse feeds on vagueness. A confirmed slot plus a concrete what-happens-next script is the cheapest cancellation insurance there is.",
          },
        ],
      },
      {
        id: "m6-callback",
        title: "The callback that actually happens",
        summary: "Most callbacks are polite fiction — here is how to book the real ones.",
        minutes: 4,
        sections: [
          {
            heading: "Vague callbacks are soft nos",
            body: [
              "Come back sometime and I will think about it are exits, not appointments. A callback is only real when it has three properties: a specific time, a stated reason, and a named participant. Thursday at six, so I can show you both the address pricing, when your wife is home — that can actually happen. Anything less converts at roughly zero and pollutes your follow-up list with ghosts.",
            ],
          },
          {
            heading: "Book it like an appointment, because it is one",
            body: [
              "Propose two concrete windows, never an open question: I am back on this street Thursday evening and Saturday morning — which is better? Then attach the reason: I will bring the exact install calendar for your address. Log it in the app on the porch, in front of them — visible logging signals you will actually show, and it separates you from every rep who said they would come back and never did. If they will not commit to a window, read it honestly: that is a soft no. Leave the seed line and spend Thursday on doors that said yes to a time.",
            ],
          },
          {
            heading: "Show up exactly when you said",
            body: [
              "The callback close begins when you arrive on time. Open by referencing the commitment: Thursday at six, as promised — I brought your address's numbers. Punctuality at a door where they expected flakiness is startling credibility, and the pitch that follows starts from trust instead of zero. One kept callback on a street also travels: neighbors hear that you are the rep who actually came back.",
            ],
          },
        ],
        keyTakeaways: [
          "A real callback has a specific time, a stated reason, and a named participant.",
          "Offer two windows, attach the reason, and log it visibly on the porch.",
          "No committed window means soft no — seed and move on.",
          "Arriving exactly on time converts expected flakiness into startling credibility.",
        ],
        drillPrompt:
          "On your next 10 doors, refuse to accept a vague callback: every follow-up gets two proposed windows and a reason, logged in the app before you leave the porch. Count real bookings versus soft nos you correctly released.",
        quiz: [
          {
            question: "Which of these is a real callback?",
            options: [
              "Swing by whenever, we are usually around",
              "Maybe next week sometime",
              "Thursday at six, with both partners home, to review the address pricing",
              "Leave your card and we will call you",
            ],
            answerIndex: 2,
            explanation: "Time, reason, participants. The other three are polite exits that convert at roughly zero.",
          },
          {
            question: "Why log the callback in the app while still on the porch?",
            options: [
              "To use the phone as a prop",
              "Visible logging signals real intent to return and formalizes the commitment on both sides",
              "Because signal is better outdoors",
              "To time-stamp for the manager",
            ],
            answerIndex: 1,
            explanation: "The visible act tells the homeowner this is an appointment, not a pleasantry — and it makes your own follow-through automatic.",
          },
          {
            question: "The homeowner will not commit to either proposed window. What does this mean?",
            options: [
              "Offer five more windows",
              "It is a soft no — leave the seed line warmly and invest the time in committed doors",
              "Show up unannounced Thursday anyway",
              "Escalate to a manager visit",
            ],
            answerIndex: 1,
            explanation: "Refusing every specific window while staying polite is how homeowners decline without conflict. Read it accurately and spend your hours where the yes lives.",
          },
        ],
      },
      {
        id: "m6-debrief",
        title: "The 30-second post-door debrief",
        summary: "The habit that compounds: extract one lesson from every meaningful door.",
        minutes: 4,
        sections: [
          {
            heading: "Experience is not automatic",
            body: [
              "Two reps knock a thousand doors. One gets a year of compounding skill; the other gets one week of experience repeated fifty times. The difference is the debrief: a deliberate 30-second review after every meaningful door, while the data is still warm. Without it, the lessons inside your best and worst doors evaporate by the end of the block.",
            ],
          },
          {
            heading: "Three questions, thirty seconds",
            body: [
              "Walking away from any door with a real interaction, answer three questions. What worked — which line, question, or number landed? Where did I lose them — the exact moment attention dropped or the objection hardened? What changes next door — one specific, immediate adjustment? Log a one-line note in the app with the outcome; the note that costs ten seconds today is the pattern that jumps out of your week on Friday.",
              "Keep the debrief mechanical, not emotional. It reviews the process, not your worth: opener delivered, pain question asked, close attempted — yes or no. The reset ritual from Module 1 clears the feelings; the debrief harvests the facts. Run them in that order.",
            ],
          },
          {
            heading: "The weekly rollup",
            body: [
              "Once a week, read your notes in one sitting. Patterns invisible door-by-door become obvious in aggregate: every spouse objection clustered after 7 p.m., every sale preceded by a named-neighbor proof point, every lost door following a skipped pain question. Pick the single biggest pattern and make it next week's one adjustment. One deliberate fix a week compounds into a different rep by the end of the season.",
            ],
          },
        ],
        keyTakeaways: [
          "Without a debrief, a thousand doors teach you one week's lesson fifty times.",
          "Three questions per meaningful door: what worked, where did I lose them, what changes next.",
          "Reset first (clear the emotion), then debrief (harvest the fact).",
          "Weekly rollup: find the one pattern, make the one adjustment, compound.",
        ],
        drillPrompt:
          "After every one of your next 10 doors with a real interaction, run the three questions out loud on the walk and log a one-line note before knocking again. At the end of the set, read all ten notes and name the one pattern you will fix tomorrow.",
        quiz: [
          {
            question: "What separates a rep with a year of compounding skill from one repeating the same week fifty times?",
            options: [
              "Territory quality",
              "A deliberate post-door debrief that extracts lessons while they are fresh",
              "Natural charisma",
              "Longer shifts",
            ],
            answerIndex: 1,
            explanation: "Doors generate data constantly, but unexamined data evaporates. The 30-second review is what converts knocks into skill.",
          },
          {
            question: "What are the three debrief questions?",
            options: [
              "Did I sell, was I liked, was it fair",
              "What worked, where did I lose them, what changes next door",
              "Who answered, what provider, what objection",
              "How long, how many, how much",
            ],
            answerIndex: 1,
            explanation: "One positive to keep, one loss point to locate, one immediate adjustment to apply. Mechanical, fast, and about the process rather than your worth.",
          },
          {
            question: "Why run the reset ritual before the debrief rather than after?",
            options: [
              "Order does not matter",
              "The debrief needs a clear head — emotion distorts the facts you are trying to harvest",
              "The debrief is emotional and the reset is factual",
              "To save time between doors",
            ],
            answerIndex: 1,
            explanation: "A rattled rep reviews the door as a story about themselves. Reset to neutral first, and the debrief becomes an honest reading of the process.",
          },
        ],
      },
    ],
  },

  // ── M7 — The Closing Playbook ───────────────────────────────────────────────
  {
    id: "m7",
    title: "The Closing Playbook",
    tagline: "Six closing styles, when each one is earned, and the failure mode of each.",
    hook: "Six ways to close. The skill is knowing which one the door just earned.",
    fieldStory:
      "A rep hits an assumptive close against a homeowner who's still visibly weighing it — and manufactures the exact objection the close was supposed to skip. The homeowner feels the mismatch instantly. Closes aren't lines you fire on cue; they're reads. Count the buying signals first, pick the close the conversation earned, then hold four seconds of silence and let them finish the math.",
    sayThisNotThat: {
      instead: "Do you want to save money, or keep overpaying every month?",
      say: "I've got Thursday at 10 or Saturday at 9 — which fits your week better?",
    },
    lessons: [
      {
        id: "m7-assumptive-deep",
        title: "The assumptive close: the full playbook",
        summary: "Proceed as if the yes is settled, survive the pushback, and let silence finish the job.",
        minutes: 6,
        sections: [
          {
            heading: "When the assumptive close is earned",
            body: [
              "Module 6 introduced the assumptive close; this is the full treatment. The assumptive close is not a trick — it is a reading. When the conversation has already gone yes-shaped, re-asking whether insults the progress. The move is to proceed to logistics as if the decision is settled: Let me pull up the install calendar for your address — looks like the crew has Thursday morning open. No permission requested, no drama, just the natural next step of a conversation that earned it.",
              "Earned is the operative word. The gate is two or more genuine buying signals: a logistics question, the spouse summoned, the door opened wide, the homeowner stepping out onto the porch. Fired against visible hesitation, the same sentence becomes pressure, and the homeowner feels the mismatch instantly — you just manufactured the objection your close was supposed to skip. Count signals before you assume. Zero or one signal means keep discovering; two or more means stop pitching and proceed.",
            ],
          },
          {
            heading: "The walk-back that saves it",
            body: [
              "Sometimes you misread, and the homeowner says: hold on, I have not agreed to anything. This moment decides the door, and the failure is collapsing into apology. Calibrate instead, lightly and without retreat: You are right — I got ahead of us. What is the piece you are still weighing? One sentence of ownership, one question. Their answer names the real remaining objection, which is more than most doors ever hand you, and the conversation continues from the exact spot that matters.",
              "What you must not do is restart the pitch, stack apologies, or pretend the close did not happen. The homeowner watched you overreach and recover with composure — done cleanly, the walk-back itself is a credibility deposit.",
            ],
          },
          {
            heading: "Silence as a close: the 4-second rule",
            body: [
              "Every closing ask in this module ends the same way: with your mouth closed. After the ask, hold silence for four full seconds minimum — count them in your head if you have to. The homeowner is running the final math, and the silence is not dead air; it is the close operating. Untrained reps panic at second two and re-pitch, which hands the homeowner new inputs and restarts the decision they were about to finish.",
              "Four seconds feels like an hour on a porch. Practice it until it feels like what it is: the most productive four seconds of the conversation. When they speak, respond to what they said — not to your nerves.",
            ],
          },
        ],
        keyTakeaways: [
          "The assumptive close is a reading, not a trick — it requires two or more genuine buying signals first.",
          "Proceed to logistics as the natural next step: pull up the calendar, name a real slot.",
          "If they push back, own it in one sentence and ask what they are still weighing — never collapse into apology.",
          "After any closing ask, hold four full seconds of silence. Re-pitching into the silence reopens the decision.",
        ],
        drillPrompt:
          "On your next 10 engaged doors, keep a silent signal count and close assumptively only after two signals. After every closing ask, count four seconds in your head before speaking. Log each door: signals counted, close attempted, who spoke first.",
        pitchDrill:
          "Record the assumptive close plus the walk-back that saves it. First the close: \"Let me pull up the install calendar for your address — looks like the crew has Thursday morning open.\" Then, in the same take, handle the pushback: \"You're right — I got ahead of us. What's the piece you're still weighing?\" Play it back and check the recovery line: does it own the overreach in one calm sentence, or does it collapse into a puddle of apology? Composure here is a credibility deposit.",
        quiz: [
          {
            question: "What is the gate for deploying an assumptive close?",
            options: [
              "The pitch has been fully delivered",
              "Two or more genuine buying signals have appeared",
              "The homeowner has been at the door for five minutes",
              "The rep feels confident",
            ],
            answerIndex: 1,
            explanation: "The assumptive close reads a decision that has already formed. Without the signals, the same words are pressure and create the objection they were meant to skip.",
          },
          {
            question: "The homeowner says 'hold on, I have not agreed to anything.' What is the playbook response?",
            options: [
              "Apologize several times and restart the pitch from the top",
              "Push forward — they are close and momentum matters",
              "You are right, I got ahead of us — what is the piece you are still weighing?",
              "Offer a discount to smooth it over",
            ],
            answerIndex: 2,
            explanation: "One sentence of ownership, one question. The pushback locates the real objection, and a composed walk-back deposits credibility instead of draining it.",
          },
          {
            question: "Why does the 4-second rule exist?",
            options: [
              "It gives you time to plan the next pitch",
              "Silence pressures the homeowner into compliance",
              "It is a courtesy convention",
              "The homeowner is finishing their internal math — interrupting hands them new inputs and restarts the decision",
            ],
            answerIndex: 3,
            explanation: "The post-ask silence is the close operating. Whoever speaks first ends the decision — make sure it is them, answering it.",
          },
        ],
      },
      {
        id: "m7-alternative-choice",
        title: "The alternative-choice close: two installs, never yes/no",
        summary: "Replace the whether question with a which question built from two real options.",
        minutes: 5,
        sections: [
          {
            heading: "Why which beats whether",
            body: [
              "A yes/no closing question — so, do you want it? — invites the homeowner to re-litigate the entire decision from the top. An alternative-choice close skips the whether and asks about the how: I have Thursday at 10 or Saturday at 9 for your address — which fits better? Both answers advance the sale, and how-questions are cognitively easy in a way that whether-questions never are. The yes is presupposed gently, and if it genuinely exists, the homeowner steps into it without friction.",
            ],
          },
          {
            heading: "Building the choices right",
            body: [
              "Offer exactly two options. One option is a yes/no question in disguise; three or more turns the close into analysis and stalls it. Both options must be real — actual slots on the actual calendar — and both must be acceptable to you. Make them concrete and near-term: named days, named times. Thursday at 10 or Saturday at 9 closes; sometime this week or maybe next does not.",
              "And the choice must always be between two versions of how, never a manufactured choice about whether. Do you want to save money, or keep overpaying? is not an alternative-choice close — it is a manipulative false choice, the homeowner recognizes it as one, and it costs you the trust the real technique depends on.",
            ],
          },
          {
            heading: "Failure mode: the choice before the yes",
            body: [
              "Deployed before buying signals exist, the alternative-choice close feels like a trap snapping shut, and the standard escape is neither works for me. When you hear neither, read it honestly. Sometimes it is a real calendar conflict — offer to find a slot: What week does work? I can check the crew's rotation. But delivered flat, with no counter-offer, neither is a soft no wearing scheduling clothes. Back out of logistics and return to discovery: Sounds like the timing is not really the question — what is still open for you? Forcing a third slot onto a soft no is how reps turn a recoverable door into a burned one.",
            ],
          },
        ],
        keyTakeaways: [
          "Move the close from whether to which: two real install slots, both of which advance the sale.",
          "Exactly two options, concrete and near-term — one is a yes/no in disguise, three is analysis.",
          "Never manufacture a false choice about whether; the choice is always between two versions of how.",
          "A flat 'neither works' with no counter-offer is a soft no — return to discovery, do not offer slot three.",
        ],
        drillPrompt:
          "Before your shift, memorize two real install slots from the actual calendar. On your next 10 engaged doors, close with those two slots by name and log the response: a slot chosen, a genuine conflict, or a flat neither. Treat every flat neither as a discovery question, not a scheduling problem.",
        quiz: [
          {
            question: "Why does 'Thursday at 10 or Saturday at 9?' outperform 'do you want to sign up?'",
            options: [
              "It sounds more professional",
              "It presupposes the yes and asks an easy how-question, so both answers advance the sale",
              "It hides the commitment until the paperwork",
              "Homeowners prefer weekends",
            ],
            answerIndex: 1,
            explanation: "Whether-questions reopen the whole decision; which-questions ride the yes that already formed and only ask logistics.",
          },
          {
            question: "What is wrong with 'do you want to save money, or keep overpaying?'",
            options: [
              "Nothing — it is a strong alternative-choice close",
              "It offers too many options",
              "It is a manufactured false choice about whether, which homeowners recognize as manipulation",
              "It mentions money too early",
            ],
            answerIndex: 2,
            explanation: "The legitimate technique chooses between two versions of how. A rigged choice about whether burns the trust that makes the real close work.",
          },
          {
            question: "The homeowner says 'neither works' flatly, offering no alternative. What does the playbook say?",
            options: [
              "Offer a third and fourth slot until one lands",
              "Read it as a soft no and return to discovery — ask what is still open for them",
              "Book Thursday anyway and confirm by text",
              "Leave immediately without another word",
            ],
            answerIndex: 1,
            explanation: "A real conflict comes with a counter-offer. A flat neither is a decline wearing scheduling clothes; pushing more slots at it burns the door.",
          },
        ],
      },
      {
        id: "m7-summary-close",
        title: "The summary close: stack the agreed pains back",
        summary: "Replay their own three pains in their own words, then attach the fix and the ask.",
        minutes: 5,
        sections: [
          {
            heading: "Their words, played back",
            body: [
              "Through a good door conversation, the homeowner hands you pains in their own words: the bill jumped to 105, the upstairs stream drops every evening, they pay 15 a month to rent a modem. The summary close collects those and plays them back in one stack: So — the bill is at 105 and climbing, the 8 p.m. stream keeps dropping, and 15 of that bill is renting their modem. Fiber puts you at 65 flat on a dedicated line with your own equipment. Want me to grab Thursday? Three items, their words, then the fix, then one ask.",
            ],
          },
          {
            heading: "Why stacking works",
            body: [
              "Each pain alone is tolerable — people live with a bad bill or a flaky stream for years. Stacked in one sentence, the pains describe the situation the way it actually is, and tolerable stops being the right word. And because every item in the stack came out of the homeowner's own mouth, the summary is not a set of claims to argue with — it is agreement replay. Nobody rebuts their own words. This is also why the summary close is the natural finish after a long conversation, with analytical buyers who want the logic assembled, or when a spouse arrives late and needs the whole picture in ten seconds.",
            ],
          },
          {
            heading: "Failure modes",
            body: [
              "Three ways to break it. First, inventing a pain they never voiced — they notice instantly, the whole stack collapses, and you have proven you were building a case instead of listening. Second, over-stacking: five or six items stops sounding like a summary and starts sounding like a prosecution. Three is the ceiling. Third, the gotcha tone — delivered with a raised eyebrow and a so-there cadence, the same words become a trap closing. Deliver it the way a good waiter reads back an order: accurate, neutral, and on their side.",
            ],
          },
        ],
        keyTakeaways: [
          "Stack a maximum of three pains, each one in the homeowner's own words, then the fix, then one ask.",
          "Their own words are agreement replay, not claims — nobody rebuts their own words.",
          "Best deployed after long conversations, with analytical buyers, or to catch up a late-arriving spouse.",
          "Never invent a pain, never stack past three, and deliver it like an order read-back, not a prosecution.",
        ],
        drillPrompt:
          "On your next 10 doors, keep a mental slot for every pain the homeowner voices, verbatim. At any door that reaches a close, deliver a three-item summary using only their words before the ask. Afterward, log whether the stack was accurate or you caught yourself paraphrasing.",
        quiz: [
          {
            question: "Why is a summary built from the homeowner's own words hard to argue with?",
            options: [
              "It is technically accurate",
              "Homeowners forget what they said",
              "It is agreement replay — rebutting it would mean rebutting themselves",
              "Long sentences discourage interruption",
            ],
            answerIndex: 2,
            explanation: "Claims invite counter-claims. Their own voiced pains, played back accurately, carry testimony weight that no assertion of yours can match.",
          },
          {
            question: "What is the maximum stack size, and why?",
            options: [
              "Five — more evidence is more persuasive",
              "Three — beyond that the summary reads as a prosecution instead of a read-back",
              "One — simplicity always wins",
              "There is no limit if the pains are real",
            ],
            answerIndex: 1,
            explanation: "Three stacked pains reframe the situation; five turn the close into a case against the homeowner's judgment, which triggers defense.",
          },
          {
            question: "You are mid-summary and realize one of your three items was never actually said by the homeowner. What happened?",
            options: [
              "Nothing — it was probably true anyway",
              "You strengthened the close with an extra pain",
              "A minor slip that homeowners rarely catch",
              "You broke the technique — an invented pain collapses the stack and reveals case-building instead of listening",
            ],
            answerIndex: 3,
            explanation: "The summary close's entire power is that every item is theirs. One planted item converts agreement replay back into arguable claims and costs the trust behind all three.",
          },
        ],
      },
      {
        id: "m7-takeaway-close",
        title: "The takeaway close: honest scarcity and the walk-back",
        summary: "Stop pulling and let the offer's real limits do the work — without ever inventing one.",
        minutes: 6,
        sections: [
          {
            heading: "The psychology of the takeaway",
            body: [
              "Resistance needs something to push against. A rep who is always pulling toward the sale gives the homeowner a force to resist; the takeaway removes the force. Honestly — it might not be worth switching for you. If the bill is genuinely under 70 and stays there, you are one of the rare setups I would leave alone. Said sincerely, this does one of two things: it closes — well, it is actually 95 — because the homeowner starts selling themselves the moment you stop; or it disqualifies correctly, which is also a win. The takeaway is qualification wearing a close's clothes.",
            ],
          },
          {
            heading: "Install-slot scarcity and the walk-back",
            body: [
              "The second form uses the real limits of the operation: The crew wraps this street Friday — after that, the same install waits for the next rotation through. That is honest scarcity, and it moves people because it is true and verifiable from their porch. The manager test from Module 6 applies word for word: if the homeowner repeated your scarcity line to your manager, would it hold? If not, it does not leave your mouth.",
              "The walk-back is the physical version. At a stalled door, begin a genuine warm exit — the half turn, no problem at all, if the bill ever jumps the line is in the street now. Some meaningful fraction of doors re-open right there: hang on — what was the price again? Losing access, even to something they were declining, changes its weight. But the walk must be real. If they do not call you back, keep walking, warmly. A fake walk-back that loops at the end of the driveway is theater, and homeowners have seen the play.",
            ],
          },
          {
            heading: "The ethics line",
            body: [
              "The takeaway only works from abundance — from a rep who genuinely does not need this particular yes because the math says the next door pays the same. Faked reluctance, invented deadlines, might-not-qualify games played on an address you know qualifies: these are lies with a short shelf life and a long complaint tail. Two hard rules: never take away anything that is not really limited, and never suggest doubt about qualification that you do not actually have. If you cannot walk away honestly, do not fake the walk — fix your pipeline until you can.",
            ],
          },
        ],
        keyTakeaways: [
          "The takeaway removes the force resistance pushes against — stop pulling and they start selling themselves.",
          "It might not be worth it for you is qualification wearing a close's clothes: it either closes or correctly disqualifies.",
          "Real scarcity only: crew rotations and calendar limits that pass the manager test word for word.",
          "The walk-back must be genuine — if they do not call you back, keep walking, warmly.",
        ],
        drillPrompt:
          "On your next 10 doors, deploy one honest takeaway at any stalled-but-qualified door: name the real limit or concede they might be fine as-is, then start a genuine warm exit. Count how many doors re-open behind you, and confirm every scarcity line you used would survive the manager test.",
        quiz: [
          {
            question: "Why does the takeaway close work psychologically?",
            options: [
              "It insults the homeowner into proving you wrong",
              "Resistance needs a pulling force to push against — remove the pull and the homeowner starts weighing the offer on its merits",
              "It saves time on doors that will not buy",
              "Scarcity always overrides judgment",
            ],
            answerIndex: 1,
            explanation: "The takeaway ends the tug-of-war. With nothing to resist, the homeowner is left alone with the actual math, and losing access changes the offer's weight.",
          },
          {
            question: "Which line stays on the right side of the ethics line?",
            options: [
              "This price expires when I leave the porch",
              "I can only do this for one more house tonight",
              "The crew wraps this street Friday — after that, the install waits for the next rotation",
              "You probably will not qualify, so decide fast",
            ],
            answerIndex: 2,
            explanation: "Crew rotation is real, verifiable, and would hold if repeated to your manager. The others are invented pressure — short shelf life, long complaint tail.",
          },
          {
            question: "You start a genuine walk-back and the homeowner does not call you back. What now?",
            options: [
              "Keep walking, warmly — the walk was real and the door stays warm for the next pass",
              "Circle back at the end of the driveway with a better offer",
              "Knock again in ten minutes",
              "Log the door as hostile",
            ],
            answerIndex: 0,
            explanation: "A walk-back that loops around is theater the homeowner has seen before. The technique only exists because the walk is genuine — honor it and the seed line does its slow work.",
          },
        ],
      },
      {
        id: "m7-trial-close",
        title: "The trial close and the no-risk frame",
        summary: "Temperature checks that measure without demanding, and the puppy-dog frame that lets the product close itself.",
        minutes: 5,
        sections: [
          {
            heading: "Temperature checks before the ask",
            body: [
              "A trial close is a question that measures readiness without demanding a decision: How does that 65 compare to what you are paying now? or If the speeds hold the way they are holding next door, is there anything else that would give you pause? The answer tells you which move is next — a warm answer says stop pitching and close; a cool answer names the gap you still need to fill. Trial closes are how you avoid the two classic errors: closing too early against hesitation, and overtalking past a door that was already sold.",
              "You have been running one all along: the address-check micro-close — worth checking if your address qualifies? — is itself a trial close. The yes costs the homeowner nothing, and how they say it is a temperature reading on everything that follows.",
            ],
          },
          {
            heading: "The puppy-dog frame",
            body: [
              "The name comes from pet stores that let the family take the puppy home for the weekend — nobody brings the puppy back, because ownership does the selling. The fiber version is the 30-day no-risk frame: Try it for a month. If the evening speeds do not do what I said, switch back and you have lost nothing. Two weeks of a household living on symmetrical speeds and no 8 p.m. sag, and going back feels like a downgrade. You are not closing the sale; you are closing the trial, and the product closes the sale.",
              "The frame is only available if your actual terms support it. Know precisely what the guarantee, cancellation window, and any fees really are before the words no risk leave your mouth.",
            ],
          },
          {
            heading: "Failure modes",
            body: [
              "Two ways this goes wrong. First, the interrogation: trial-close questions fired in a row — how does that sound? does that work? are we good? — stop measuring temperature and start applying heat. One trial close per stage of the conversation, then act on the reading. Second, the false no-risk: if there is an early termination fee, an install charge, or a return-equipment hassle, the frame is not literally true, and the homeowner who discovers that in month two becomes a cancellation, a complaint, and a story the whole block hears. No-risk must mean no risk, or it must not be said.",
            ],
          },
        ],
        keyTakeaways: [
          "Trial closes measure readiness without demanding a decision — warm answers say close, cool answers name the gap.",
          "The address-check micro-close is your ever-present trial close; read how the yes sounds.",
          "The puppy-dog frame closes the trial and lets lived-in speeds close the sale.",
          "One trial close per stage, and never say no-risk unless the terms make it literally true.",
        ],
        drillPrompt:
          "On your next 10 engaged doors, run exactly one trial close after the value beat — how does that compare to what you are paying? — and write down the answer's temperature: warm, neutral, or cool. Close only the warm ones and note whether your close rate on attempted closes improves.",
        quiz: [
          {
            question: "What is a trial close for?",
            options: [
              "Locking the homeowner into a verbal commitment",
              "Measuring readiness without demanding a decision, so you know whether to close or keep filling the gap",
              "Practicing your closing lines on low-value doors",
              "Extending the conversation length",
            ],
            answerIndex: 1,
            explanation: "The trial close is a thermometer, not a contract. It prevents both premature closes against hesitation and overtalking past a sold door.",
          },
          {
            question: "Why does the puppy-dog frame work?",
            options: [
              "Everyone loves dogs",
              "It hides the real price until after install",
              "Ownership does the selling — two weeks of lived-in fiber speeds makes going back feel like a downgrade",
              "It legally obligates the homeowner after 30 days",
            ],
            answerIndex: 2,
            explanation: "You close the low-stakes trial; the daily experience of the product closes the sale. That is why the frame converts skeptics that arguments cannot.",
          },
          {
            question: "When is the phrase no-risk allowed at the door?",
            options: [
              "Whenever it helps close a hesitant buyer",
              "Only when the actual terms make it literally true — no fees, real cancellation window, no hidden hassle",
              "Only in writing",
              "Never — risk language is always banned",
            ],
            answerIndex: 1,
            explanation: "A no-risk claim the homeowner disproves in month two produces a cancellation, a complaint, and a block-wide story. The frame is powerful precisely because it is checkable — so it must check out.",
          },
        ],
      },
      {
        id: "m7-referral-close",
        title: "The referral close: the next door starts on this porch",
        summary: "Ask at peak goodwill, get the name-drop permissioned, and knock the referral within 48 hours.",
        minutes: 5,
        sections: [
          {
            heading: "The moment to ask",
            body: [
              "The best time to open the next sale is the sixty seconds after closing this one. The new customer is at peak goodwill — they just made a decision they feel good about, and helping a neighbor get the same deal confirms it was smart. While you confirm the install: Who else on the street complains about the bill? Anyone you would want on the same install week so the crew does both in one pass? Ask for names, plural and specific. Anyone you know? produces a shrug; who complains about the bill? produces the Hendersons.",
            ],
          },
          {
            heading: "Permissioned name-drops",
            body: [
              "A name is only usable with permission, so get it on the spot: Mind if I mention you are getting connected Thursday when I knock the Hendersons? Most say yes, and that yes converts the next door's cold open into a warm one: Dana two doors down is getting installed Thursday — she figured you would want the same numbers. A permissioned name-drop carries the referrer's credibility to a porch you have never stood on.",
              "The rule is absolute: never drop a name you did not clear. One unauthorized name-drop, discovered over a fence conversation, travels the block faster than ten good installs — and it takes your permissioned drops down with it, because now every name you use is suspect.",
            ],
          },
          {
            heading: "Closing the neighbor from this porch",
            body: [
              "The strongest referral does not wait for your knock. If the goodwill is high, compress the distance to zero: Worth a text? Tell them the fiber guy is out front and the crew is doing the street this week. A referred door whose owner is already expecting you closes at multiples of any cold door, because the trust arrived before you did. Short of a live text, log every referral like an appointment — name, address, permission status — and knock it within 48 hours, while the referrer's install is visible, fresh news on the street. A referral knocked two weeks later is just a cold door with a stale story.",
            ],
          },
        ],
        keyTakeaways: [
          "Ask in the sixty seconds after the yes — helping a neighbor confirms their own decision was smart.",
          "Ask specifically: who complains about the bill beats anyone you know, every time.",
          "Permission the name-drop on the spot, and never use a name you did not clear.",
          "Text now or knock within 48 hours — referrals decay into cold doors.",
        ],
        drillPrompt:
          "At every close and every genuinely warm exit on your next 10 doors, ask the two-part referral question: who complains about the bill, and may I mention your name? Log names, permission status, and knock or text every referral within 48 hours.",
        quiz: [
          {
            question: "Why is the minute right after a close the best referral moment?",
            options: [
              "The paperwork requires a reference",
              "The customer is at peak goodwill, and helping a neighbor confirms their own decision was smart",
              "It is the only compliant time to ask",
              "Neighbors are usually watching",
            ],
            answerIndex: 1,
            explanation: "Post-decision goodwill is real and brief. A referral given in that window carries enthusiasm the same ask a week later cannot recover.",
          },
          {
            question: "What makes 'who on the street complains about the bill?' better than 'do you know anyone interested?'",
            options: [
              "It is shorter",
              "It avoids the word interested",
              "Specific questions search memory for a matching person; vague ones produce a polite shrug",
              "It implies the neighbors are unhappy",
            ],
            answerIndex: 2,
            explanation: "The brain answers concrete questions. Complains-about-the-bill retrieves an actual face and name; anyone-you-know retrieves nothing.",
          },
          {
            question: "What is the standing rule on name-drops?",
            options: [
              "Any customer's name may be used — installs are visible anyway",
              "Names may be used only with that person's explicit permission, obtained on the spot",
              "Names may be used after the install completes",
              "Only first names may be used freely",
            ],
            answerIndex: 1,
            explanation: "A permissioned name carries borrowed trust; an unpermissioned one is a privacy breach that travels the block and poisons every future drop.",
          },
        ],
      },
    ],
  },

  // ── M8 — Advanced Door Psychology ───────────────────────────────────────────
  {
    id: "m8",
    title: "Advanced Door Psychology",
    tagline: "The professional persuasion layer — reciprocity, consistency, proof, authority, pacing, and loss — used honestly.",
    hook: "The real levers work in daylight. If a move needs the dark, it's not one of these.",
    fieldStory:
      "A rep runs a live speed test on the homeowner's own phone, shows them the modem-rental line they forgot they pay, and says honestly, that's a good rate — I'd keep it. Costs him the sale. Buys him the street: that homeowner becomes his loudest reference because they've got proof he tells the truth against his own wallet. Every lever in this module works the same way — used straight, it compounds; faked, it burns.",
    sayThisNotThat: {
      instead: "You could save about thirty a month if you switched.",
      say: "At the bill you just told me, that's 360 a year leaving the house for the same speeds.",
    },
    lessons: [
      {
        id: "m8-reciprocity",
        title: "Reciprocity at the door: give first",
        summary: "Real value delivered before any ask — the speed check and the honest bill review.",
        minutes: 5,
        sections: [
          {
            heading: "The oldest lever, used honestly",
            body: [
              "People are wired to return what they receive — favors, information, effort. Sales abuses this with trinkets and fake gifts, and homeowners smell those instantly. The professional version is different: deliver something genuinely useful before you ask for anything. Run a speed check on their current connection right there on the porch, on their phone: Pull up a speed test — let us see what you are actually getting for that bill. Tell them what plans in the area actually cost post-promo. Point out the modem rental line they forgot they pay. Each of these is worth real money to them whether or not they ever buy from you.",
              "The give does two jobs. It creates a genuine debt of attention — people find it hard to wave off someone who just did them a favor — and it proves your frame from Module 1: you are the street's fiber consultant, and consultants deliver value on contact.",
            ],
          },
          {
            heading: "The honest bill review",
            body: [
              "The strongest give in this business is the bill review: Grab the bill sometime and I will walk you through what every line actually is — even if you never switch, you will know what you are paying for. Then do it straight. Name the fees, the rental charges, the promo expiration date, and what each one means. And if their setup is genuinely good — a real grandfathered rate, a plan that fits — say exactly that: Honestly, that is a good rate. I would keep it. That sentence costs you one sale and buys you a street. The homeowner you told to keep their plan becomes your loudest reference, because they have proof you tell the truth against your own interest.",
            ],
          },
          {
            heading: "The rules that keep it clean",
            body: [
              "Three rules. The give must be real — a gift that only exists to obligate is a setup, and it reads as one. No strings voiced, ever: I did the review, so the least you can do is hear me out cancels the entire effect and replaces debt with resentment. And reciprocity buys attention, not agreement — it earns you a fair hearing, and the product still has to win the hearing on its own. A rep who expects the favor to close the sale has misunderstood the lever.",
            ],
          },
        ],
        keyTakeaways: [
          "Give first, for real: the porch speed check and the honest bill review are worth money to them either way.",
          "If their setup is genuinely good, say so — truth against your own interest builds a street-wide reference.",
          "Never voice the string: an invoked favor cancels the debt and creates resentment.",
          "Reciprocity earns the fair hearing, not the sale — the product still has to win.",
        ],
        drillPrompt:
          "On your next 10 doors, lead every engaged conversation with one real give — a live speed test on their phone or one useful fact about local post-promo pricing — before any pitch beat. Track how many doors give you a full hearing compared to your normal rate.",
        quiz: [
          {
            question: "What separates professional reciprocity from the trinket version?",
            options: [
              "The dollar value of the gift",
              "The give is genuinely useful to the homeowner whether or not they ever buy",
              "Professionals give at the end instead of the start",
              "There is no difference — all giving obligates",
            ],
            answerIndex: 1,
            explanation: "A speed check or honest bill review has standalone value, so it reads as help. A gift that only exists to obligate reads as the setup it is.",
          },
          {
            question: "The bill review reveals the homeowner has a genuinely great grandfathered rate. What do you do?",
            options: [
              "Find something else wrong with their setup",
              "Pivot to speed pain instead",
              "Tell them plainly it is a good rate and they should keep it",
              "End the review early",
            ],
            answerIndex: 2,
            explanation: "Truth against your own interest is the most credible sentence you can say on a porch. It costs one sale and creates a reference the whole street hears.",
          },
          {
            question: "Why does saying 'after all I did, at least hear me out' destroy the reciprocity effect?",
            options: [
              "It is grammatically weak",
              "Voicing the string converts a felt debt into an invoice, and resentment replaces the urge to reciprocate",
              "It takes too long to say",
              "It does not — naming the favor strengthens it",
            ],
            answerIndex: 1,
            explanation: "Reciprocity works precisely because it is unspoken. The moment the favor is invoked as leverage, the homeowner realizes it was a purchase, not a gift.",
          },
        ],
      },
      {
        id: "m8-consistency",
        title: "Commitment and consistency: the micro-yes ladder",
        summary: "Why small agreements compound toward the close — and why trick-yeses backfire.",
        minutes: 5,
        sections: [
          {
            heading: "Small agreements compound",
            body: [
              "People act in line with what they have already said and done — contradicting your own recent steps feels wrong in a way psychologists have measured for decades. This is the engine under the micro-commitment ladder from Module 3: the one-minute address check leads to seeing the price, which leads to picking an install window. Each rung is small, and each makes the next one natural, because refusing rung four would quietly contradict rungs one through three. Nobody climbs a ladder and then argues the ladder should not exist.",
              "Notice what the ladder is not: it is not a trap. Every rung is a real, informative step — the check produces a real answer, the price is a real number, the window is a real slot. The homeowner is not being walked into anything; they are walking through a decision at a comfortable step size.",
            ],
          },
          {
            heading: "Build the ladder from their statements",
            body: [
              "Words are commitments too. Every true thing the homeowner says about their situation — yeah, the bill did the jump, and evenings are honestly rough up here — is a rung. When the close arrives, consistency is on your side, because the close follows from what they said, not from what you claimed. This is exactly why the summary close from the Closing Playbook hits: it is a consistency engine, replaying their own commitments in order until the conclusion is standing in the room.",
              "Practical habit: ask questions whose honest answers are rungs. What is the bill running now? Does it hold up at 8 p.m.? Who streams upstairs? You are not extracting yeses — you are letting them describe a situation that argues for the switch in their own voice.",
            ],
          },
          {
            heading: "Never trick-yeses",
            body: [
              "The manipulative cousin is the momentum chain: You like saving money, right? You care about your family, right? So you would want the best for them, right? Homeowners recognize the pattern by the second question, feel herded, and produce reactance — the strong urge to do the opposite of whatever the herder wants. Every trick-yes also poisons the real rungs that came before it. The rule: every micro-yes must be a step the homeowner would take knowingly, with full information. If a yes exists only to harvest compliance, cut it from the pitch.",
            ],
          },
        ],
        keyTakeaways: [
          "Small real steps compound: refusing rung four would contradict rungs one through three.",
          "Their true statements are rungs too — ask questions whose honest answers argue your case in their voice.",
          "The summary close works because it is a consistency engine replaying their own commitments.",
          "Every micro-yes must be a step they would take knowingly — compliance-harvesting yeses trigger reactance and poison the ladder.",
        ],
        drillPrompt:
          "On your next 10 doors, count rungs: every real micro-step (address check accepted, bill number shared, pain named) is one. At doors reaching three or more rungs, attempt a close that references the rungs. Log rung count against close attempts to see your ladder working.",
        quiz: [
          {
            question: "Why does agreeing to a one-minute address check make agreeing to see the price easier?",
            options: [
              "The homeowner forgets they can refuse",
              "Refusing the next small step would quietly contradict the step they just took — people act consistently with their own recent actions",
              "The check legally obligates them to continue",
              "It does not — every step is independent",
            ],
            answerIndex: 1,
            explanation: "Consistency pressure is internal, not imposed. Each real step makes the next one the natural continuation of a path they chose.",
          },
          {
            question: "Which of these is a legitimate ladder rung?",
            options: [
              "You care about your family, right?",
              "You would agree that overpaying is foolish, correct?",
              "What is the bill running these days?",
              "Everyone wants the best deal, do you not?",
            ],
            answerIndex: 2,
            explanation: "The bill question invites a true, informative statement about their situation. The others are compliance-harvesting yeses that homeowners recognize and resent.",
          },
          {
            question: "What does a trick-yes chain produce by the second or third question?",
            options: [
              "Momentum toward the close",
              "Reactance — the felt urge to do the opposite of what the herder wants — plus contamination of every real step before it",
              "Confusion that slows the decision",
              "A stronger commitment than real questions",
            ],
            answerIndex: 1,
            explanation: "Being herded is unmistakable. The homeowner pushes back against the herding itself, and retroactively distrusts the genuine agreements that preceded it.",
          },
        ],
      },
      {
        id: "m8-social-proof-mechanics",
        title: "Social proof mechanics: specific beats general",
        summary: "The 3-neighbor rule, showing instead of telling, and the proof-inflation trap.",
        minutes: 5,
        sections: [
          {
            heading: "The 3-neighbor rule",
            body: [
              "Module 3 established that proof shrinks with distance. The mechanics layer adds a number: one neighbor is an anecdote, three is a pattern. A single install can be a fluke or a brother-in-law deal; three on the same street means the street is deciding. So before working a block, arm yourself with three true, street-level proof points — two installs on the cul-de-sac, the corner house holding 900 up and down on last week's test, eight address checks completed on the loop yesterday. Deliver them as a set when the moment calls for weight: That is three on this street this month. The homeowner is not being asked to be first, and not-first is where most buyers live.",
            ],
          },
          {
            heading: "Show, do not tell",
            body: [
              "A proof the homeowner can see with their own eyes from the porch outranks any sentence you can say. Point at the visible drop line on the corner house. Nod at the crew truck staged at the end of the street. Run the speed test live on your tablet instead of quoting the result. Physical evidence bypasses the salesperson filter entirely, because their eyes are not listening to a pitch — they are just seeing. Build the habit: for every claim you make on a block, ask yourself whether there is a version of it the homeowner can see, and use that version.",
            ],
          },
          {
            heading: "Failure modes and proof inflation",
            body: [
              "Three ways proof dies. Vague proof — lots of people are switching — is categorized as sales noise and discarded on contact. Unpermissioned specifics about individuals burn the block, per the standing rule. Distant proof — another town, another state, a national statistic — carries near-zero porch weight no matter how impressive the number. And above all: proof inflation. Round eight checks up to twenty once, get caught by a homeowner who talks to their neighbors — and every true number you say afterward gets discounted like a currency nobody trusts. Your proof inventory only works if every item in it survives a fence-line conversation between neighbors.",
            ],
          },
        ],
        keyTakeaways: [
          "One neighbor is an anecdote, three is a pattern — arm yourself with three true street-level proof points per block.",
          "Visible proof bypasses the salesperson filter: point at the drop line, run the test live, nod at the crew truck.",
          "Vague, distant, or unpermissioned proof carries no weight or negative weight.",
          "Never inflate: one caught exaggeration discounts every true number you say afterward.",
        ],
        drillPrompt:
          "Before your next 10 doors, write down three true proof points for that exact block and identify one piece of visible evidence you can physically point at. Use the set at every engaged door and note which form — the count, the name, or the pointed finger — moves people most.",
        quiz: [
          {
            question: "Why is three the magic number in the 3-neighbor rule?",
            options: [
              "Three fits in a short sentence",
              "One install reads as a fluke; three reads as the street deciding — and joining is easier than going first",
              "Compliance limits proof claims to three",
              "Three is easier to remember than four",
            ],
            answerIndex: 1,
            explanation: "Most buyers do not want to be first. A pattern of three makes saying yes an act of joining rather than pioneering.",
          },
          {
            question: "What makes pointing at the corner house's visible drop line stronger than describing the same install?",
            options: [
              "Pointing is more dramatic",
              "It proves you know the neighborhood",
              "Seen evidence bypasses the salesperson filter — eyes do not audit claims the way ears do",
              "It saves pitch time",
            ],
            answerIndex: 2,
            explanation: "Spoken claims get processed through skepticism; physical evidence is simply perceived. When a see-able version of a claim exists, use it.",
          },
          {
            question: "You did eight address checks yesterday but twenty sounds better. What does proof inflation actually cost?",
            options: [
              "Nothing, if the trend is real",
              "A slightly awkward moment if questioned",
              "Only that one claim's credibility",
              "Every future true number you say gets discounted once one inflated number is caught",
            ],
            answerIndex: 3,
            explanation: "Neighbors compare notes over fences. One caught exaggeration reprices all your claims at a discount — eight, said honestly, outperforms twenty said falsely.",
          },
        ],
      },
      {
        id: "m8-authority-signals",
        title: "Authority and credibility signals",
        summary: "What the porch reads in two seconds, competence talk, and the one sentence that ends it all.",
        minutes: 5,
        sections: [
          {
            heading: "What the porch reads in two seconds",
            body: [
              "Before a word lands, the homeowner has already priced your authority from signals: a badge they can read without asking, a clean uniform or branded shirt, a tablet held like a tool rather than a phone held like a distraction, posture that is settled instead of shifty. These are processed pre-verbally, the same channel as the threat assessment from Module 2, and they either open a credibility account or start you in debt.",
              "Then there is borrowed authority, and it is real: you represent the carrier building the street. The crews, the network operations center, the install calendar — that entire operation stands behind your sentences. Speak with its calm. The crew wraps this street Friday is a report from an organization, not a claim from a stranger, and homeowners hear the difference in reps who believe it.",
            ],
          },
          {
            heading: "Competence talk",
            body: [
              "Nothing signals authority like precise local knowledge. Knowing which houses on the street are already lit, what the construction schedule actually is, and what local cable bills run post-promo — two precise, checkable local facts outrank any credential you could carry. This is competence the homeowner can verify from their own porch, which makes it the only kind that fully lands.",
              "The counterintuitive signal: I do not know — I will find out and text you today. Calibrated uncertainty, delivered without flinching, is itself an authority marker, because experts know the edges of their knowledge and frauds do not. Bluffing an answer is the opposite signal, and one bluff discovered retroactively converts everything else you said into suspected bluffs.",
            ],
          },
          {
            heading: "What destroys credibility instantly",
            body: [
              "Credibility is asymmetric: built over minutes, destroyed in one sentence, and it does not rebuild on the same porch. The instant killers: one exaggerated number, a direct question dodged, visible pushiness after a no, a badge flipped backward or hidden, and the classic self-inflicted wound — opening with I am not selling anything when you visibly are. That last one deserves its own mention because reps reach for it under pressure: it trades the entire interaction's trust for two seconds of lowered guard, and the homeowner spends the rest of the conversation confirming that you lied in your first sentence.",
            ],
          },
        ],
        keyTakeaways: [
          "The porch prices your authority pre-verbally: readable badge, clean kit, tablet as tool, settled posture.",
          "Borrowed authority is real — speak with the calm of the operation behind you.",
          "Two precise, locally checkable facts outrank any credential; calibrated I-do-not-know outranks any bluff.",
          "Credibility is asymmetric: one exaggeration, dodge, or I-am-not-selling-anything ends it for good on that porch.",
        ],
        drillPrompt:
          "Before your next 10 doors, run a 30-second kit check — badge readable, shirt straight, tablet charged — and memorize two precise facts about that street: which addresses are lit and the local post-promo bill range. Deliver both facts at every engaged door and never answer a question you are not sure of without flagging it.",
        quiz: [
          {
            question: "Why do two precise local facts outrank a credential or award?",
            options: [
              "Credentials are usually fake",
              "Local facts are checkable from the homeowner's own porch, so the competence fully lands",
              "Facts are shorter to say",
              "Homeowners dislike institutions",
            ],
            answerIndex: 1,
            explanation: "Verifiable-from-here beats impressive-from-far. The homeowner can test street knowledge instantly, and passing that test authorizes everything else you say.",
          },
          {
            question: "A homeowner asks a technical question you cannot answer. What is the authority-preserving move?",
            options: [
              "Give your best guess confidently — hesitation looks weak",
              "Change the subject to savings",
              "Say you do not know, commit to finding out, and follow through the same day",
              "Refer them to the website",
            ],
            answerIndex: 2,
            explanation: "Experts know the edges of their knowledge. Calibrated uncertainty plus same-day follow-through signals professionalism; one discovered bluff reprices your entire pitch.",
          },
          {
            question: "Why is 'I am not selling anything' uniquely self-destructive?",
            options: [
              "It violates disclosure law in most states",
              "It confuses the homeowner about your role",
              "It wastes the pattern-interrupt window",
              "It is a visible lie in your first sentence — the homeowner spends the rest of the conversation confirming you lied",
            ],
            answerIndex: 3,
            explanation: "The homeowner can see the badge and the tablet. Trading permanent trust for two seconds of lowered guard is the worst exchange rate on the porch.",
          },
        ],
      },
      {
        id: "m8-mirroring-pacing",
        title: "Mirroring and pacing without mimicry",
        summary: "Match cadence, register, and their words for things — never their gestures in real time.",
        minutes: 5,
        sections: [
          {
            heading: "Why matching works",
            body: [
              "People relax around what feels familiar, and nothing feels more familiar than their own rhythm. Matching a homeowner's speaking pace, volume, and formality quiets the stranger-alarm that every doorstep interaction starts with. This is the full version of match-then-lead from Module 2: tone was the melody; mirroring and pacing extend it to the body, the sentence length, and the vocabulary. Match first so they relax, then lead the exchange toward calm and unhurried — the state where decisions happen.",
            ],
          },
          {
            heading: "What to match",
            body: [
              "Match the pace of speech: slow talkers experience fast talkers as pressure, fast talkers experience slow ones as dim. Match sentence length — clipped speakers get clipped answers, storytellers get a little room. Match the formality register: a yes-sir porch and a hey-man porch are different countries, and the border matters. Match posture in broad strokes: leaning relaxed if they are relaxed, upright if they are formal. And most powerfully, match their words for things. If they say wifi, say wifi — not bandwidth. If they said it crawls at night, bridge with their phrase: that crawl at night is the shared line — that is the thing fiber removes. Hearing their own words come back means being heard, and being heard is half the sale.",
            ],
          },
          {
            heading: "The mimicry line",
            body: [
              "There is a line, and crossing it reverses everything. Copying gestures in real time — they cross their arms, you cross yours — reads as mockery within seconds. Faking an accent or adopting their slang mid-conversation is worse. The safe discipline is delay and dilute: shift your overall register toward theirs and let specific moves go unmatched. The test is where your attention sits. Matching should run on attention to them — genuinely listening produces natural alignment on its own. If you are consciously choreographing your hands, you have crossed from rapport into performance, and performances get detected.",
            ],
          },
        ],
        keyTakeaways: [
          "Match pace, volume, sentence length, and formality first — then lead toward calm.",
          "Use their words for things: wifi, not bandwidth; their phrase for the pain, replayed in the bridge.",
          "Delay and dilute: shift your general register, never copy specific gestures in real time.",
          "Real listening produces natural alignment; conscious choreography is performance, and it gets detected.",
        ],
        drillPrompt:
          "On your next 10 doors, capture the homeowner's exact phrase for their pain and use that phrase — word for word — once in your bridge or close. Separately, note each door's register (formal or casual) and whether you matched it in your first two sentences.",
        quiz: [
          {
            question: "What is the legitimate core of mirroring at a door?",
            options: [
              "Copying the homeowner's gestures as they make them",
              "Matching pace, register, and vocabulary so the interaction feels familiar, then leading toward calm",
              "Agreeing with everything they say",
              "Imitating their regional accent",
            ],
            answerIndex: 1,
            explanation: "Familiar rhythm quiets the stranger-alarm. Real-time gesture copying and accent imitation are mimicry — they read as mockery and reverse the effect.",
          },
          {
            question: "The homeowner says their internet 'crawls at night.' What is the highest-rapport bridge?",
            options: [
              "Our bandwidth degradation is significantly lower",
              "That crawl at night is the shared line — that is exactly what fiber removes",
              "Everyone says that about cable",
              "Define the technical cause of congestion first",
            ],
            answerIndex: 1,
            explanation: "Replaying their own phrase proves you heard them, and being heard is half the sale. Translating their words into your jargon proves the opposite.",
          },
          {
            question: "How do you know you have crossed from matching into mimicry?",
            options: [
              "The conversation gets longer",
              "The homeowner matches you back",
              "Your attention has moved from listening to them to choreographing yourself",
              "You start using their name",
            ],
            answerIndex: 2,
            explanation: "Genuine attention produces natural alignment for free. The moment matching becomes a performance you are managing, it becomes detectable — and mockery is how it lands.",
          },
        ],
      },
      {
        id: "m8-loss-framing",
        title: "Loss framing done honestly",
        summary: "What staying on copper actually costs — and the rules that keep the frame out of fear-mongering.",
        minutes: 5,
        sections: [
          {
            heading: "Losses weigh double",
            body: [
              "Decades of research agree on one asymmetry: losing something weighs roughly twice as much as gaining the same thing. You are losing 30 a month moves people that you could save 30 a month does not — same arithmetic, different gravity. Used honestly, loss framing is not manipulation; it is accurate accounting. The homeowner on a post-promo cable bill genuinely is losing money every month relative to the fiber price on their street. Saying so plainly is truer than the polite gain-frame, not less true.",
            ],
          },
          {
            heading: "What staying on copper actually costs",
            body: [
              "Do the real arithmetic, from their own numbers. The 30-a-month overpay they told you about is 360 a year — leaving the house every year, for the same speeds. The 15-a-month modem rental is 180 a year for a box they could own. The evening slowdown they named is a cost they are already paying nightly in the currency of household friction. And the upload starvation of copper has a quiet price too: cloud backups that never finish, video calls that freeze on their end. Frame only from pains they voiced or numbers they gave you — the loss frame borrows all its honesty from the summary-close rule: their words, their bill, their evenings.",
            ],
          },
          {
            heading: "The line you never cross",
            body: [
              "Loss framing becomes fear-mongering the moment the loss is invented, inflated, or aimed at safety. Copper is dangerous, your provider is about to go under, this neighborhood is getting left behind — none of it leaves your mouth, ever, true or not, because fear closes exactly the deals that cancel and complain. Three framing rules that never bend: only losses the homeowner can verify on their own bill or in their own evenings; state the frame once and let it sit — a repeated loss frame becomes a pressure campaign; and if the frame needs a raised voice or a darkened tone to work, it is not framing anymore. The loss frame is an accountant's move, delivered like an accountant: flat, factual, and once.",
            ],
          },
        ],
        keyTakeaways: [
          "Losses weigh about double gains: losing 30 a month moves people that saving 30 does not.",
          "Compute the real annual cost of staying — overpay, rental, nightly friction — from their own numbers only.",
          "State the loss frame once, flatly, and let it sit; repetition converts framing into pressure.",
          "Invented, inflated, or safety-aimed losses are fear-mongering — they close deals that cancel and complain.",
        ],
        drillPrompt:
          "On your next 10 engaged doors, after the homeowner gives you their bill number, deliver one honest loss frame built from it — that is X a year leaving the house for the same speeds — exactly once, in a flat accountant's tone. Log whether the door engaged deeper or pulled back, and adjust nothing else.",
        quiz: [
          {
            question: "Why does 'you are losing 30 a month' outperform 'you could save 30 a month'?",
            options: [
              "It is more polite",
              "Losses psychologically weigh about twice as much as equivalent gains",
              "It implies the provider is cheating them",
              "It does not — gain frames always test better",
            ],
            answerIndex: 1,
            explanation: "Loss aversion is one of the most replicated findings in decision research. Same arithmetic, roughly double the motivational weight.",
          },
          {
            question: "Which loss frame stays on the honest side of the line?",
            options: [
              "Copper networks are becoming a safety risk",
              "This neighborhood is getting left behind",
              "At the bill you just told me, that is 360 a year leaving the house for the same speeds",
              "Your provider probably will not exist in five years",
            ],
            answerIndex: 2,
            explanation: "It is built from their own stated number and verifiable on their own bill. The others are invented or safety-aimed fears — the definition of crossing the line.",
          },
          {
            question: "How many times should a loss frame be stated at one door?",
            options: [
              "Once, flatly, then let it sit",
              "At every beat of the pitch for reinforcement",
              "Twice — once early, once at the close",
              "Until the homeowner acknowledges it",
            ],
            answerIndex: 0,
            explanation: "A loss frame stated once is accounting; repeated, it becomes a pressure campaign, and the homeowner starts defending against you instead of weighing the math.",
          },
        ],
      },
    ],
  },

  // ── M9 — Pitch Styles and Situations ────────────────────────────────────────
  {
    id: "m9",
    title: "Pitch Styles and Situations",
    tagline: "Four deployable pitch styles, the context playbook, and the two-buyer door.",
    hook: "One product, four pitches, every kind of door. Pick the tool, don't force one.",
    fieldStory:
      "The door's already closing as it opens — homeowner mid-call, one foot back inside. A rookie launches the full pitch into the gap and gets nothing. The pro fires one built-in line: ten seconds — fiber went live on this street, most folks are cutting about thirty. The door stops. That's not luck. That's having the right pitch pre-loaded for the door in front of you instead of the door you wish you had.",
    sayThisNotThat: {
      instead: "Hi, do you have a few minutes to hear about our fiber service?",
      say: "Ten seconds: fiber's live on this street and most folks are cutting the bill by about thirty.",
    },
    lessons: [
      {
        id: "m9-analyst-pitch",
        title: "The analyst pitch: numbers first",
        summary: "The full pitch build for spreadsheet people — comparison, fine print, and homework that converts.",
        minutes: 5,
        sections: [
          {
            heading: "Reading the spreadsheet person",
            body: [
              "You met the analytical archetype in Module 4; this is the complete pitch built for them. The tells are unmistakable: precise answers to your questions, unprompted interest in terms and fine print, exact figures instead of roughly, and a visible allergy to enthusiasm. This homeowner does not want to be sold — they want to be given inputs. The analyst pitch is the discipline of becoming a clean data source.",
            ],
          },
          {
            heading: "The structure: comparison, fine print, writing",
            body: [
              "Lead with the comparison, not the story. Current bill next to fiber price, line by line: base rate, equipment, the promo expiration and what the rate becomes after it. Volunteer the fine print before they ask — term length, install cost, whether the price is fixed, no data caps — because fine print you surface is transparency, while fine print they extract is concealment. Offer everything in writing: analysts trust documents over conversations, and the rep willing to be held to paper is the rep whose numbers are real.",
              "Slow your pace by another notch and let silences sit while they read or compute — an analyst doing math is a door converting, and interrupting the math is overtalking. One exaggeration, even a small rounded-up one, ends the door permanently: this is the one archetype guaranteed to check.",
            ],
          },
          {
            heading: "Closing an analyst: assign the homework",
            body: [
              "Analysts close themselves when the math is undeniable — your close is a numbers summary plus a low-pressure verification step: Run the one-minute check, take the sheet, and hold it against your actual bill tonight. I am back on this street tomorrow evening. Pushing tempo on an analyst reads as a reason to distrust the numbers; assigning verification homework reads as confidence in them. The analyst who checks your numbers and finds them right becomes your most durable customer and your most quotable proof point — accurate people vouch precisely.",
            ],
          },
        ],
        keyTakeaways: [
          "Analysts want inputs, not persuasion — become a clean data source.",
          "Volunteer the fine print before it is asked for: surfaced fine print is transparency, extracted fine print is concealment.",
          "Let silences sit while they compute; interrupting the math is overtalking.",
          "Close with a verification step, not tempo — an analyst who checks your numbers and finds them right stays for years.",
        ],
        drillPrompt:
          "Build a one-page comparison sheet for your current street: local post-promo bill range, fiber price, equipment, term, and the fine print. On your next 10 doors, hand it to every analytical read, volunteer one piece of fine print unprompted, and offer the check-it-tonight close. Log how many ask a follow-up question — that is the analyst engaging.",
        quiz: [
          {
            question: "Why volunteer the fine print before an analyst asks?",
            options: [
              "It fills time while they think",
              "Fine print you surface reads as transparency; fine print they have to extract reads as concealment",
              "It is legally required at the door",
              "It prevents them from reading the contract later",
            ],
            answerIndex: 1,
            explanation: "Analysts assume hidden terms until shown otherwise. Surfacing the term, fees, and rate behavior unprompted converts their core suspicion into your credibility.",
          },
          {
            question: "The analyst goes quiet, staring at your comparison sheet. What do you do?",
            options: [
              "Recap the key numbers so they stay engaged",
              "Ask if everything is okay",
              "Let the silence sit — they are computing, and the math is your close working",
              "Move to the emotional benefits",
            ],
            answerIndex: 2,
            explanation: "An analyst doing arithmetic is a door converting. Interrupting hands them a reason to restart — this is the overtalking failure in its analyst-specific form.",
          },
          {
            question: "What is the correct close for an analytical homeowner?",
            options: [
              "Create urgency so they decide before overthinking",
              "The assumptive close, immediately",
              "Repeat the savings number with more enthusiasm",
              "A numbers summary plus verification homework: check the sheet against your bill tonight, I am back tomorrow",
            ],
            answerIndex: 3,
            explanation: "Tempo pressure reads as distrust-my-numbers. Inviting verification signals the numbers survive scrutiny — and an analyst who verifies becomes your most durable customer.",
          },
        ],
      },
      {
        id: "m9-story-pitch",
        title: "The story pitch: the neighbor narrative",
        summary: "A 30-second true story with a character, a problem, a turn, and an ending on their porch.",
        minutes: 5,
        sections: [
          {
            heading: "Why stories carry",
            body: [
              "For the relators and expressives of Module 4, data slides off and narrative sticks. A story smuggles the same facts past the salesperson filter because brains process stories as experience, not as claims. The doorstep story has four beats and a hard time cap: a character (the neighbor two streets over), a problem (the 8 p.m. buffering fights, the bill that hit 110), a turn (the Thursday install), and an ending (what actually changed at their house). Thirty to forty-five seconds, total. Any longer and the story stops working and starts costing.",
            ],
          },
          {
            heading: "Build a true story bank",
            body: [
              "Collect two or three real install stories per area, permissioned the same way as name-drops. Detail is what makes a story land: the install that finished before the school pickup, the kid whose game nights stopped lagging, the household that watched the bill drop 40 from the promo-cliff rate. Log the details while they are fresh — a story bank is field equipment, as real as your tablet.",
              "Never invent one. An invented story collapses under a single follow-up question — which house was that? — and takes your real stories down with it. If you are new and have no stories yet, borrow honestly from the team: My teammate installed a family on Hawthorne last week — and here is what they told him.",
            ],
          },
          {
            heading: "Landing the story",
            body: [
              "End the arc on their porch, not in the past: That is three houses on this loop now. The check takes a minute — want to see your address? The story built the feeling; the close converts the feeling into a step while it is warm. Two failure modes to watch. Story sprawl: at ninety seconds you are no longer a storyteller, you are the porch bore, and the door glazes over. And archetype mismatch: telling a story to a driver who wanted the point in one line is how you lose a door that a single sentence would have won. The story pitch is a tool for relators — read the archetype first.",
            ],
          },
        ],
        keyTakeaways: [
          "Four beats, 30 to 45 seconds: character, problem, turn, ending — then stop.",
          "Build a permissioned, true story bank per area; detail is what makes stories land.",
          "Never invent a story — one follow-up question collapses it and everything else you said.",
          "End the arc on their porch with the micro-commitment, and never story-pitch a driver.",
        ],
        drillPrompt:
          "Write out your best true install story in exactly four sentences — character, problem, turn, ending — and time it under 45 seconds out loud. On your next 10 doors, deliver it at every relator-read door and end every telling with the address-check ask. Log which detail made eyes change.",
        pitchDrill:
          "Record your best true install story in four beats and time it under 45 seconds: character (the neighbor two streets over), problem (the 8 p.m. buffering fights, the bill that hit 110), turn (the Thursday install), ending (what actually changed at their house). Land it on their porch: \"That's three houses on this loop now. The check takes a minute — want to see your address?\" Play it back. Past 45 seconds you're the porch bore; if one concrete detail made you lean in even on playback, keep it.",
        quiz: [
          {
            question: "Why does a story move a relator when the same facts as bullet points do not?",
            options: [
              "Stories are longer and feel more thorough",
              "Brains process narrative as experience rather than claims, so the facts bypass the salesperson filter",
              "Relators cannot follow numbers",
              "Stories are harder to interrupt",
            ],
            answerIndex: 1,
            explanation: "A claim gets audited; a story gets lived. The same savings number lands differently inside a neighbor's narrative than inside a pitch beat.",
          },
          {
            question: "What is the hard time cap on a doorstep story, and why?",
            options: [
              "Three minutes — enough for full context",
              "Ten seconds — attention spans demand it",
              "There is no cap if the story is good",
              "About 45 seconds — beyond that the storyteller becomes the porch bore and the door glazes",
            ],
            answerIndex: 3,
            explanation: "The story is a vehicle for one feeling and one close. Past 45 seconds it stops carrying and starts costing the attention you won.",
          },
          {
            question: "You have no install stories of your own yet. What does the lesson prescribe?",
            options: [
              "Compose a plausible one — nobody checks",
              "Skip story pitching until you close your own installs",
              "Borrow honestly from the team, attributed: my teammate installed a family on Hawthorne last week",
              "Use a story from another city",
            ],
            answerIndex: 2,
            explanation: "Attributed borrowing keeps the story true and checkable. Invented stories collapse at the first which-house question, and distant stories carry no porch weight.",
          },
        ],
      },
      {
        id: "m9-demo-pitch",
        title: "The demo pitch: seeing is believing",
        summary: "A live speed test outperforms every claim — if the stagecraft is rehearsed.",
        minutes: 5,
        sections: [
          {
            heading: "A demo beats a claim",
            body: [
              "Every pitch beat is a claim the homeowner must decide whether to believe. A demo removes the decision: run a live speed test on your tablet on the fiber network, next to one on their phone over their own wifi, and let the two numbers sit side by side. The gap sells silently — no adjective you own is as loud as their 43 next to your 940. Demos are the native language of skeptics and show-me people: the doors that distrust talk are precisely the doors a demo wins.",
            ],
          },
          {
            heading: "Stagecraft rules",
            body: [
              "A demo is theater and theater is preparation. Set up before the porch: test app loaded, tablet charged, connection verified, one tap from running. Narrate what they are watching, because raw numbers do not explain themselves: That top number is download — and watch upload, that is the one copper starves. Cable gives you a tenth of that on a good night. Then the highest-leverage move: hand them the tablet. Run it yourself, they watched a demo; run it in their hands, they did it — and touch creates ownership the same way the puppy-dog frame does.",
              "Invite the comparison on their device too: Pull up the same test on your phone right now. Their own hardware producing the sad number closes the credibility gap completely — you did not even supply the evidence.",
            ],
          },
          {
            heading: "When demos fail",
            body: [
              "A fumbled demo is worse than no demo: the rep pecking at a frozen tablet is a live metaphor for the thing they are selling. Rehearse the tap sequence like a line of script, and have the fallback ready — a screenshot of last week's test at the corner house, dated and named. Demo only what reproduces at their address: showing gigabit speeds their address cannot get yet is a lie with a progress bar. And read the archetype: a driver in a hurry does not want your theater — for them the demo is one sentence, the number, and the ask. The demo pitch is for skeptics with two minutes, not sprinters with none.",
            ],
          },
        ],
        keyTakeaways: [
          "A demo removes the believe-or-not decision — the gap between their number and yours sells silently.",
          "Prepare to one tap, narrate what they are seeing, and hand them the tablet: touch creates ownership.",
          "A fumbled demo is a live metaphor against you — rehearse the sequence and carry a dated fallback screenshot.",
          "Demo only what reproduces at their address, and never make a hurried driver sit through theater.",
        ],
        drillPrompt:
          "Rehearse your demo to a single tap and a 15-second narration, then run it on your next 10 engaged doors — handing the tablet over every time and inviting the same test on their phone. Log the two numbers each door saw and how many doors advanced to the address check afterward.",
        quiz: [
          {
            question: "Why does a live side-by-side speed test outperform the same numbers spoken aloud?",
            options: [
              "Screens are more entertaining than talk",
              "Spoken numbers are claims to audit; seen numbers are just perceived — the demo removes the believe-or-not decision",
              "Speed tests are more accurate in person",
              "It slows the conversation down usefully",
            ],
            answerIndex: 1,
            explanation: "The demo converts your strongest claim into the homeowner's own observation, and nobody argues with what they watched happen on their own porch.",
          },
          {
            question: "Why hand the homeowner the tablet instead of running the test yourself?",
            options: [
              "It frees your hands for the paperwork",
              "It proves the tablet is not rigged",
              "Touch creates ownership — run it yourself and they watched a demo; run it in their hands and they did it",
              "It is a politeness convention",
            ],
            answerIndex: 2,
            explanation: "Participation converts an audience into an actor. The same psychology that powers the puppy-dog frame starts working the moment the device is in their hands.",
          },
          {
            question: "What makes a fumbled demo worse than no demo at all?",
            options: [
              "It wastes shift time",
              "The frozen tablet becomes a live metaphor for the product you are selling",
              "It voids the speed guarantee",
              "Homeowners report fumbled demos",
            ],
            answerIndex: 1,
            explanation: "You are selling fast, reliable technology while visibly wrestling slow, unreliable technology. Rehearse to one tap and carry the dated fallback screenshot.",
          },
        ],
      },
      {
        id: "m9-ten-second-pitch",
        title: "The 10-second pitch for the closing door",
        summary: "One complete, honest line that earns ten more seconds — and plants a seed when it does not.",
        minutes: 4,
        sections: [
          {
            heading: "One line that earns ten more seconds",
            body: [
              "Some doors are closing as they open — the homeowner is mid-task, mid-call, or mid-brush-off, and the window is one sentence wide. The 10-second pitch is that sentence, built in advance: Ten seconds: fiber went live on this street and most folks are cutting the bill by about 30 — that is the whole pitch. Naming the time cap and honoring it is the move; a rep who visibly respects their time is the rare rep who might deserve more of it. The line does not try to sell — it tries to earn the next ten seconds.",
            ],
          },
          {
            heading: "The construction",
            body: [
              "One local fact plus one number plus a full stop. No greeting, no company preamble, no how-are-you-today — the closing door has no budget for throat-clearing. And no question at the end: a question demands an answer and demanding anything from a closing door speeds it up. The question comes only if the door stops moving. Rehearse the line until it runs at conversational speed on autopilot, because you get exactly one take, usually while the door is in motion, and a fumbled version of it is just noise.",
            ],
          },
          {
            heading: "After the line",
            body: [
              "Two outcomes. The door pauses: now ask the smallest question you own — worth a minute for the actual number at your address? You have been granted ten more seconds; spend them on the micro-commitment, not on beats you skipped. Or the door keeps closing: finish warm — no problem, have a good one — and log the door for the next pass. Do not chase, do not raise your voice through the gap, do not treat the close as a loss. A clean 10-second line delivered with a warm exit is a planted seed, and Module 3's block math says you will be back on this street when the promo cliff hits their bill.",
            ],
          },
        ],
        keyTakeaways: [
          "Build the line in advance: one local fact, one number, full stop — no greeting, no question.",
          "Name the time cap and honor it; respecting their ten seconds is what earns the next ten.",
          "If the door pauses, ask only the micro-commitment; if it closes, exit warm and log for the next pass.",
          "Rehearse to autopilot — you get one take, usually against a moving door.",
        ],
        drillPrompt:
          "Write your 10-second line — local fact, number, full stop — and time it under ten seconds out loud. On your next 10 doors, deliver it the instant any door starts to close, and log the result: paused, closed warm, or closed cold. Two pauses out of ten means the line is working.",
        pitchDrill:
          "Record your 10-second line and time it hard: one local fact, one number, full stop. \"Ten seconds: fiber went live on this street and most folks are cutting the bill by about 30 — that's the whole pitch.\" No greeting, no company preamble, no question at the end. Play it back — it has to run at conversational speed on autopilot, because at a closing door you get exactly one take against a moving door. If it's over ten seconds or ends on an upswing, run it again.",
        quiz: [
          {
            question: "Why does the 10-second pitch end with a full stop instead of a question?",
            options: [
              "Questions are impolite to strangers",
              "A question demands an answer, and demanding anything from a closing door speeds up the close",
              "It is faster to say",
              "Statements are more memorable than questions",
            ],
            answerIndex: 1,
            explanation: "The line is a gift of information with no bill attached. The question is only earned — and only asked — if the door stops moving.",
          },
          {
            question: "The door pauses after your line. What do you spend the granted seconds on?",
            options: [
              "The full four-beat pitch skeleton, quickly",
              "Your credibility beat, since they do not know you",
              "The micro-commitment: worth a minute for the actual number at your address?",
              "A story from the street",
            ],
            answerIndex: 2,
            explanation: "Ten more seconds funds exactly one small ask. The address check converts the pause into a real conversation; a compressed monologue converts it back into a closing door.",
          },
          {
            question: "The door closes anyway, mid-line. What did the pitch accomplish?",
            options: [
              "Nothing — the door was a loss",
              "It planted a seed: a respectful line plus a warm exit leaves the door workable on the next pass",
              "It disqualified the address permanently",
              "It counts as a completed pitch for your funnel",
            ],
            answerIndex: 1,
            explanation: "Blocks get worked in passes, and promo cliffs arrive on schedule. The rep who left warm at ten seconds is the rep whose knock gets answered next month.",
          },
        ],
      },
      {
        id: "m9-context-playbook",
        title: "The time-of-day and context playbook",
        summary: "Morning doors, dinner-hour doors, weekend porches, and bad weather as an ally.",
        minutes: 5,
        sections: [
          {
            heading: "Morning, afternoon, dinner hour",
            body: [
              "The same door is three different doors across a day. Mornings belong to retirees, remote workers, and parents post-school-run: answer rates are lower but conversations run longer and calmer — lead softer, budget more time per door, and let the amiable pace breathe. Early afternoons are thin on decision-makers; spend them on callbacks, referral knocks, and note-drops rather than burning fresh doors into empty houses. The dinner hour, roughly five to seven-thirty, is the paradox window: the highest decision-maker density of the weekday and the highest interruption cost. Work it compressed: acknowledge the hour in your first breath — I can tell it is dinner time, twenty seconds — and prefer booking a return over forcing a full pitch into a kitchen-timer window.",
            ],
          },
          {
            heading: "Weekends and porches",
            body: [
              "Saturday morning is the best pitch real estate of the week: both decision-makers home, no commute clock, and the joint-decision problem from the spouse objection solves itself at the door. Protect those hours for your best blocks. Sunday runs slower and later — start after the late morning and keep the register softer. And porch-sitters, any day, are a different species of door entirely: the door is already open and the threat assessment is half done. Do not knock — approach as a passerby, angled, unhurried: Saw you out enjoying the evening — you have probably seen the fiber crews up the street. The porch conversation starts warmer than any knock can.",
            ],
          },
          {
            heading: "Bad weather as an ally",
            body: [
              "Rain thins every competing solicitor off the street and buys you a sympathy read: a rep working politely in weather registers as serious, not casual. Use it — I will be quick, it is ugly out — and watch doors open that would not have on a sunny Tuesday. The disciplines that keep weather working for you: shorten every pitch, keep materials dry and the tablet sleeved, and never drip on the threshold — step back a touch further than usual. In heat, work the shaded side of the street, respect the early-afternoon lull, and carry water; a visibly wilting rep signals desperation, which is the one read no weather excuses.",
            ],
          },
        ],
        keyTakeaways: [
          "Mornings: fewer answers, longer calmer talks. Early afternoons: callbacks and referrals, not fresh doors.",
          "Dinner hour is peak decision-makers at peak interruption cost — compress, acknowledge the meal, book returns.",
          "Saturday morning is the week's best window; porch-sitters get the passerby approach, never a knock.",
          "Weather thins competitors and earns sympathy — shorten the pitch, protect the kit, never drip on the porch.",
        ],
        drillPrompt:
          "Split your next shift into labeled blocks — morning, afternoon, dinner hour — and match the work to the window: fresh doors in the morning, callbacks midafternoon, compressed twenty-second openers with return-booking after five. Log conversations per hour by block and compare against your normal unplanned day.",
        quiz: [
          {
            question: "What is the right use of the early-afternoon lull?",
            options: [
              "Fresh doors — volume matters most",
              "A long break to preserve energy",
              "Callbacks, referral knocks, and note-drops — decision-maker density is too low to burn fresh doors",
              "Switching neighborhoods entirely",
            ],
            answerIndex: 2,
            explanation: "Fresh doors knocked into empty houses are wasted inventory. The lull is made for the follow-up work that pays at appointment rates.",
          },
          {
            question: "How do you approach a homeowner sitting on their porch?",
            options: [
              "Knock on the door frame to signal formality",
              "As a passerby — angled, unhurried, referencing the visible street work — since the threat assessment is already half done",
              "Wait until they go inside, then knock properly",
              "Skip them — porch sitters do not buy",
            ],
            answerIndex: 1,
            explanation: "The open door and visible person mean the coldest part of the interaction is already over. A knock would formalize what is warmer as a passing conversation.",
          },
          {
            question: "Why can rain genuinely improve door outcomes?",
            options: [
              "Homeowners are bored indoors",
              "Wet reps get invited inside",
              "Speeds test better in cool weather",
              "It clears competing solicitors and a rep working politely in weather reads as serious rather than casual",
            ],
            answerIndex: 3,
            explanation: "Scarcity of solicitors plus the sympathy read opens doors sunshine does not — provided the pitch shortens and the kit stays dry.",
          },
        ],
      },
      {
        id: "m9-two-buyers",
        title: "Multi-decision-maker doors",
        summary: "Two people, one pitch, two channels — and the spouse-alignment move that closes both.",
        minutes: 5,
        sections: [
          {
            heading: "Two people, one pitch, two channels",
            body: [
              "When two adults share the doorway, you are delivering one pitch to two different archetypes simultaneously — often a driver and an amiable, or an analyst and a relator. The cardinal error is pitching past the quieter one. Reps naturally lock onto whoever talks, but the silent partner kills more deals than the vocal skeptic: they were never engaged, so their default no costs you the sale in the kitchen an hour after you leave. Split your eye contact roughly evenly, direct at least one question to the quieter person by name if you have it, and watch their face at your numbers — their reaction is data the talker will consult later.",
            ],
          },
          {
            heading: "The spouse-alignment move",
            body: [
              "In most households the pains are divided: one person owns the bill and its promo cliff, the other owns the 8 p.m. buffering and the dropped video calls. Find each person's pain separately with one question each, then give each their own number: That is the 30 a month back on the bill for you — and the upstairs stream holding at 8 p.m. for you. The close is not getting them to agree with you; it is getting them to agree with each other. When the moment shows, name it: Sounds like you two are saying the same thing from two directions. Aligned spouses close themselves — the decision becomes their joint idea, which is the only kind of household decision that survives the night.",
            ],
          },
          {
            heading: "When one arrives mid-pitch, and when to go silent",
            body: [
              "A spouse arriving mid-pitch gets the 10-second recap from Module 4 — the pain, the number — followed immediately by a question to the newcomer, never a restart: We were just looking at the bill jump — does the evening slowdown hit your side of the house too? The recap keeps the message accurate; the question makes them a participant instead of an audience. And when the two of them start deciding between themselves — trading looks, doing math out loud, negotiating install day — go completely quiet. They are closing each other, which is better than anything you could add. Interrupting a couple mid-agreement is the overtalking failure at double stakes: you can lose two yeses with one sentence.",
            ],
          },
        ],
        keyTakeaways: [
          "Never pitch past the quiet one — the silent partner kills more deals than the vocal skeptic.",
          "Find each person's separate pain and give each their own number.",
          "Close by aligning them with each other, not with you — joint ideas survive the night.",
          "Spouse arrives mid-pitch: 10-second recap plus a question to the newcomer. Couple starts deciding: go silent.",
        ],
        drillPrompt:
          "At every two-person door in your next 10, direct your second question to the quieter person and log both pains separately. If you reach a close, phrase it as an alignment observation — you two are saying the same thing — and count to four in silence whenever they start talking to each other.",
        quiz: [
          {
            question: "Why is the silent partner more dangerous to the sale than the vocal skeptic?",
            options: [
              "Silence signals hidden hostility",
              "They were never engaged, so their default no wins the kitchen conversation after you leave",
              "Quiet people control household finances",
              "They are memorizing your claims to check later",
            ],
            answerIndex: 1,
            explanation: "The skeptic at least processes your answers. The unengaged partner decides later, without you, from a default of no — unless you pulled them in at the door.",
          },
          {
            question: "What is the spouse-alignment move?",
            options: [
              "Getting each spouse to agree with you individually",
              "Asking which spouse makes the decisions",
              "Finding each person's separate pain, giving each their own number, and naming the moment they agree with each other",
              "Pitching only the financially responsible spouse",
            ],
            answerIndex: 2,
            explanation: "A decision aligned between the couple is their joint idea and survives the night. A decision aligned with the rep gets re-litigated at dinner.",
          },
          {
            question: "The couple starts doing the math out loud between themselves. What do you do?",
            options: [
              "Correct any small errors in their math immediately",
              "Summarize the offer once more so they have it fresh",
              "Suggest an install date while enthusiasm is high",
              "Go completely silent — they are closing each other, and one sentence from you can lose two yeses",
            ],
            answerIndex: 3,
            explanation: "A couple negotiating logistics together is the sale completing itself. This is the overtalking failure at double stakes: protect the silence.",
          },
        ],
      },
    ],
  },
  // ── M10 — Reading the Door in Five Seconds ──────────────────────────────────
  {
    id: "m10",
    title: "Reading the Door in Five Seconds",
    tagline: "Homeowner states, doorway tells, and the tone that buys thirty more seconds.",
    lessons: [
      {
        id: "m10-five-second-read",
        title: "The four states behind every open door",
        summary: "Busy, curious, guarded, annoyed — identify the state before you say your third word.",
        minutes: 5,
        sections: [
          {
            heading: "Four states, four different doors",
            body: [
              "Every door you will ever knock opens into one of four states, and each one needs a different first sentence. The busy state: door opens fast and half, body angled back into the house, first word is \"yeah?\" The curious state: full open, eye contact, they saw the trucks or heard from a neighbor and they are waiting to see what you are. The guarded state: opens on the chain or through the glass, arms crossed, weight back — you are a threat until proven otherwise. The annoyed state: door yanked open, exhale before hello, you are the third knock this week.",
              "You read the state in the first five seconds from three signals: how the door opens (crack versus full), where their weight sits (leaning in versus braced back), and the first sound they make (a question versus a sigh). You do not need to be right with certainty. You need a working guess fast enough that your opener matches their reality instead of the script in your head.",
            ],
          },
          {
            heading: "Name the state silently, then match it",
            body: [
              "Busy gets compression and respect for the clock: \"I can see I'm catching you mid-something — twenty seconds and one question, then I'm gone.\" Curious gets the door opened wider: \"You've probably seen the crews up the street — that's us. Want the two-minute version of what just changed on your block?\" Guarded gets the threat removed first: \"Totally fair — I'm not asking you to buy anything on the porch. I'm checking which houses on this street the new fiber actually reaches.\" Annoyed gets the acknowledgment, because being seen defuses faster than being pitched: \"You've probably had a run of knocks lately — I'll make this painless. One thing worth knowing, then I'm off your porch.\"",
              "The psychology underneath: people cooperate when the interaction matches their current state, and resist when it demands a state change. Asking an annoyed person to be cheerful is a state change. Acknowledging the annoyance and being brief is a state match — and a matched state is the only road to a real conversation.",
            ],
          },
          {
            heading: "The state is about them, never about you",
            body: [
              "The rookie error is reading every flat door as rejection of you. An annoyed state is almost never about you — it is the interrupted dinner, the crying kid, the last solicitor. Your job is to route around the state, not absorb it. When you stop taking the state personally, you can work it: busy doors become callbacks, guarded doors become your best customers once the threat clears, and annoyed doors respect the rep who keeps it to one honest sentence and leaves.",
            ],
          },
        ],
        keyTakeaways: [
          "Every open door is busy, curious, guarded, or annoyed — read it in five seconds from the crack, the weight, and the first sound.",
          "Match the state with your first sentence; never ask a homeowner to change state for you.",
          "Busy: compress. Curious: expand. Guarded: remove the threat. Annoyed: acknowledge and be brief.",
          "A flat state is about their day, not about you — route around it, don't absorb it.",
        ],
        drillPrompt:
          "On your next 10 doors, say the state out loud in your head before you speak — busy, curious, guarded, or annoyed — and pick your first sentence from the matching script. After each door, log whether your read was right and how the matching sentence changed the first thirty seconds.",
        quiz: [
          {
            question: "The door opens six inches on the chain, arms crossed, weight back. What state are you in?",
            options: ["Busy", "Curious", "Guarded", "Annoyed"],
            answerIndex: 2,
            explanation: "Physical barriers and braced posture are the guarded state's signature. Remove the threat before you pitch anything.",
          },
          {
            question: "A homeowner yanks the door open with an audible sigh — you're clearly the third knock this week. What is the right first move?",
            options: [
              "Deliver your full opener with extra energy to reset the mood",
              "Acknowledge the run of knocks, promise one painless thing, and keep it brief",
              "Apologize and leave immediately",
              "Ask what's bothering them",
            ],
            answerIndex: 1,
            explanation: "Annoyed doors respond to being seen, not to being pitched. Acknowledgment plus brevity is the state match that earns the one sentence.",
          },
          {
            question: "Why does state-matching work psychologically?",
            options: [
              "It mirrors their body language, which builds rapport",
              "It meets the interaction where the homeowner already is instead of demanding a state change",
              "It signals you are an experienced salesperson",
              "It shortens the pitch, which everyone prefers",
            ],
            answerIndex: 1,
            explanation: "People cooperate when the interaction matches their current state. Demanding cheerfulness from an annoyed homeowner is a state change — and state changes get resisted.",
          },
        ],
      },
      {
        id: "m10-doorway-tells",
        title: "Doorway tells: the house speaks first",
        summary: "Dish on the roof, carrier van outside, ONT box, dog — the intel you gather walking up the driveway.",
        minutes: 5,
        sections: [
          {
            heading: "The hardware audit from the sidewalk",
            body: [
              "The house tells you what the pitch should be before anyone opens the door. A satellite dish on the roof means a TV bundle — the homeowner is paying one company for internet plus TV, and the switch conversation includes what they watch. A competitor's van parked outside today means a technician is in the house right now: expect a homeowner freshly reminded of a bill or a repair, and be ready to be compared to whoever is in their driveway. An ONT box on the exterior wall means fiber has already reached this house — check the app before you knock, because that door may be an existing Kinetic customer (mark already_customer and thank them) or a competitor's fiber, which changes everything about your angle.",
              "A dog changes the mechanics, not the math. Barking means the door opens less and the homeowner's attention splits. Step back off the porch, keep your body angled, speak to the person and ignore the dog entirely — the homeowner reads your calm around their dog as calm in general. If they apologize for the noise, defuse it with one light line and get back to the pitch: \"No worries — he's just doing his job. Quick question while he's on duty: who's your internet provider?\"",
            ],
          },
          {
            heading: "Reading the approach",
            body: [
              "The driveway is a briefing. Two cars and toys in the yard means a full household with streaming, gaming, and work-from-home loads — your pain questions can go straight to peak-hour slowdowns. A doorbell camera means you are being recorded from the street: assume the whole interaction is reviewable, because it is, and let that keep your claims clean and your register professional. A no-soliciting sign is not a tell to work around — it is a boundary to honor. Skip the door, log it, and move on.",
              "The freshest tell is construction itself: fresh conduit flags, a crew trailer, a bored line under the sidewalk. That is the freshest-fiber pitch in Module 11 arriving in physical form — the build is your proof, visible from the porch.",
            ],
          },
          {
            heading: "Tells set the angle, not the verdict",
            body: [
              "None of this decides the door before you knock it. A dish is not a lost door — it is a pointer to the bundle conversation. A competitor van is not a lost door — it is a homeowner with internet service on their mind today. Tells choose your opening question and your anchor, nothing more. The only tells that end a knock are the legal and safety ones: no-soliciting signage, a do-not-knock flag in the app, or a situation your gut says to leave. Everything else is just information, and information is the whole job.",
            ],
          },
        ],
        keyTakeaways: [
          "Dish on the roof = bundle conversation. Competitor van = internet is on their mind today. ONT box = check the app before you knock.",
          "Dogs change mechanics, not math: step back, angle your body, ignore the dog.",
          "A doorbell camera means the interaction is reviewable — let it keep your claims clean.",
          "No-soliciting signs and do-not-knock flags end the knock. Every other tell just chooses your angle.",
        ],
        drillPrompt:
          "On your next 10 doors, spend the walk up the driveway naming every tell you can see — hardware, vehicles, cameras, signage — and choose your opening question from the strongest one. Log the tell in your door note when it proved useful.",
        quiz: [
          {
            question: "You spot an ONT box on the exterior wall as you approach. What does it tell you?",
            options: [
              "The house cannot get fiber",
              "Fiber already reaches this house — check the app before knocking; it may be an existing customer or a competitor's fiber",
              "The homeowner is a satellite customer",
              "Nothing — ONT boxes are decorative",
            ],
            answerIndex: 1,
            explanation: "An ONT means fiber is lit at the address. The app tells you whether it is ours (thank them, mark already_customer) or a competitor's (a completely different angle).",
          },
          {
            question: "A competitor's technician van is parked in the driveway when you arrive. What is the best read?",
            options: [
              "A lost door — skip it",
              "A hostile door — expect a fight",
              "A homeowner with internet service freshly on their mind — be ready to be compared",
              "A door to return to tomorrow",
            ],
            answerIndex: 2,
            explanation: "A service visit means a bill or a repair is front of mind today. That is attention on exactly your category — a tell for your angle, not a verdict on the door.",
          },
          {
            question: "Which tells legitimately end a knock before it starts?",
            options: [
              "A satellite dish and a barking dog",
              "A doorbell camera and two cars",
              "No-soliciting signage, a do-not-knock flag in the app, or a situation your gut says to leave",
              "A competitor van and an ONT box",
            ],
            answerIndex: 2,
            explanation: "Legal boundaries and safety instincts end knocks. Hardware, pets, and cameras only choose the angle of the conversation.",
          },
        ],
      },
      {
        id: "m10-ten-second-rule",
        title: "The ten-second rule",
        summary: "The homeowner decides whether you exist in ten seconds. Spend them on three beats.",
        minutes: 4,
        sections: [
          {
            heading: "You get ten seconds, not thirty",
            body: [
              "The homeowner's decision to keep listening happens in roughly the first ten seconds, and it is mostly not about your product. They are answering one question: is this person worth thirty more seconds of my evening? Everything they need to decide that is visible fast — your posture, your pace, whether your first sentence sounds like every other solicitor or like a person with specific, useful news about their street.",
              "The practical consequence: anything in your opener that does not fit in ten seconds is not in your opener. If your name, your connection to Kinetic, and the reason this street matters today cannot be said inside one breath, the pitch is too long and the door is already closing while you finish it.",
            ],
          },
          {
            heading: "The three beats that fit",
            body: [
              "The ten seconds hold exactly three beats. Who you are: \"Hey, I'm Dana — I work with Kinetic.\" Why this street, right now: \"The crews just ran new fiber down this block, so your house can finally get it.\" One easy question: \"Who's your internet provider right now?\" The question is the load-bearing beat. It hands the homeowner a question they can answer in one word, which converts a doorstep monologue into a conversation — and conversations are what close.",
              "Notice what is missing: pricing, speeds, the company history, the contract terms. All of it is real and none of it belongs in the first ten seconds. You are not selling fiber in the opener; you are earning the right to sell it in the next thirty seconds.",
            ],
          },
          {
            heading: "Buying the next ten seconds",
            body: [
              "When a door is wavering — hand still on the knob, half-turned back to the game — buy time honestly with a permission micro-close: \"Twenty seconds — worth it?\" This works because it is a small, specific, honest ask with an exit built in. The homeowner who says yes has now actively chosen to listen, and a chosen listen is worth ten times a tolerated one. The homeowner who says no just saved you four minutes — mark the outcome accurately and take the next door.",
            ],
          },
        ],
        keyTakeaways: [
          "The keep-listening decision happens in about ten seconds and is about you, not the product.",
          "Three beats fit: who you are, why this street right now, one easy question.",
          "The question converts a monologue into a conversation — it is the load-bearing beat.",
          "Wavering door: buy time with an honest permission ask — \"Twenty seconds — worth it?\"",
        ],
        drillPrompt:
          "Time your opener with a stopwatch before your next shift — name, street reason, question, in under ten seconds. At your next 10 doors, use the permission micro-close on any door that wavers, and log how often a chosen listen outperforms a tolerated one.",
        quiz: [
          {
            question: "What is the homeowner actually deciding in the first ten seconds?",
            options: [
              "Whether fiber beats cable",
              "Whether the price is fair",
              "Whether you are worth thirty more seconds of their evening",
              "Whether they need internet at all",
            ],
            answerIndex: 2,
            explanation: "The keep-listening decision is about the person on the porch, not the product. Product decisions come later, only if you pass this one.",
          },
          {
            question: "Why is the closing question of the opener the load-bearing beat?",
            options: [
              "It gathers competitor data for the app",
              "It hands the homeowner a one-word answer, converting a monologue into a conversation",
              "It fills the ten-second window",
              "It qualifies their budget",
            ],
            answerIndex: 1,
            explanation: "An easy question makes the homeowner a participant. Conversations close; doorstep monologues get doors closed on them.",
          },
          {
            question: "Why does \"Twenty seconds — worth it?\" work on a wavering door?",
            options: [
              "It pressures the homeowner into politeness",
              "It is a small, specific, honest ask with an exit built in — a yes is a chosen listen, a no saves you four minutes",
              "It implies a limited-time offer",
              "It restarts the ten-second clock",
            ],
            answerIndex: 1,
            explanation: "Permission micro-closes convert tolerated listening into chosen listening, and an honest no is itself a win: accurate outcome, next door.",
          },
        ],
      },
    ],
  },
  // ── M11 — The Kinetic Pitch Framework ───────────────────────────────────────
  {
    id: "m11",
    title: "The Kinetic Pitch Framework",
    tagline: "One opener structure, three verbatim pitches, and the anchors you quote from.",
    lessons: [
      {
        id: "m11-opener-structure",
        title: "The four-beat opener",
        summary: "Name, authorized-partner, new-fiber hook, question — the skeleton every Kinetic pitch hangs on.",
        minutes: 5,
        sections: [
          {
            heading: "The skeleton",
            body: [
              "Every Kinetic pitch in this module hangs on the same four beats, in order. Beat one, your name — a person, not a company: \"I'm Alex.\" Beat two, the authorized-partner line — why you specifically are on this porch: \"I work with Kinetic, the company building out the fiber network on this side of town.\" Beat three, the new-fiber hook — the news about their street: \"The crews just lit the line down your block, so your house can get fiber for the first time.\" Beat four, the question — the handoff: \"Who's your provider right now?\"",
              "The order is the psychology. Name first makes you a person before you are a pitch. Partner second borrows the authority of the whole build behind you. The hook third gives them news, not an ask — people open doors for news. The question last moves the work to them, in the easiest possible form. Skip a beat and the door feels it: no name reads as a script, no partner line reads as a random stranger, no hook reads as a favor you want, no question reads as a lecture.",
            ],
          },
          {
            heading: "The full opener, verbatim",
            body: [
              "\"Hey, I'm Alex — I work with Kinetic, the company that's been building the new fiber network through this neighborhood. The line down your street just went live, so your house can finally get real fiber. Quick question — who's your internet provider right now?\"",
              "Say it at conversation pace, not recital pace. The moment it sounds memorized it loses the news quality that makes it work, so learn the beats cold and let the words flex. Two rules of honesty that are also rules of effectiveness: only claim the street is live if the app shows it serviceable, and confirm your exact authorized-partner wording with your manager before you use it — the relationship between field reps and Kinetic has specific approved language [VERIFY].",
            ],
          },
          {
            heading: "Why the question does the closing",
            body: [
              "\"Who's your provider right now?\" looks like small talk and functions like a close. It is answerable in one word, so nearly everyone answers it. It is not a commitment, so nobody resists it. And their answer routes the entire rest of the conversation: cable gets the upload-and-price-creep angle, satellite gets the weather-and-latency angle, a competitor's fiber gets the Module 12 pivot, and \"I don't really know\" gets the bill-check move. One question, four clean branches, zero wasted words.",
            ],
          },
        ],
        keyTakeaways: [
          "Four beats in order: name, authorized-partner, new-fiber hook, question.",
          "The hook is news, not an ask — people open doors for news.",
          "Learn the beats cold and let the words flex; recital pace kills the opener.",
          "Only claim live service the app confirms, and verify your partner wording with your manager [VERIFY].",
        ],
        drillPrompt:
          "Write the four beats on a card in your own words and rehearse it ten times before your next shift — out loud, at conversation pace. On your next 10 doors, count how many homeowners answer the routing question, and note which branch each answer sent you down.",
        quiz: [
          {
            question: "What is the correct order of the four opener beats?",
            options: [
              "Hook, name, question, partner",
              "Name, authorized-partner, new-fiber hook, question",
              "Question, name, hook, partner",
              "Partner, hook, name, question",
            ],
            answerIndex: 1,
            explanation: "Person first, authority second, news third, handoff last. Each beat earns the next one's right to exist.",
          },
          {
            question: "Why does the opener end with \"Who's your provider right now?\"",
            options: [
              "To fill out the lead record",
              "It is easy to answer, carries no commitment, and routes the rest of the pitch down the right branch",
              "To check whether they can afford fiber",
              "To compare their provider's pricing",
            ],
            answerIndex: 1,
            explanation: "One easy question converts the doorstep into a conversation and tells you which angle — cable, satellite, competitor fiber, or unknown — the rest of the pitch needs.",
          },
          {
            question: "Before telling a street \"your line just went live,\" what must you do?",
            options: [
              "Nothing — momentum language is always fine",
              "Ask the homeowner if they've seen crews",
              "Confirm serviceability in the app, and confirm your approved partner wording with your manager",
              "Check whether neighbors already bought",
            ],
            answerIndex: 2,
            explanation: "A false hook is both dishonest and instantly checkable. The app is the source of truth for serviceability; your manager owns the approved partner language.",
          },
        ],
      },
      {
        id: "m11-pitch-fresh-fiber",
        title: "Verbatim: the fresh-fiber street pitch",
        summary: "For blocks where the crews just left — the build itself is your proof.",
        minutes: 6,
        sections: [
          {
            heading: "When to run it",
            body: [
              "Run this pitch on streets where the build is fresh — the app shows the cluster as newly serviceable, the conduit flags are still in yards, the neighbors are still talking about the trucks. Fresh fiber is the strongest position in D2D internet: you are not asking the homeowner to imagine an improvement, you are pointing at one they watched get buried in their easement.",
            ],
          },
          {
            heading: "The pitch, verbatim",
            body: [
              "\"Hey, I'm Alex — I work with Kinetic. You've seen the crews on your street the past few weeks — that was us, burying brand-new fiber. It just went live, which means your house can get real fiber internet for the first time. Not the cable company's version — a dedicated fiber line to your house. Quick question: who's your provider right now?\"",
              "After the answer, the anchor block: \"Here's what changes. Fiber is symmetrical — your upload matches your download, so video calls and cloud backups stop crawling. There are no data caps [VERIFY current plan terms] and no annual contract [VERIFY], so you're not locked in. And because the build is fresh, standard installation is free during the install window [VERIFY current install offer]. Most folks here go with the gig plan, but there are 300, 1000, and 2000 meg tiers depending on how the house uses it [VERIFY current speed tiers and pricing]. Want me to check which one fits your house?\"",
              "Every bracketed claim is a live offer that changes — confirm the current tiers, pricing, contract terms, and install offer in the app or with your manager before you quote them. A rep quoting last month's promo is one fact-check away from a lost sale and a complaint.",
            ],
          },
          {
            heading: "Why it works",
            body: [
              "Three forces stack. Recency: the build is visible and memorable, so your claims are checkable in the homeowner's own memory — trust arrives pre-built. Fairness framing: \"for the first time\" positions fiber as something their house was owed and finally got, not a product being pushed. And the routing question plus anchor block structure means the pitch is a conversation with a menu, not a monologue with a price.",
            ],
          },
        ],
        keyTakeaways: [
          "Fresh-fiber streets are the strongest position in D2D — the build itself is your proof.",
          "Structure: four-beat opener, routing question, then the anchor block (symmetry, caps, contract, install).",
          "Every speed tier, price, contract, and install claim gets quoted only after you verify the current offer [VERIFY].",
          "\"For the first time\" frames fiber as something the house was owed — fairness beats salesmanship.",
        ],
        drillPrompt:
          "Run the fresh-fiber pitch verbatim at your next 10 newly-serviceable doors. After each, note which anchor — symmetry, no caps, no contract, or free install — produced the visible reaction, and lead with that anchor at the next door.",
        quiz: [
          {
            question: "What makes a fresh-fiber street the strongest pitch position?",
            options: [
              "Homeowners there have higher incomes",
              "The build is visible in the homeowner's own memory, so your claims arrive pre-verified",
              "Cable doesn't serve those streets",
              "The pricing is lower on new streets",
            ],
            answerIndex: 1,
            explanation: "Recency means the homeowner watched your proof get buried in their easement. Checkable claims build trust faster than any adjective.",
          },
          {
            question: "A homeowner asks the exact monthly price of the gig plan and you haven't checked today's offer. What do you do?",
            options: [
              "Quote last month's price from memory",
              "Give a range and move on quickly",
              "Check the current offer in the app before quoting — live offers change, and a stale quote costs the sale and trust",
              "Avoid the question until the close",
            ],
            answerIndex: 2,
            explanation: "The [VERIFY] discipline: quoting a stale price is one fact-check away from a lost sale and a complaint. The app is the current source of truth.",
          },
          {
            question: "What does \"for the first time\" do psychologically in this pitch?",
            options: [
              "Creates artificial urgency",
              "Frames fiber as something the house was owed and finally received — fairness framing",
              "Signals the technology is untested",
              "Implies the offer expires soon",
            ],
            answerIndex: 1,
            explanation: "Fairness framing positions fiber as a long-overdue arrival, not a product push. People act on rectified gaps faster than on upgrades.",
          },
        ],
      },
      {
        id: "m11-pitch-upgrade",
        title: "Verbatim: the established-fiber upgrade pitch",
        summary: "For streets lit a while ago where most neighbors still sit on cable — the switch pitch.",
        minutes: 6,
        sections: [
          {
            heading: "When to run it",
            body: [
              "Run this on streets the app shows serviceable for months or years, where the build story is old news and the door's reality is an entrenched cable or DSL habit. You cannot sell these homeowners on novelty — the fiber has been there. You sell them on the gap between what they settled for and what has been available one truck-roll away the whole time.",
            ],
          },
          {
            heading: "The pitch, verbatim",
            body: [
              "\"Hey, I'm Alex with Kinetic. Your street's actually had our fiber for a while now — most of your neighbors are still on cable, which is exactly why I'm knocking. Quick question: who's your provider, and roughly what are they charging you these days?\"",
              "Then the gap block, built from their own numbers: \"Okay — so here's the honest comparison. Cable download is fine; upload is where it falls over — most cable plans top out around 20 to 35 meg upload [VERIFY against current competitor plans in your market]. Fiber is symmetrical, so a gig plan is a gig both ways [VERIFY current tiers]. The other thing cable does: the promo price you signed at is not the price you're paying now — bills creep. Pull up your last bill and I'll show you the comparison in real numbers, not adjectives.\"",
              "The bill pull-up is the heart of this pitch. Their real bill — equipment fees, broadcast fees, the post-promo rate — is the only comparison that survives the night. If your price only wins before fees, say so and pivot to the upload and no-contract story [VERIFY current contract terms]. Never invent a savings number; read theirs off the screen and do the arithmetic in front of them.",
            ],
          },
          {
            heading: "The psychology: dissatisfaction by arithmetic",
            body: [
              "Established-fiber doors are not unhappy enough to switch on adjectives. They switch when their own numbers indict their current provider — the promo cliff they forgot, the upload speed they never tested, the fee stack they stopped reading. Your job is not to criticize their provider, which triggers defense of a decision they made; your job is to put their bill next to your offer and let the arithmetic do the criticizing. Homeowners trust conclusions they reach themselves — your whole pitch is arranging for them to reach this one.",
            ],
          },
        ],
        keyTakeaways: [
          "Established streets: sell the gap between what they settled for and what has been available all along.",
          "Lead with upload symmetry and promo-cliff price creep — cable's two structural weaknesses [VERIFY current competitor plans].",
          "The bill pull-up is the heart of the pitch: their real fees versus your real offer, arithmetic in front of them.",
          "Never invent savings — read their numbers, do the math together, and let the arithmetic criticize.",
        ],
        drillPrompt:
          "At your next 10 established-fiber doors, ask for the bill pull-up on every engaged conversation. Log how often the real bill is higher than the number they quoted from memory, and use that gap as your opening evidence at the next door.",
        quiz: [
          {
            question: "Why doesn't the fresh-build pitch work on long-established fiber streets?",
            options: [
              "The fiber there is slower",
              "The build story is old news — the pitch has to sell the gap between what they settled for and what's been available",
              "Homeowners there dislike new technology",
              "The install window has closed everywhere",
            ],
            answerIndex: 1,
            explanation: "Novelty expired years ago on those streets. The switch pitch runs on dissatisfaction by arithmetic, not on news.",
          },
          {
            question: "What is the bill pull-up and why is it the heart of the upgrade pitch?",
            options: [
              "Asking to see their bill so you can judge their budget",
              "Comparing their real bill — promo cliff, fees, actual rate — against your real offer, so their own numbers make the case",
              "Pulling up their credit profile",
              "Showing them a neighbor's bill",
            ],
            answerIndex: 1,
            explanation: "Adjectives don't move entrenched customers; their own arithmetic does. The real bill is the only comparison that survives the night.",
          },
          {
            question: "Why should you avoid directly criticizing their current provider?",
            options: [
              "It's illegal",
              "It triggers defense of a decision they made — better to arrange for them to reach the conclusion themselves",
              "The competitor might hear about it",
              "It's a waste of breath",
            ],
            answerIndex: 1,
            explanation: "Attacking a choice attacks the chooser. Self-reached conclusions are trusted; imposed ones get defended against.",
          },
        ],
      },
      {
        id: "m11-pitch-lit-your-block",
        title: "Verbatim: \"Kinetic just lit your block\"",
        summary: "The momentum pitch — real installs, real neighbors, real calendar, and the honesty rule that powers it.",
        minutes: 6,
        sections: [
          {
            heading: "The pitch, verbatim",
            body: [
              "\"Hey, I'm Alex with Kinetic — and I'm on your porch for a specific reason: Kinetic just lit your block. The line went live this month, the crews are still in the neighborhood, and houses around you are already getting on the install calendar. I'm working this street while the install window is open. Who's your provider right now?\"",
              "Then the momentum block: \"Here's the part worth knowing. While the build crews are still on this side of town, standard installs are booking fast — and the current offer includes free standard installation during this window [VERIFY current install offer]. I'm not telling you a date to pressure you; I'm telling you because the calendar in my app is real, and I'd rather put you on it than have you call in six weeks from now and wait. Want to see what the week looks like?\"",
              "The close folds straight into Module 14: \"I've got Tuesday morning or Thursday afternoon open on your street — which one works better?\"",
            ],
          },
          {
            heading: "The honesty rule that powers it",
            body: [
              "Momentum is the most abused claim in door-to-door, which is exactly why it is powerful when it is true and fatal when it is invented. Before you run this pitch, the momentum must be real: the app shows the block newly serviceable, installs are actually booking on the street, and the calendar slots you offer actually exist. If three neighbors are on the calendar, you may say three neighbors are on the calendar. If none are, you do not say \"everyone's signing up\" — you say the block just went live and the window is open, which is true.",
              "The reason is not just ethics. A fabricated momentum claim is checkable — the homeowner asks the neighbor at the barbecue on Saturday, and when your story collapses you lose the street, not just the door. The map's install history is your receipt; work streets where the app shows real momentum and quote only what it shows.",
            ],
          },
          {
            heading: "Why urgency works here without manipulation",
            body: [
              "Real urgency is a service: install windows genuinely fill, build crews genuinely move on, and early adopters genuinely get installed faster. You are not manufacturing pressure; you are reporting logistics the homeowner cannot see from their couch. The line you never cross is inventing scarcity — fake expiration dates, phantom \"last slots,\" imaginary signing neighbors. Report the real calendar honestly and the urgency takes care of itself, because the real calendar is genuinely finite.",
            ],
          },
        ],
        keyTakeaways: [
          "Momentum pitch: the block just lit, installs are booking, the window is open — then straight to the two-day-choice close.",
          "Quote only momentum the app confirms; fabricated claims are checkable at the Saturday barbecue.",
          "Real urgency is a service — install windows genuinely fill and crews genuinely move on.",
          "Never invent scarcity: no fake expirations, phantom slots, or imaginary neighbors.",
        ],
        drillPrompt:
          "Before your next session, pull the map and pick the street with the strongest real install momentum. Run the lit-your-block pitch at 10 doors there, quoting only numbers the app shows. Compare your engagement rate against a street with no momentum story.",
        quiz: [
          {
            question: "When may you tell a homeowner \"three of your neighbors are already on the install calendar\"?",
            options: [
              "Whenever it helps the close",
              "When at least one neighbor has inquired",
              "Only when the app actually shows three installs booked on that street",
              "When the block was recently built out",
            ],
            answerIndex: 2,
            explanation: "Momentum claims must match the map exactly. The app's install history is your receipt — and the homeowner's neighbors are the fact-check.",
          },
          {
            question: "Why is fabricated momentum especially dangerous in D2D?",
            options: [
              "It violates quota rules",
              "It is checkable — the homeowner asks the neighbors, and a collapsed story loses the whole street",
              "Neighbors talk to competitors",
              "It slows down your knock rate",
            ],
            answerIndex: 1,
            explanation: "You are selling to a social network with fences. One false claim discovered at a barbecue poisons every door on the block.",
          },
          {
            question: "What makes the urgency in this pitch legitimate rather than manipulative?",
            options: [
              "Nothing — urgency is always manipulation",
              "You are reporting real, finite logistics — install windows fill and crews move on — not inventing scarcity",
              "The offers really do expire at midnight",
              "Urgency is fine if the pitch is friendly",
            ],
            answerIndex: 1,
            explanation: "Real urgency is a service: the calendar is genuinely finite and visible in your app. Manufactured scarcity is the line you never cross.",
          },
        ],
      },
    ],
  },
  // ── M12 — Objection Killers ─────────────────────────────────────────────────
  {
    id: "m12",
    title: "Objection Killers",
    tagline: "Every objection you will actually hear, with the words that answer it.",
    lessons: [
      {
        id: "m12-happy-price-works",
        title: "\"I'm happy,\" \"what's the price,\" \"it works fine\"",
        summary: "The satisfaction wall — three ways through the most common doors in the territory.",
        minutes: 6,
        sections: [
          {
            heading: "\"I'm happy with my provider\"",
            body: [
              "\"Happy is great — I'm not here to fix what isn't broken. Most of your neighbors were happy too; they just didn't know fiber had reached their street. Let me ask it differently: if you could keep everything you like and pay less for it, would you want to see the numbers? Takes two minutes.\"",
              "The psychology: happy is not an objection to fiber, it is an objection to change. Arguing against their happiness makes you the enemy of a decision they feel good about. Reframing — keep the happiness, add the savings — makes the comparison free of risk. You are not asking them to switch; you are asking them to look. Looking is cheap, which is why happy people say yes to it.",
            ],
          },
          {
            heading: "\"What's the price?\" and \"that's too expensive\"",
            body: [
              "When they lead with price: \"Fair question — it depends on the speed your house needs, and I don't quote numbers I haven't checked. Can I ask what you're paying now? Then I'll show you the real comparison, not a guess.\" Their current bill is the anchor that makes your price legible; without it you are quoting into a vacuum.",
              "When your number lands as too expensive: \"Totally fair — can I show you what that number includes? No equipment rental fee [VERIFY], no data-cap overage charges [VERIFY], no annual contract [VERIFY]. The number on a cable bill and the number you actually pay are usually two different numbers — pull up your last bill and let's compare totals, not stickers.\" If the honest total comparison does not favor you at the speed they need, say so and pivot to the upload and reliability story. Winning on a false price claim is losing on a delay.",
            ],
          },
          {
            heading: "\"My internet works fine\"",
            body: [
              "\"It works fine — until when? Most folks tell me it's fine until 8 p.m. when everyone's streaming, or until a work call drops. Where does yours hold up worst?\" The question presumes nothing and invites the crack to name itself.",
              "The psychology: works-fine is a summary judgment, not a measurement. Nobody has tested their upload during the evening peak; they have only stopped noticing the failures they adapted to — the call taken on the phone instead of the laptop, the show paused to buffer. Your job is to make the adaptation visible again, gently, with one question. Once the homeowner says the crack out loud, works-fine is gone and you are solving a problem they just admitted to having.",
            ],
          },
        ],
        keyTakeaways: [
          "Happy is an objection to change, not to fiber — reframe as keep-the-happiness, add-the-savings, just look.",
          "Never quote price into a vacuum; anchor on their current bill first.",
          "Compare totals, not stickers — fees and promo cliffs live off the headline number [VERIFY your current plan terms].",
          "Works-fine is a summary judgment; one \"until when?\" question makes the hidden crack visible.",
        ],
        drillPrompt:
          "At your next 10 doors, answer every satisfaction objection with the matching script, then ask the routing question (their bill, or the \"until when\" crack). Log which of the three walls you hit most often and how many converted to a real conversation.",
        quiz: [
          {
            question: "Why is \"I'm happy with my provider\" not really an objection to fiber?",
            options: [
              "Happy customers are lying",
              "It is an objection to change — reframe the ask as a risk-free comparison that keeps everything they like",
              "It is a request for pricing",
              "It means they already have fiber",
            ],
            answerIndex: 1,
            explanation: "You are not asking them to switch, only to look. Looking is cheap, so happy people say yes to it — and the numbers do the switching.",
          },
          {
            question: "A homeowner says your price is too expensive. What is the strongest honest move?",
            options: [
              "Offer a discount immediately",
              "Drop the price topic and pitch speed instead",
              "Break down what the number includes and compare total bills — fees, overages, promo cliffs — against their real statement",
              "Tell them the competition charges more",
            ],
            answerIndex: 2,
            explanation: "Sticker-to-sticker comparisons hide the fee stack and the promo cliff. Totals are the honest ground — and if the totals don't favor you, pivot to upload and reliability rather than fake the math.",
          },
          {
            question: "What is the function of \"It works fine — until when?\"",
            options: [
              "It contradicts the homeowner",
              "It invites the homeowner to name the failure they've adapted to, turning a summary judgment into an admitted problem",
              "It introduces the speed tiers",
              "It buys time to think",
            ],
            answerIndex: 1,
            explanation: "People adapt to failures and forget them. One question makes the adaptation visible again — and a problem they name out loud is one you can solve.",
          },
        ],
      },
      {
        id: "m12-renting-spouse-think",
        title: "\"I'm renting,\" \"my spouse decides,\" \"let me think about it\"",
        summary: "The deferral family — objections that hand the decision to someone or sometime else.",
        minutes: 6,
        sections: [
          {
            heading: "\"I'm renting\"",
            body: [
              "\"A lot of folks on this street rent — here's how it usually works. Fiber internet service doesn't require owning the house; it requires the person who pays the internet bill. Is that you? Then this is your call. The install itself is designed for rentals — the line to the house is already there [VERIFY current install requirements for rentals with your manager].\"",
              "The psychology: renting is half objection, half question — the renter is asking whether this is even allowed to be their decision. Answer the permission question factually and the objection usually evaporates. When it doesn't — a genuinely landlord-controlled setup — get the decision-maker's contact or a follow_up and log it; a routed objection is a future door, not a dead one.",
            ],
          },
          {
            heading: "\"My spouse handles that\"",
            body: [
              "\"Totally fair — most households split decisions like that. Here's the thing: the pitch takes two minutes and it's the same two minutes I'll give them. When are you both usually home? I'll swing back and give it to you together — that way nobody has to repeat me.\" Then book the return in the app as a follow_up with a real day and time before you leave the porch.",
              "Never pitch the non-decider into carrying the message — a secondhand pitch loses half its force and all its control, and the spouse hears the weakest version at the worst moment. Also never use the spouse line as leverage (\"don't you make decisions for yourself?\") — it manufactures one resentful ally and one hostile veto. The joint visit is the only play that respects the household and keeps the close alive; Module 9's two-buyers lesson covers what to do once you have both of them.",
            ],
          },
          {
            heading: "\"Let me think about it\"",
            body: [
              "\"Absolutely — most people want to, and I'd rather you be sure. Just so I leave you the right information: is it the price you're weighing, or whether switching is worth the hassle?\" Think-about-it is almost always a polite wrapper on one real, nameable concern, and you cannot answer a concern you have not named.",
              "Once the real concern is on the table, answer it — then, if the hesitation is genuine and not a hidden no, offer the soft-commit from Module 14: \"Tell you what — I'll pencil you in for Thursday's install window while you decide. No charge to cancel [VERIFY cancellation policy]; if it's not a fit, one text and it's off the calendar.\" The penciled slot converts open-ended deliberation into a decision with a date — and a dated decision gets made.",
            ],
          },
        ],
        keyTakeaways: [
          "Renting is a permission question: the person who pays the bill makes the call — answer it factually [VERIFY rental install policy].",
          "Spouse-decides: book the joint visit with a real day and time, never pitch the messenger.",
          "Think-about-it is a wrapper on one nameable concern — isolate it before you answer anything.",
          "Genuine hesitation earns the soft-commit pencil-in; a hidden no earns an honest outcome log.",
        ],
        drillPrompt:
          "At your next 10 deferral objections, use the isolating question — \"is it the price, or the hassle?\" — before answering anything. Log the real concern behind each deferral; by door 10 you will know which two concerns run your territory.",
        quiz: [
          {
            question: "What is \"I'm renting\" usually really asking?",
            options: [
              "Whether fiber reaches rentals",
              "Whether this decision is even theirs to make — answer the permission question and the objection usually evaporates",
              "Whether the deposit is refundable",
              "Whether the landlord gets a commission",
            ],
            answerIndex: 1,
            explanation: "It is half objection, half permission question. The person who pays the internet bill owns the decision — say so plainly and verify the install requirements for rentals.",
          },
          {
            question: "Why is pitching the non-deciding spouse into carrying your message a losing play?",
            options: [
              "They will forget your name",
              "A secondhand pitch loses half its force and all its control — book the joint visit instead",
              "It takes too long",
              "It violates the spouse's privacy",
            ],
            answerIndex: 1,
            explanation: "The deciding spouse hears the weakest version at the worst moment. A booked joint visit keeps the message intact and the close alive.",
          },
          {
            question: "What should you do before answering \"let me think about it\"?",
            options: [
              "Restate the whole pitch",
              "Offer the soft-commit immediately",
              "Isolate the real concern with one question — price, or the hassle of switching",
              "Accept it and leave a flyer",
            ],
            answerIndex: 2,
            explanation: "You cannot answer a concern you have not named. Isolate first, answer second, then — if the hesitation is genuine — pencil the install.",
          },
        ],
      },
      {
        id: "m12-scam-bad-notinterested",
        title: "\"Is this a scam,\" \"I had a bad experience,\" \"not interested\"",
        summary: "The trust family — fear, history, and the flat no, handled without pressure.",
        minutes: 6,
        sections: [
          {
            heading: "\"Is this a scam?\"",
            body: [
              "\"Great instinct — you should check. Don't take my word for anything. Here's my rep ID, and here's how you verify without trusting me: Kinetic's official site lists the build areas, and you can call the number on the site — not a number I give you — and ask whether reps are working this street [VERIFY the current verification path with your manager]. I'll wait while you check, or I'll come back after you have.\"",
              "The psychology: the scam question is a gift, not a threat — it means the homeowner is engaged enough to care whether you are real. Reps who get defensive confirm the fear; reps who invite verification dissolve it, because scammers never hand you the tools to check them. Every verification behavior you welcome — the ID, the official website, the call-them-yourself move — builds exactly the trust the question was asking for.",
            ],
          },
          {
            heading: "\"I had a bad experience\"",
            body: [
              "\"What happened?\" Then stop talking and listen to the whole story without defending anything. When they finish: \"That's exactly the stuff that makes people switch for good — installs that don't show, bills that jump, support that reads from a script. Here's what I can put in front of you today, in writing, before you decide anything [VERIFY what your offers guarantee in writing].\"",
              "If the bad experience was with Kinetic itself, honesty is the only move: \"I hear you, and I'm not going to pretend that didn't happen. What I can do is make sure the right people know — and show you what's changed since.\" Log the story in the door note so the next rep does not walk in blind, and mark a follow_up if there is any opening. Defending the company against a customer's own story loses twice: the door, and the customer's respect.",
            ],
          },
          {
            heading: "\"Not interested\"",
            body: [
              "First, sort the brush-off from the real no. A brush-off arrives before you have said anything — it is the state, not the pitch, and the Module 10 state-match applies. A real no arrives after your opener, with eye contact: respect it instantly. \"No problem at all. One thing before I go, then I'm gone: fiber's live on your street now, and if the video calls ever lag, that's the upload — now you know why. Have a good one.\"",
              "Then mark the door not_interested in the app and mean it — never re-pitch a marked door on the same pass. The instant respect is not just manners; it is strategy. The homeowner who got a clean, one-sentence exit remembers the rep who didn't push, and that memory is the only thing that makes next pass's door open differently. Pressure at a real no buys nothing and costs the street.",
            ],
          },
        ],
        keyTakeaways: [
          "Scam questions are engagement — invite verification and hand them the tools to check you [VERIFY the current verification path].",
          "Bad experience: ask, listen fully, never defend — then show what you can put in writing today.",
          "Sort the brush-off from the real no; respect the real no instantly with one memorable fact and a clean exit.",
          "Mark not_interested accurately and never re-pitch a marked door on the same pass — the clean exit is next pass's open door.",
        ],
        drillPrompt:
          "At your next 10 trust-family objections, run the matching script and measure the exit: did the conversation end with the homeowner still talking to you? Log which verification behavior (ID, website, call-them-yourself) landed hardest on scam doors.",
        quiz: [
          {
            question: "Why is \"is this a scam?\" actually good news at the door?",
            options: [
              "It means they will buy out of fear",
              "It means they are engaged enough to care whether you are real — and inviting verification dissolves the fear",
              "It is a legal trap",
              "It means a competitor warned them",
            ],
            answerIndex: 1,
            explanation: "Scammers never hand you verification tools. A rep who welcomes the check builds the exact trust the question was asking for.",
          },
          {
            question: "A homeowner describes a bad past install experience. What is the correct first response?",
            options: [
              "Explain what the company policy actually is",
              "Apologize on behalf of the industry and pitch your reliability",
              "\"What happened?\" — then listen to the whole story without defending anything",
              "Offer a discount for their trouble",
            ],
            answerIndex: 2,
            explanation: "Defending against their own story loses the door and their respect. Full listening first; written, verifiable terms second.",
          },
          {
            question: "Why does instantly respecting a real \"not interested\" pay off later?",
            options: [
              "It doesn't — you should always try twice",
              "It keeps your knock rate up",
              "The clean, one-sentence exit is what the homeowner remembers, and it's what opens the door differently on the next pass",
              "It prevents complaints to the city",
            ],
            answerIndex: 2,
            explanation: "Pressure at a real no buys nothing and costs the street. The memory of the rep who didn't push is next pass's competitive advantage.",
          },
        ],
      },
      {
        id: "m12-competitor-pivot",
        title: "The competitor pivot: Google Fiber, AT&T, and the rest",
        summary: "When to concede gracefully, when to win — and how to mark both in the app.",
        minutes: 6,
        sections: [
          {
            heading: "Know when the door is already won or lost",
            body: [
              "A homeowner on Google Fiber or AT&T Fiber who is genuinely happy has no gap for you to sell into — symmetrical fiber is symmetrical fiber, and pretending otherwise insults their intelligence and your credibility. Concede gracefully: \"If you're on their fiber and it's solid, honestly — keep it. That's a good product. If anything ever changes, you know Kinetic's on this street now.\" Then mark the door accurately — already_customer if they're on Kinetic, not_interested with a note naming the competitor if they're not — so the next pass doesn't waste itself.",
              "Note the map usually already knows: addresses served by a fiber competitor are typically excluded from your working set upstream. If you find yourself standing at one anyway, you are the exception — which means the app needs the accurate outcome more than ever.",
            ],
          },
          {
            heading: "When the competitor is beatable",
            body: [
              "Cable and satellite are a different story — the gap is structural, and you can win on it honestly. Against cable: symmetrical upload, no data caps [VERIFY], no annual contract [VERIFY], and the promo-cliff bill creep from Module 11. Against satellite: latency that video calls and gaming cannot tolerate, weather dropouts, and data thresholds [VERIFY current competitor plan details in your market]. Against fixed wireless: the shared-tower slowdown at peak hours [VERIFY].",
              "The winning frame is never trash-talk: \"I'm not going to tell you your provider is bad — I'll tell you where fiber is structurally different, and you can test both claims tonight.\" Specific, checkable, structural claims beat general disparagement every time, because the homeowner can verify them from their couch — and a claim they verify themselves converts harder than one they simply heard.",
            ],
          },
          {
            heading: "The graceful concession is a long game",
            body: [
              "The conceded door is not a lost door — it is a planted one. The homeowner who heard \"honestly, keep it\" from a Kinetic rep just watched the company choose honesty over a sale, and that story gets told at the fence line. Leave your name and the one fact that matters (\"if the bill ever jumps or the service ever drops, we're lit on your street\"), log the accurate outcome with the competitor named in the note, and let the pass system bring you back when their contract renewal or first outage does the pitching for you.",
            ],
          },
        ],
        keyTakeaways: [
          "Happy competitor-fiber customers have no gap — concede gracefully and mark the door accurately.",
          "Cable, satellite, and fixed wireless lose on structure: upload symmetry, caps, contracts, latency [VERIFY competitor details in your market].",
          "Never trash-talk — offer specific, checkable, structural claims the homeowner can verify tonight.",
          "A graceful concession plants next season's sale: leave your name, one fact, and an accurate log.",
        ],
        drillPrompt:
          "At your next 10 competitor doors, classify each as concede or winnable within the first two answers. Concede gracefully with the script and log the competitor in the note; on winnable doors, make one structural claim and invite the homeowner to test it. Track which classification you got wrong most.",
        quiz: [
          {
            question: "A homeowner is on Google Fiber and genuinely happy. What is the right play?",
            options: [
              "Pitch symmetrical upload anyway",
              "Concede gracefully — \"honestly, keep it\" — and mark the door accurately with the competitor named in the note",
              "Offer a lower price to win the switch",
              "Ask to see their bill to find a gap",
            ],
            answerIndex: 1,
            explanation: "Symmetrical fiber has no structural gap to sell into. The concession earns credibility and a future opening; the accurate log saves the next pass.",
          },
          {
            question: "What makes cable and satellite beatable where competitor fiber is not?",
            options: [
              "Their customers are less loyal",
              "Structural gaps — upload asymmetry, data caps, contracts, latency — that fiber genuinely fixes",
              "Their service areas are shrinking",
              "Their pricing is always higher",
            ],
            answerIndex: 1,
            explanation: "You win where fiber is structurally different, with claims the homeowner can verify from their couch. Structure beats slogans.",
          },
          {
            question: "Why name the competitor in the door note after conceding?",
            options: [
              "So managers can complain to the competitor",
              "So the next pass knows the door is handled and the exact reason why — the log is the team's memory",
              "It is required by law",
              "To track competitor market share for commission",
            ],
            answerIndex: 1,
            explanation: "The map is the team's memory. An accurate note turns your conceded door into saved time and better timing for every future pass.",
          },
        ],
      },
    ],
  },
  // ── M13 — Card on File the Compliant Way ────────────────────────────────────
  {
    id: "m13",
    title: "Card on File the Compliant Way",
    tagline: "Payment details the smooth, legal way — secure form, their hands, their phone.",
    lessons: [
      {
        id: "m13-the-rules",
        title: "The two nevers and the one always",
        summary: "Never paper, never voice — always the secure form. The rules that protect the rep as much as the customer.",
        minutes: 5,
        sections: [
          {
            heading: "The two nevers",
            body: [
              "Never write a card number down — not on paper, not in a notebook, not in a notes app, not in a text message, not in a door note in this app. Never take a card number by voice — the homeowner reading sixteen digits to you on a porch is how numbers end up misheard, overheard, and misused. There is no experienced-rep exception to either rule, because the rules are not about trust in you; they are about removing you from the path the number travels.",
            ],
          },
          {
            heading: "The one always",
            body: [
              "Always: the customer enters their own payment details into the secure checkout form or payment link — on their own phone where possible, on your device with them typing where not. You never see the full number, you never touch the card, and the confirmation goes to them directly. Confirm the exact secure-payment flow for the current build of the app with your manager before your first close [VERIFY] — the screens change, the rule does not.",
              "The whole module in one sentence, the way you say it at the door: \"Here's how we do payment — you type it yourself into the secure form, I never see the number, and the receipt goes straight to your email.\" Memorize it. Said early and casually, it pre-answers the objection Module 13's third lesson handles in full.",
            ],
          },
          {
            heading: "Why this protects you, not just them",
            body: [
              "Reps sometimes experience payment security as friction imposed on the sale. Reframe it: it is armor built around the rep. When a customer later disputes a charge or claims misuse, the rep who never saw the number has a complete defense — the record shows the customer typed it into a secure form themselves. The rep who wrote it on paper has nothing but their word. Compliance also builds the sale: a customer who watches you insist on the secure flow learns, at the exact moment of maximum suspicion, that this company handles their money more carefully than they expected. That lesson converts.",
            ],
          },
        ],
        keyTakeaways: [
          "Never write a card number anywhere — paper, notes apps, texts, and door notes are all violations.",
          "Never take a number by voice; misheard, overheard, and misused all start there.",
          "Always: the customer types their own details into the secure form, on their phone where possible [VERIFY current flow].",
          "Compliance is the rep's armor: if you never saw the number, no dispute can touch you.",
        ],
        drillPrompt:
          "Before your next shift, walk the current secure-payment flow on your own device twice until you can do it without thinking. At your next close, narrate the security out loud as the customer types — \"you'll see the confirmation hit your email in a second\" — and notice what it does to their posture.",
        quiz: [
          {
            question: "A customer offers to read you their card number to save time. What do you do?",
            options: [
              "Take it — the customer consented",
              "Write it down but destroy the paper after",
              "Decline and hand them the secure form — voice and paper are never acceptable paths for a card number",
              "Type it into the door note for later",
            ],
            answerIndex: 2,
            explanation: "Customer consent does not change the rule. The number must travel only through the secure form, typed by the customer — no exceptions for convenience.",
          },
          {
            question: "Why do the payment rules protect the rep, not just the customer?",
            options: [
              "They speed up commission payout",
              "If a charge is ever disputed, the rep who never saw the number has a complete defense — the record shows the customer typed it themselves",
              "They reduce data entry errors",
              "They keep the rep's phone storage clean",
            ],
            answerIndex: 1,
            explanation: "The secure flow creates a record that removes you from the payment path entirely. The rep who wrote the number on paper has only their word.",
          },
          {
            question: "What does insisting on the secure flow do for the sale itself?",
            options: [
              "Nothing — it's pure friction",
              "It slows the close but avoids liability",
              "At the moment of maximum suspicion, it teaches the customer this company handles money more carefully than expected — and that converts",
              "It lets you skip the confirmation step",
            ],
            answerIndex: 2,
            explanation: "Payment time is when trust is most fragile. Watching a rep insist on security is a live demonstration of the company's character.",
          },
        ],
      },
      {
        id: "m13-secure-form-script",
        title: "Verbatim: the secure-form handoff",
        summary: "The exact words for the smoothest thirty seconds in the whole close.",
        minutes: 5,
        sections: [
          {
            heading: "The handoff, verbatim",
            body: [
              "\"Last step — and this part's designed to protect you. Payment goes through the secure form, and you enter it yourself, on your phone. I never see the number, and that's on purpose: it protects you, and it protects me. You'll get the confirmation in your email within a minute.\"",
              "Then the mechanics: pull up the secure checkout on your device or send the payment link to theirs [VERIFY current flow], hand it over or watch them open it, and physically turn your attention away while they type — look at the street, check the install calendar, give them privacy. When the confirmation lands, point at their screen, not yours: \"There it is — you're set for Tuesday.\"",
            ],
          },
          {
            heading: "Why the framing matters",
            body: [
              "The same action — handing someone a payment form — reads as either pressure or protection depending entirely on your thirty seconds of framing. \"I need your card\" raises every defense. \"You enter it yourself; I never see it; that's on purpose\" lowers them all, because it answers the customer's unspoken question — why should I trust this stranger with my card? — before they have to ask it. You are not downplaying the payment step; you are starring its security as a feature.",
            ],
          },
          {
            heading: "The small behaviors that sell it",
            body: [
              "Hand the phone over promptly — hesitation reads as reluctance to give up control. Look away while they type, visibly and obviously. Narrate the milestones out loud: the secure page, the masked number, the confirmation email. Each behavior is a proof, and proofs stack: by the time the confirmation email lands, the customer has watched three separate demonstrations that their card was safer with you than it is in their own wallet. That feeling is what they describe to the neighbor who asks about the salesperson who came by.",
            ],
          },
        ],
        keyTakeaways: [
          "The script: secure form, you type it, I never see it, that's on purpose, confirmation in your email.",
          "Framing decides everything — the same form reads as pressure or protection depending on your thirty seconds.",
          "Answer the unspoken trust question before it gets asked; star the security as a feature.",
          "Hand over promptly, look away visibly, narrate the milestones — proofs stack into a story the customer retells.",
        ],
        drillPrompt:
          "Rehearse the handoff script verbatim five times before your next shift, including the physical look-away. At your next 3 closes, narrate each milestone out loud and log the customer's reaction at the confirmation email — that moment is your referral seed.",
        quiz: [
          {
            question: "What does \"I never see the number, and that's on purpose\" accomplish?",
            options: [
              "It shifts liability to the customer",
              "It answers the customer's unspoken trust question before they have to ask it",
              "It lets you skip PCI training",
              "It speeds up the form",
            ],
            answerIndex: 1,
            explanation: "The unasked question — why should I trust you with my card? — gets answered with the design of the process itself. Defenses lower when the answer arrives unrequested.",
          },
          {
            question: "While the customer types their payment details, where should your attention be?",
            options: [
              "On the screen, helping them along",
              "Visibly elsewhere — the street, the install calendar — giving obvious privacy",
              "On the next door you'll knock",
              "On their body language for upsell signals",
            ],
            answerIndex: 1,
            explanation: "The visible look-away is a proof, not a courtesy. It demonstrates the privacy you just claimed, and proofs stack.",
          },
          {
            question: "Why narrate the confirmation email out loud when it lands?",
            options: [
              "To fill awkward silence",
              "It closes the proof loop — the customer sees the system working exactly as you described it",
              "To confirm the email address is correct",
              "It is required for commission",
            ],
            answerIndex: 1,
            explanation: "Each narrated milestone demonstrates that reality matches your framing. The final proof — confirmation in their inbox — is the story they retell to neighbors.",
          },
        ],
      },
      {
        id: "m13-no-card-objection",
        title: "\"I don't give my card out\"",
        summary: "The hardest payment objection — validate it, route around it compliantly, never workaround it.",
        minutes: 5,
        sections: [
          {
            heading: "Validate first — the objection is rational",
            body: [
              "\"Totally understand — most people who say that got burned once. I'm the same way with my card.\" This is not a technique; it is the truth, and saying it first changes what the conversation is about. The customer arrived braced for a rep who would push past their boundary. When you honor the boundary instead, the conversation stops being about whether to trust you and becomes about which compliant path works for them.",
            ],
          },
          {
            heading: "The compliant routes around it",
            body: [
              "Depending on current policy, there are usually several legitimate paths, and you must confirm which ones are live before offering them [VERIFY current payment policy with your manager]. Autopay framing: if autopay is not required, say so plainly — \"the card on file is for the first bill; you're not locked into autopay\" [VERIFY]. Pay-later framing: some offers let the customer complete payment through the official online checkout after the visit, from their own couch [VERIFY]. Install-first framing: where policy allows, book the install now and the customer finishes payment through the official channel before the truck rolls [VERIFY].",
              "Notice what every route has in common: the number still only ever travels through the official secure channel. The customer's rule — I don't hand my card to people — is fully honored; you have simply moved the moment and the device.",
            ],
          },
          {
            heading: "The workaround is never worth it",
            body: [
              "If none of the compliant routes fit, the answer is a follow_up with the secure payment link — never a workaround. Taking the number \"just this once\" to save a sale is how reps lose the sale, the commission, and the job in a single afternoon: the first dispute or the first audit unwinds everything, and the door note history in this app means the unwinding is fully traceable. A lost sale is a statistic. A compliance violation is a career event. Treat them accordingly.",
            ],
          },
        ],
        keyTakeaways: [
          "Validate the boundary first — most people who guard their card got burned once, and honoring the rule reframes the whole conversation.",
          "Compliant routes: autopay-not-required framing, official online checkout later, install-first-then-pay — all [VERIFY current policy].",
          "Every legitimate route keeps the number inside the official secure channel; you only move the moment and the device.",
          "No route fits? Follow_up with the secure link. A workaround unwinds the sale, the commission, and the career.",
        ],
        drillPrompt:
          "Role-play this objection three times with a teammate before your next shift: validate, offer two verified compliant routes, and land the follow_up if neither fits. In the field, log which route your territory's card-guarders choose most — that route becomes your default offer.",
        quiz: [
          {
            question: "What is the correct first response to \"I don't give my card out\"?",
            options: [
              "Explain the company's security certifications",
              "Validate the boundary — most people who say it got burned once — then offer compliant routes",
              "Assure them you're trustworthy",
              "Offer to hold the card while they decide",
            ],
            answerIndex: 1,
            explanation: "The customer is braced for pressure. Honoring the boundary first converts the conversation from trust-you-or-not to which-path-works.",
          },
          {
            question: "What do all compliant routes around the card objection have in common?",
            options: [
              "They avoid taking payment entirely",
              "The number still travels only through the official secure channel — you move the moment and the device, never the channel",
              "They require manager approval",
              "They postpone the install",
            ],
            answerIndex: 1,
            explanation: "Autopay framing, online checkout later, install-first — every legitimate path keeps the card inside the secure system. Only the timing changes.",
          },
          {
            question: "A workaround would save today's sale. Why refuse it anyway?",
            options: [
              "Workarounds are slower",
              "The first dispute or audit unwinds the sale, the commission, and the job — and the app's history makes it fully traceable",
              "Customers dislike workarounds",
              "It violates the price list",
            ],
            answerIndex: 1,
            explanation: "A lost sale is a statistic; a compliance violation is a career event. The logged history means there is no such thing as an untraceable shortcut.",
          },
        ],
      },
    ],
  },
  // ── M14 — The Installation Close ────────────────────────────────────────────
  {
    id: "m14",
    title: "The Installation Close",
    tagline: "Assumptive closes that put a truck on the calendar before you leave the porch.",
    lessons: [
      {
        id: "m14-two-day-choice",
        title: "The two-day-choice close",
        summary: "\"Tuesday morning or Thursday afternoon?\" — the assumptive close that ends every strong pitch.",
        minutes: 5,
        sections: [
          {
            heading: "The mechanics",
            body: [
              "When the value conversation lands — the homeowner has nodded at the numbers, asked a logistics question, or compared plans out loud — do not ask whether they want to schedule. Ask which slot: \"I've got Tuesday morning or Thursday afternoon on your street — which works better for you?\" Then go quiet and let them check their calendar, which is the physical act of deciding.",
              "The two options must be real slots in the real install calendar from the app. If Tuesday fills while you stand there, offer the next real pair without blinking. The close's power comes entirely from its honesty — you are a person with a live calendar offering genuine capacity, not a trick question with dates attached.",
            ],
          },
          {
            heading: "Why it works",
            body: [
              "Choice architecture: \"do you want to schedule?\" presents a yes/no decision where no is the safe, effort-free answer. \"Tuesday or Thursday?\" presumes the yes and moves the decision to logistics — and logistics questions are easier to answer than commitment questions, so the homeowner answers the easy one and arrives at the commitment through it. Both options being yeses is not manipulation; it is respect for how decisions actually get made on porches, by tired people, at 6 p.m.",
              "The psychology underneath is decision fatigue: every additional open question you leave standing costs energy the homeowner does not have. The two-day choice collapses the decision to one small, concrete, answerable question — and a question they can answer is a question they will answer.",
            ],
          },
          {
            heading: "Variants and the \"neither\" answer",
            body: [
              "The install-window variant works the same way one level down: \"Morning window or evening window?\" Use it when the day is settled but the timing is not. And when they say neither day works, that is not a failed close — it is a scheduling question wearing a no costume: \"What day do you usually have off? Let me check that one.\" Pull up the calendar, find their day, offer the window. The homeowner who negotiates the date with you is closing; the calendar is where the close happens, so keep them standing in it.",
            ],
          },
        ],
        keyTakeaways: [
          "Never ask whether they want to schedule — ask which of two real slots works better.",
          "Both options are yeses: the decision moves from commitment to logistics, which tired people can actually answer.",
          "Only offer slots that exist in the app's live calendar — the close's power is its honesty.",
          "\"Neither works\" is a scheduling question — find their day and keep them standing in the calendar.",
        ],
        drillPrompt:
          "At your next 10 closes, use the two-day choice verbatim and count to four in silence after asking. Log how often the homeowner physically pulls out their phone to check their calendar — that reach is the close happening in front of you.",
        quiz: [
          {
            question: "Why is \"Tuesday morning or Thursday afternoon?\" stronger than \"Do you want to schedule an install?\"",
            options: [
              "It sounds more confident",
              "It presumes the yes and moves the decision to logistics — an easier question that carries the commitment inside it",
              "It limits the install team's workload",
              "It creates false urgency",
            ],
            answerIndex: 1,
            explanation: "Yes/no questions make no the effortless answer. A choice between two real slots makes the homeowner answer logistics — and arrive at yes through them.",
          },
          {
            question: "What must be true of the two slots you offer?",
            options: [
              "They must be this week",
              "They must be real capacity in the app's live install calendar",
              "They must be mornings",
              "They must match the neighbor's install day",
            ],
            answerIndex: 1,
            explanation: "The close works because it is honest — genuine capacity, genuinely offered. Invented slots unravel at the first scheduling call.",
          },
          {
            question: "The homeowner says neither Tuesday nor Thursday works. What is happening?",
            options: [
              "The close failed — mark not_interested",
              "A scheduling question is wearing a no costume — ask what day works for them and check the calendar",
              "They want a discount first",
              "They need to think about it",
            ],
            answerIndex: 1,
            explanation: "Negotiating the date is closing behavior. Keep them in the calendar — that is where the close completes.",
          },
        ],
      },
      {
        id: "m14-trial-soft-commit",
        title: "The trial close and the pencil-in",
        summary: "\"Let me just check the schedule\" — testing readiness without asking for a decision, and the soft-commit for genuine hesitation.",
        minutes: 5,
        sections: [
          {
            heading: "The trial close: \"let me just check the schedule\"",
            body: [
              "Before the two-day choice, when you are not sure the value has landed, test the water with the trial close: \"Let me just check what the install schedule looks like for your street.\" Then pull up the calendar and narrate what you see. The homeowner's reaction to you browsing their install slots tells you everything: leaning in, asking about days, checking their own calendar — proceed to the two-day choice. Stepping back, arms crossing, \"oh I wasn't saying I wanted it\" — return to value, because you tried to close a sale that does not exist yet.",
              "The trial close works because it asks for nothing. The homeowner has not agreed to anything, so there is nothing to refuse — yet their behavior around the calendar reveals their readiness more honestly than any answer to \"so what do you think?\" would.",
            ],
          },
          {
            heading: "The soft-commit: penciling them in",
            body: [
              "For genuine think-about-it hesitation — real deliberation, not a hidden no — the soft-commit: \"Tell you what. I'll pencil you in for Thursday's window while you decide. There's no charge to cancel [VERIFY cancellation policy], and it holds your slot — if it's not a fit, one text and it's off the calendar. Sound fair?\"",
              "The psychology: open-ended deliberation has no forcing function, so it defaults to forgetting. A penciled install converts deliberation into a dated decision — the homeowner now decides by Thursday, with a concrete thing to keep or cancel, and keeping is the path of least resistance. The soft-commit only works because cancellation is genuinely easy [VERIFY]; a slot that is hard to cancel is not a soft-commit, it is a trap, and traps generate cancellations, complaints, and chargebacks at triple the rate of honest holds.",
            ],
          },
          {
            heading: "The ethics line you never cross",
            body: [
              "A penciled install must be real: actually booked in the system, actually cancellable for free [VERIFY], actually followed up by you before the window. Three failure modes to never commit: penciling someone who said no (that is a booking without consent), inventing the cancel-for-free part (that is a lie with a truck attached), and forgetting the follow-up (that is a surprise truck, and surprise trucks become disputes). The soft-commit is a service you perform for a genuinely deciding customer. The moment it becomes a numbers trick, it is the worst thing in this module.",
            ],
          },
        ],
        keyTakeaways: [
          "Trial close: browse their install slots out loud — the reaction tells you whether to close or return to value.",
          "The trial close asks for nothing, so there is nothing to refuse — and readiness reveals itself honestly.",
          "Soft-commit: pencil the slot with genuinely free cancellation [VERIFY], converting open deliberation into a dated decision.",
          "Ethics line: real booking, real cancellation, real follow-up — anything less is a trap, not a close.",
        ],
        drillPrompt:
          "At your next 10 pitches, run the trial close before the two-day choice and log the reaction (lean-in vs. step-back). Use the soft-commit only on genuine deliberation, and follow up every penciled slot the evening before — count how many hold.",
        quiz: [
          {
            question: "What does the trial close actually test?",
            options: [
              "Whether the calendar has openings",
              "The homeowner's readiness — their behavior around the calendar reveals it without asking for any decision",
              "Whether they understood the pricing",
              "Whether the address is serviceable",
            ],
            answerIndex: 1,
            explanation: "It asks for nothing, so nothing can be refused — and the homeowner's reaction to the calendar tells you honestly whether to close or return to value.",
          },
          {
            question: "Why does the pencil-in work on genuine deliberation?",
            options: [
              "It locks the customer into a contract",
              "It converts open-ended deliberation — which defaults to forgetting — into a dated decision where keeping is the path of least resistance",
              "It creates artificial scarcity",
              "It commits the install crew",
            ],
            answerIndex: 1,
            explanation: "Deliberation without a forcing function evaporates. A real, easily-cancellable slot gives the decision a date and a default.",
          },
          {
            question: "Which of these is a legitimate soft-commit?",
            options: [
              "Penciling in a customer who said no, in case they warm up",
              "Telling them cancellation is free without checking policy",
              "Booking a real slot for a genuinely deciding customer, with verified free cancellation, and following up before the window",
              "Skipping the follow-up to let the truck surprise them",
            ],
            answerIndex: 2,
            explanation: "Real booking, real cancellation terms, real follow-up. Every shortcut version is a trap that ends in cancellations, complaints, or disputes.",
          },
        ],
      },
      {
        id: "m14-honest-walk-away",
        title: "The honest walk-away",
        summary: "Leaving a real no so well that the door opens for you next pass.",
        minutes: 4,
        sections: [
          {
            heading: "When to walk",
            body: [
              "Walk when the no is real — stated after your opener with eye contact, restated after one honest attempt at the Module 12 answer, or driven by circumstances no pitch fixes: moving next month, house for sale, genuinely locked contract. Walking well is a skill with a payoff structure: the door you leave gracefully is winnable later, and the door you pressure past a real no is lost permanently, along with its fence-line neighbors.",
            ],
          },
          {
            heading: "The walk-away, verbatim",
            body: [
              "\"No pressure at all — I appreciate the time. I'll leave you my number. The fiber's not going anywhere, and honestly neither am I: I'm working this street all month. If the bill jumps or the video calls start dropping, you'll know exactly why — and where to find me.\"",
              "Then leave exactly one memorable fact, not a stack of flyers: the upload explanation for the works-fine household, the promo-cliff warning for the promo-price household. One fact sticks; five brochures hit the recycling before you reach the sidewalk. The fact you leave is the hook the next conversation hangs on — theirs or their neighbor's.",
            ],
          },
          {
            heading: "Logging the walk-away",
            body: [
              "The walk-away is not finished until the app reflects reality. Real no: not_interested. Circumstance with a date — contract ends in spring, moving plans settle in a month: follow_up with the reason and the timing in the note. Never mark a real no as follow_up to keep your pipeline pretty; a fantasy pipeline sends you back to closed doors and keeps you off open ones. And write the one-sentence note for the next pass: \"contract renews in March, hates the promo cliff\" is worth more than a sold pin on the wrong day.",
            ],
          },
        ],
        keyTakeaways: [
          "Walk when the no is real — pressured doors are lost permanently, graceful doors are winnable later.",
          "The script: no pressure, my number, fiber's not going anywhere, neither am I, one memorable fact.",
          "One fact sticks; five brochures hit the recycling. The fact is the hook for the next conversation.",
          "Log reality: not_interested for real no's, follow_up with reason and timing for real circumstances — never a fantasy pipeline.",
        ],
        drillPrompt:
          "At your next 10 real no's, deliver the walk-away verbatim and leave exactly one tailored fact. Log each with the honest outcome and a one-sentence note. Review your notes after the shift and mark the three doors you'd most want handed back to you next pass.",
        quiz: [
          {
            question: "Why leave exactly one memorable fact instead of a stack of flyers?",
            options: [
              "Flyers are expensive",
              "One tailored fact sticks and becomes the hook the next conversation hangs on; five brochures hit the recycling before you reach the sidewalk",
              "It saves time between doors",
              "It avoids paper waste rules",
            ],
            answerIndex: 1,
            explanation: "Memory holds one thing. Choose the fact that matches their situation and it becomes the reason they call — or the reason the next pass opens warm.",
          },
          {
            question: "A homeowner's contract ends in four months and they ask you to come back then. The correct outcome is:",
            options: [
              "not_interested — they said no today",
              "follow_up with the reason and timing in the note",
              "sold — it's basically a future sale",
              "Leave it unmarked and remember it",
            ],
            answerIndex: 1,
            explanation: "A circumstance with a date is a real follow_up — and the note with reason and timing is what makes next pass's door open warm.",
          },
          {
            question: "Why not mark a real no as follow_up to keep the pipeline looking healthy?",
            options: [
              "Managers audit follow_ups",
              "A fantasy pipeline sends you back to closed doors and keeps you off open ones — the map only works if it reflects reality",
              "follow_ups expire automatically",
              "It affects your commission",
            ],
            answerIndex: 1,
            explanation: "The log is navigation, not decoration. Inflated pipelines route future-you to dead doors while live ones age out.",
          },
        ],
      },
    ],
  },
  // ── M15 — Door Discipline and the Daily System ──────────────────────────────
  {
    id: "m15",
    title: "Door Discipline and the Daily System",
    tagline: "Pacing, logging, compliance, and safety — the boring system that compounds.",
    lessons: [
      {
        id: "m15-territory-pacing",
        title: "Territory pacing and the honest door count",
        summary: "Thirty to forty-five real doors a day, worked in passes — what a working day actually looks like.",
        minutes: 5,
        sections: [
          {
            heading: "The honest numbers",
            body: [
              "A real working day is thirty to forty-five doors knocked — not doors driven past, not doors glanced at, doors where you stood on the porch and knocked. Dense blocks run toward the top of the range; rural sprawl with long driveways runs under it. Out of those knocks, expect roughly a third to answer and a third of those to become real conversations — which means an honest day yields eight to fifteen conversations, and your close rate does the rest from Module 1's math.",
              "Anyone promising you eighty quality doors a day is selling you a fantasy that ends in skipped logging and burned territory. The reps who last are not the ones who knock the most doors once; they are the ones who knock an honest count every day, log every one, and let the passes compound.",
            ],
          },
          {
            heading: "Work in passes, not in wanders",
            body: [
              "Territory pays when it is swept systematically. Work the map in passes: sweep a block, log every door, and let the app carry the memory — not-home doors resurface as next-door candidates on your next pass, sold and do-not-knock doors stay frozen out of the working set. Wandering to whatever street feels lucky today produces Swiss-cheese territory: half-knocked blocks, double-knocked neighbors, and no momentum story anywhere.",
              "The not-home door is the most underworked asset in the territory. A door that was empty at 11 a.m. is a different door at 6 p.m. Schedule your second pass of a block for a different hour than the first, and watch a third of your territory's \"dead\" doors come alive.",
            ],
          },
          {
            heading: "Pace the day around the golden window",
            body: [
              "Structure the day: mid-morning doors for the at-home crowd — retirees, remote workers, stay-at-home parents — then a midday break when answer rates crater, then the 5:30 to 7:30 golden window when working households are home and both decision-makers are reachable. Protect the golden window the way closers protect their best pitch: it is worth two of any other hour. And start on time — the first hour of the day sets the knock rhythm, and a day that starts at noon never finds one.",
            ],
          },
        ],
        keyTakeaways: [
          "Honest day: thirty to forty-five real knocks, eight to fifteen real conversations — then close rate does the rest.",
          "Work the map in passes; wandering produces Swiss-cheese territory and double-knocked neighbors.",
          "Not-home at 11 a.m. is a different door at 6 p.m. — re-pass blocks at a different hour.",
          "Protect the 5:30 to 7:30 golden window; start on time, because the first hour sets the rhythm.",
        ],
        drillPrompt:
          "For your next 5 working days, log your honest count: doors knocked, answered, conversations, sales. Compute your own funnel from Module 1 and find which stage is leaking. Re-pass one morning block in the evening golden window and compare answer rates.",
        quiz: [
          {
            question: "What is an honest expectation for doors knocked in a real working day?",
            options: [
              "Eighty to a hundred",
              "Thirty to forty-five, depending on territory density",
              "Ten to fifteen",
              "As many as physically possible",
            ],
            answerIndex: 1,
            explanation: "Thirty to forty-five real knocks, honestly logged, beats an inflated count that ends in skipped logging and burned territory.",
          },
          {
            question: "Why work territory in passes instead of wandering to lucky-feeling streets?",
            options: [
              "Passes are required by management",
              "Systematic sweeps let the app carry the memory; wandering leaves half-knocked blocks, double-knocks, and no momentum story",
              "Passes save gas",
              "Lucky streets run out",
            ],
            answerIndex: 1,
            explanation: "The pass system plus the map is what makes territory compound. Wandering spends territory without banking any of it.",
          },
          {
            question: "What is the correct treatment for a block full of morning not-homes?",
            options: [
              "Mark them not_interested",
              "Skip the block permanently",
              "Re-pass it during the 5:30 to 7:30 golden window — the same door is a different door at a different hour",
              "Leave flyers on every door",
            ],
            answerIndex: 2,
            explanation: "Not-home is a timing read, not a verdict. A third of a territory's \"dead\" doors come alive when the pass hour changes.",
          },
        ],
      },
      {
        id: "m15-logging-discipline",
        title: "Every door gets an outcome",
        summary: "The map is the team's memory — and the log is why tomorrow's you knocks smarter.",
        minutes: 5,
        sections: [
          {
            heading: "The rule and the reasons",
            body: [
              "Every knocked door gets an outcome in the app before you reach the next porch: not_home, interested, sold, not_interested, already_customer, or follow_up. Not at the end of the street, not at the end of the day — before the next porch, while the conversation is still accurate in your head. The sixty-second memory decay after a hard door is real; the rep who batches logging is the rep whose notes say \"seemed nice\" about a door that said never come back.",
              "The discipline pays you directly. not_home at 11 a.m. becomes your 6 p.m. re-knock. follow_up with a real callback time becomes the appointment that converts at triple the cold rate. sold through the proper outcome is what mints the commission — a sale that never gets logged as sold is a sale you may never get paid on. Skipped logs create phantom territory: doors that look unworked get double-knocked by teammates, and nothing poisons a street faster than two reps knocking the same annoyed household in one week.",
            ],
          },
          {
            heading: "The map is the team's memory",
            body: [
              "No individual rep remembers four hundred doors. The team that logs honestly never has to: the pin colors, the outcome history, and the door notes hold everything — the promo-cliff complaint at 412, the dog at 418, the contract that ends in March at 422. When you get reassigned or a teammate picks up your block, the map hands them your whole season of learning in one glance. That only works if every rep treats the log as a message to a future colleague, because it is.",
              "Write notes for the reader, not for yourself: \"hates promo pricing, contract renews March, prefers evening\" beats \"nice lady, maybe later.\" One sentence, concrete, forward-looking. The note you write today is the opener some rep — possibly you — uses in three months.",
            ],
          },
          {
            heading: "Callback discipline",
            body: [
              "Every \"come back later\" becomes a callback with a specific day and time, set in the app before you leave the porch, honored exactly. \"Thursday after 5\" is a callback; \"sometime next week\" is a wish. And the honor-exactly part is the product: anyone can promise a return, almost nobody arrives when promised, and the homeowner who watches you pull up at 5:15 on Thursday as agreed has just received a live demonstration of how this company keeps commitments. The kept callback is the highest-converting door in the business — you arrive pre-trusted, which is the whole game.",
            ],
          },
        ],
        keyTakeaways: [
          "Log the outcome before the next porch — batching means inaccurate notes and poisoned streets.",
          "The log pays you: re-knocks, callbacks, and commissions all run through accurate outcomes.",
          "Write notes for the future reader: one concrete, forward-looking sentence.",
          "Callbacks get a specific day and time, honored exactly — the kept callback arrives pre-trusted.",
        ],
        drillPrompt:
          "For your next full day in the field, log every outcome within thirty seconds of leaving each porch and write one forward-looking note per contact. At day's end, audit: any door without an outcome? Any note you couldn't act on in three months? Fix both before clocking out.",
        quiz: [
          {
            question: "Why log the outcome before reaching the next porch instead of at day's end?",
            options: [
              "The app requires it",
              "Memory decays in sixty seconds after a hard door — batched logging produces inaccurate notes and phantom territory",
              "It improves GPS accuracy",
              "Managers watch in real time",
            ],
            answerIndex: 1,
            explanation: "\"Seemed nice\" about a door that said never-come-back is what batched logging produces. Accurate, immediate logs are the whole system.",
          },
          {
            question: "What does \"the map is the team's memory\" mean in practice?",
            options: [
              "Managers can see where you are",
              "Pins, outcome history, and door notes hold what no rep can remember — and hand a whole season of learning to whoever works the block next",
              "The map remembers your commission rate",
              "Sold pins stay visible permanently",
            ],
            answerIndex: 1,
            explanation: "Four hundred doors exceed any human memory. The log is a message to a future colleague — often future you.",
          },
          {
            question: "Why is the kept callback the highest-converting door in the business?",
            options: [
              "Callbacks have better demographics",
              "Arriving exactly when promised is a live demonstration that this company keeps commitments — you arrive pre-trusted",
              "Callback customers forget their objections",
              "It skips the opener entirely",
            ],
            answerIndex: 1,
            explanation: "Almost nobody arrives when they say they will. Doing so proves the company's character before you say a word.",
          },
        ],
      },
      {
        id: "m15-compliance-safety",
        title: "Compliance non-negotiables and safety basics",
        summary: "Do-not-knock is forever, claims get verified, and no sale is worth an unsafe situation.",
        minutes: 5,
        sections: [
          {
            heading: "Suppression respect is permanent",
            body: [
              "A do-not-knock flag is the closest thing this job has to sacred law. When an occupant asks not to be visited again, that flag goes on the door, it stays forever, and it survives every pass reset — the system is built so that a manager clearing a block for a new sweep cannot accidentally reopen it. Never knock a flagged door, never ask a teammate to knock it for you, and never mark a door inaccurately to dodge a suppression. The same respect extends to no-soliciting signage, gated-community rules, and building policies — a sale extracted past a posted boundary is a complaint with a commission attached, and the complaint always outlives the commission.",
              "The phone side has its own hard rules: do-not-call lists govern who you may call and text, and the calling side of this app blocks listed numbers for a reason. A callback number a homeowner gave you at the door is permission for that callback — it is not permission to add them to a campaign. When in doubt, ask your manager before the call, not after the complaint.",
            ],
          },
          {
            heading: "Honesty is a compliance rule, not a style choice",
            body: [
              "Every factual claim in your pitch — speeds, prices, contract terms, install windows, cancellation policy — is either verified against the current offer or it does not leave your mouth. That is what the [VERIFY] tags across this curriculum mean in practice: offers change, and the rep quoting last month's promo is one fact-check away from a cancelled install and a compliance flag. Fabricated urgency is the same violation in a different costume: no fake \"last day,\" no phantom neighbors, no invented deadlines. The map, the calendar, and the current offer sheet give you enough true urgency to close with.",
            ],
          },
          {
            heading: "Safety basics, every day",
            body: [
              "Wear your visible ID on the outside layer. Work daylight when you can, and know the local rules on soliciting hours — many areas restrict evening knocking [VERIFY local ordinances for your territory]. Tell someone your territory before you start and check in when you finish. Give dogs full respect: off the porch, body angled, hands still. Watch weather and traffic, not just the app. And honor the gut rule absolutely: if a porch, a person, or a situation feels wrong, leave — no note, no second look, no sale in this territory is worth an unsafe minute. Mark the door with whatever is accurate and let the next pass decide.",
            ],
          },
        ],
        keyTakeaways: [
          "Do-not-knock is permanent and survives every reset — never knock it, never route around it, never mis-mark to dodge it.",
          "DNC lists govern the phone side; a door-given callback number is permission for that callback only.",
          "Quote only verified current offers — the [VERIFY] tags are a compliance discipline, not a style choice.",
          "Safety: visible ID, daylight, check-ins, dog respect, local curfews [VERIFY], and the absolute gut rule — leave.",
        ],
        drillPrompt:
          "Before your next shift, verify three things and write them down: the current offer terms you'll quote today, the local soliciting-hours rule for your territory, and your check-in contact. At shift's end, audit the day: every claim verified, every boundary honored, every door accurately marked.",
        quiz: [
          {
            question: "A manager resets the block for a new pass. What happens to a do-not-knock door?",
            options: [
              "It becomes knockable again after thirty days",
              "It stays frozen — do-not-knock is permanent and survives every pass reset",
              "It resets like any other door",
              "It switches to follow_up",
            ],
            answerIndex: 1,
            explanation: "The system is built so the occupant's request can never be silently undone — not by a reset, not by a rep, not by a teammate.",
          },
          {
            question: "A homeowner gives you their number for a callback. What may you use it for?",
            options: [
              "Any future campaign",
              "Sharing with the team's text list",
              "That callback — nothing more, unless they give separate permission",
              "Weekly check-ins until they buy",
            ],
            answerIndex: 2,
            explanation: "Door-given permission is specific. DNC rules and basic respect both say the number covers exactly what they agreed to.",
          },
          {
            question: "A porch situation feels wrong but the homeowner seems interested. What do you do?",
            options: [
              "Close fast and leave",
              "Stay on the public side of the threshold",
              "Leave — the gut rule is absolute, and no sale is worth an unsafe minute",
              "Call a teammate to join you at the door",
            ],
            answerIndex: 2,
            explanation: "Interest does not override instinct. Mark the door accurately, leave, and let the next pass decide — the sale is never the priority over safety.",
          },
        ],
      },
    ],
  },
];

// ── Fast-start track ──────────────────────────────────────────────────────────
// "Get ready for doors in 15 minutes." The five highest-leverage lessons, in
// the order a brand-new rep should steep in them: steel yourself, get in the
// door, land the pitch, survive the first no, ask for the sale. Pure id
// references — the lesson content lives once, in TRAINING_MODULES.
export const TRAINING_FAST_START: FastStartStep[] = [
  { lessonId: "m1-rejection-math", why: "Price a no before you take one. This is the head you knock with." },
  { lessonId: "m2-pattern-interrupt", why: "The first sentence that stops the reflex brush-off. No door opens without it." },
  { lessonId: "m3-pitch-skeleton", why: "The whole pitch in 30 seconds: hook, proof, one number, small ask." },
  { lessonId: "m5-agree-bridge", why: "The first no is a reflex. Agree, bridge, and ask again without arguing." },
  { lessonId: "m6-closes", why: "Stop asking whether, start asking which. Book the install and go quiet." },
];

/** The bare lesson ids of the fast-start track, in order. */
export const FAST_START_LESSON_IDS: string[] = TRAINING_FAST_START.map((s) => s.lessonId);

// ── Derived lookups ───────────────────────────────────────────────────────────
export const TRAINING_LESSONS: TrainingLesson[] = TRAINING_MODULES.flatMap((m) => m.lessons);

export const TOTAL_TRAINING_LESSONS = TRAINING_LESSONS.length;

const LESSON_ID_SET = new Set(TRAINING_LESSONS.map((l) => l.id));

/** Server-side validation gate: POST /api/training/lessons/:lessonId/complete
 *  rejects any id not authored in this file. */
export function isTrainingLessonId(id: string): boolean {
  return LESSON_ID_SET.has(id);
}

export function getTrainingLesson(id: string): TrainingLesson | undefined {
  return TRAINING_LESSONS.find((l) => l.id === id);
}

export function getTrainingModuleForLesson(lessonId: string): TrainingModule | undefined {
  return TRAINING_MODULES.find((m) => m.lessons.some((l) => l.id === lessonId));
}

/** Resolve the fast-start track to its lessons, dropping any step whose id no
 *  longer resolves (defensive — tests pin that all ids are real). */
export function getFastStartLessons(): { step: FastStartStep; lesson: TrainingLesson; module: TrainingModule }[] {
  const out: { step: FastStartStep; lesson: TrainingLesson; module: TrainingModule }[] = [];
  for (const step of TRAINING_FAST_START) {
    const lesson = getTrainingLesson(step.lessonId);
    const module = getTrainingModuleForLesson(step.lessonId);
    if (lesson && module) out.push({ step, lesson, module });
  }
  return out;
}
