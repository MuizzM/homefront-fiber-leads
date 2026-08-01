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
};

export type TrainingModule = {
  id: string;
  title: string;
  tagline: string;
  lessons: TrainingLesson[];
};

export const TRAINING_MODULES: TrainingModule[] = [
  // ── M1 — The Door Mindset ───────────────────────────────────────────────────
  {
    id: "m1",
    title: "The Door Mindset",
    tagline: "Rejection math, identity, and the habits that keep you knocking.",
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
    ],
  },

  // ── M6 — Closing and Follow-through ─────────────────────────────────────────
  {
    id: "m6",
    title: "Closing and Follow-through",
    tagline: "Assumptive closes, honest urgency, callbacks that happen, and the debrief habit.",
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
];

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
