// ── The guided learning path ──────────────────────────────────────────────────
//
// Thirteen stages in the order a rep actually needs them, from "what am I
// selling" to "how do I stay safe and compliant on a street". Each stage is a
// short sequence of ACTIVITIES: a lesson to read, a reference card to know, a
// deck to drill, a scenario to judge, a pitch to build, a door to practise on.
//
// WHY A PATH ON TOP OF THE EXISTING CURRICULUM
//   shared/trainingContent.ts holds 113 excellent lessons in 23 modules. That
//   is a library, and libraries are where new hires drown. The path does not
//   replace a single lesson: it REFERENCES them by id, in a deliberate order,
//   interleaved with the interactive work that turns reading into behaviour.
//   Completing a path lesson writes the same training_progress row the module
//   list always wrote, so the two views can never disagree about what is done.
//
// PROGRESSIVE DISCLOSURE
//   A stage unlocks when the one before it is complete. That is a nudge, not a
//   wall: `locked` is advisory and every activity remains reachable from the
//   library. A rep who already knows the product should not be forced to click
//   through it, and a supervisor assigning a specific lesson must be able to.
//
// CERTIFICATIONS ARE EARNED, NOT AWARDED
//   Each certification lists the activities it requires and the minimum score
//   where a score exists. Nothing here produces a ranking of reps against each
//   other; see shared/academyProgress.ts for why that is deliberate.

import { getTrainingLesson } from "./trainingContent";
import { ACADEMY_OBJECTION_KEYS, type AcademyObjectionKey } from "./academyObjections";
import type { PersonaId } from "./academyPersonas";

export type ActivityKind =
  | "lesson"
  | "reference"
  | "flashcards"
  | "scenario"
  | "timed_intro"
  | "branching"
  | "roleplay"
  | "pitch_lab"
  | "objection_drill"
  | "fiber_101"
  | "speech_trainer";

export const ACTIVITY_LABELS: Readonly<Record<ActivityKind, string>> = {
  lesson: "Lesson",
  reference: "Reference",
  flashcards: "Flashcards",
  scenario: "Scenario",
  timed_intro: "Timed practice",
  branching: "Branching call",
  roleplay: "Role-play",
  pitch_lab: "Pitch Lab",
  objection_drill: "Objection drill",
  fiber_101: "Fiber 101",
  speech_trainer: "Speech trainer",
};

export type Activity = {
  /** Stable id. Stored in academy_activity_progress. Never rename. */
  id: string;
  kind: ActivityKind;
  title: string;
  /** One line explaining what the rep will do. */
  detail: string;
  /** Honest time estimate in minutes. */
  minutes: number;
  /** For kind "lesson": the id in shared/trainingContent.ts. */
  lessonId?: string;
  /** For kind "reference": the card id in shared/academyReference.ts. */
  cardId?: string;
  /** For kind "roleplay": the persona to practise against. */
  personaId?: PersonaId;
  /** For kind "objection_drill": which objection. */
  objectionKey?: AcademyObjectionKey;
  /** For kind "scenario": the scenario set id. */
  scenarioId?: string;
  /** For kind "branching": the tree id. */
  branchId?: string;
  /** For kind "fiber_101": which half of Fiber 101 this activity opens. */
  fiberSection?: "journey" | "glossary";
  /** Minimum score to count as passed, where the activity produces one. */
  passScore?: number;
};

export type PathStage = {
  /** Stable id. */
  id: string;
  title: string;
  /** What the rep will be able to do when this stage is done. */
  outcome: string;
  activities: Activity[];
};

// ── Scenario quizzes ──────────────────────────────────────────────────────────
// Situational judgement, not recall. Every option is something a real rep has
// done; the wrong ones are wrong for a stated reason, which is where the
// teaching happens.

export type ScenarioQuestion = {
  /** The situation, in the second person, present tense. */
  situation: string;
  options: string[];
  answerIndex: number;
  /** Why the right answer is right AND why the tempting wrong one is wrong. */
  explanation: string;
};

export type ScenarioSet = {
  id: string;
  title: string;
  questions: ScenarioQuestion[];
};

export const SCENARIO_SETS: readonly ScenarioSet[] = [
  {
    id: "scn-product",
    title: "Product judgement",
    questions: [
      {
        situation:
          "A customer says their download speed is already 500 Mbps and asks what they would gain. You know their plan is cable.",
        options: [
          "Tell them fiber is faster and more reliable than anything cable can do.",
          "Ask what their upload figure is, and explain that on cable it is a fraction of the download.",
          "Tell them cable slows down constantly and they probably do not get the speed they pay for.",
          "Move on, since they are already at a high speed.",
        ],
        answerIndex: 1,
        explanation:
          "Their download is genuinely fast and claiming otherwise is both false and checkable. Upload is the asymmetry they have never looked at, and it is on their own bill. Saying cable slows down constantly is the kind of unverifiable swipe that ends technical conversations.",
      },
      {
        situation:
          "A gamer asks what latency they would get. You do not know the figure for this market.",
        options: [
          "Give a typical fiber figure you have heard other reps use.",
          "Say it is much lower than cable, without a number.",
          "Say you do not know the figure and you are not going to guess, and offer to confirm it.",
          "Change the subject to download speed, which you do know.",
        ],
        answerIndex: 2,
        explanation:
          "A customer who asks about latency will check the answer. A guessed number ends the conversation permanently when it turns out wrong, and a vague much lower reads as a dodge to someone technical. Not knowing, said plainly, is the only answer that survives verification.",
      },
      {
        situation:
          "A household says their wifi is terrible in the back bedroom and asks if fiber fixes it.",
        options: [
          "Yes, fiber solves wifi coverage problems.",
            "Explain that fiber changes the line into the house, not the wireless coverage inside it, and that coverage is a separate conversation.",
          "Avoid the question and pivot to price.",
          "Tell them the included equipment will definitely cover the whole house.",
        ],
        answerIndex: 1,
        explanation:
          "Fiber is the line to the house. Wireless coverage inside is a different problem with different fixes. Promising it is solved sets up a cancel and a bad review, and both cost more than the sale was worth.",
      },
    ],
  },
  {
    id: "scn-ethics",
    title: "Ethical judgement",
    questions: [
      {
        situation:
          "A customer has said no twice, politely. You believe they would benefit and you have one more angle you have not used.",
        options: [
          "Use the angle. They have not heard it yet, so it is not really a third push.",
          "Ask them why they keep saying no, so you can address it.",
          "Thank them, leave one true piece of information, and go.",
          "Tell them you will come back tomorrow when they have thought about it.",
        ],
        answerIndex: 2,
        explanation:
          "Two refusals is where the conversation ends. Reframing the third push as a new angle is exactly the rationalisation this program is built to remove, and asking someone to justify their no puts them on trial on their own porch.",
      },
      {
        situation:
          "You genuinely counted four houses on the street that connected last week. A rep on your team says he tells people the whole street is switching.",
        options: [
          "Say the whole street is switching, since it is close enough and it works.",
          "Say four houses on this street connected last week, and name them by street position if asked.",
          "Say most of your neighbors have already switched.",
          "Avoid social proof entirely, since it cannot be verified.",
        ],
        answerIndex: 1,
        explanation:
          "Verifiable social proof is one of the strongest tools you have, and it only works while it is true. Neighbors compare notes; one inflated claim burns the street for every rep who comes after you.",
      },
      {
        situation:
          "An elderly customer seems unsure who you are, repeats questions, and cannot follow the plan comparison.",
        options: [
          "Simplify to one plan and complete the order so it is not confusing.",
          "Ask if there is a family member who usually helps with decisions like this, leave written information, and do not take an order today.",
          "Come back tomorrow and try again when they are less tired.",
          "Explain more slowly until they agree.",
        ],
        answerIndex: 1,
        explanation:
          "Someone who cannot follow what they are agreeing to cannot consent to it. This is an escalation situation, not a pacing problem, and completing an order here is the most serious mistake available at a door.",
      },
    ],
  },
  {
    id: "scn-compliance",
    title: "Compliance judgement",
    questions: [
      {
        situation:
          "A customer asks how you got their address and sounds annoyed.",
        options: [
          "Say it is public information that anyone can look up.",
          "Say you do not have their personal information, that you are walking the address list for streets where the build finished, and offer to take the address off the list.",
          "Say the company gave it to you and you do not know the details.",
          "Apologise and leave immediately without answering.",
        ],
        answerIndex: 1,
        explanation:
          "This is a privacy question and it deserves a precise privacy answer. Distinguishing an address list from personal data is the substance; offering the opt-out before they ask is what turns the complaint into trust. Vagueness reads as evasion.",
      },
      {
        situation: "There is a no soliciting sign on the door. The house looks like a strong prospect.",
        options: [
          "Knock anyway, since the sign is probably about other companies.",
          "Leave a flyer in the door without knocking.",
          "Do not knock, do not leave anything, and log the address so future passes skip it.",
          "Knock and open by acknowledging the sign.",
        ],
        answerIndex: 2,
        explanation:
          "The sign is the request. Wedging material in the door is still contact, and it is the version that generates complaints because it proves you saw the sign and continued.",
      },
      {
        situation:
          "A customer wants to sign up and starts reading their card number out loud on the porch.",
        options: [
          "Write it down carefully and enter it later in the app.",
          "Stop them, and complete payment through the approved flow in the app in front of them.",
          "Take a photo of the card so nothing is transcribed wrong.",
          "Enter it as they read it, since that is the fastest way.",
        ],
        answerIndex: 1,
        explanation:
          "A card number that exists anywhere other than the approved flow is a breach, including on paper for two minutes and including in a photo you intend to delete. Stopping a customer from reading it aloud is part of the job.",
      },
    ],
  },
  {
    id: "scn-underground",
    title: "The build, at the door",
    questions: [
      {
        situation:
          "A homeowner points at orange paint and little flags across their lawn and asks, annoyed, whether you people are about to tear up the yard.",
        options: [
          "Reassure them the yard will look exactly like it does now when everything is finished.",
          "Explain the flags mark the utilities already buried there, done before any drilling so the bore can steer around them, and that the machine tunnels underneath rather than trenching through.",
          "Tell them you are with sales and construction questions are not your department.",
          "Say the flags mean their address is next on the build schedule.",
        ],
        answerIndex: 1,
        explanation:
          "The flags are the markout of existing utilities, and explaining that turns a complaint into evidence of care: the crew looked before it drilled. Promising a perfect yard is a claim you cannot back, dodging to another department wastes the easiest trust-building question you will ever get, and the flags say nothing about the schedule.",
      },
      {
        situation:
          "A customer says fiber sounds fragile: it is glass, and glass breaks. They ask why they should trust it through a storm over the cable line they already have.",
        options: [
          "Explain the glass runs inside conduit underground, below weather entirely, while the coax it replaces hangs on poles or ages in older ground lines, and that no powered equipment sits in the field to fail in an outage.",
          "Tell them fiber is unbreakable and they will never have an outage again.",
          "Admit glass does break and steer the conversation to price instead.",
          "Say storms are rare here so it does not matter much either way.",
        ],
        answerIndex: 0,
        explanation:
          "The honest mechanism is the persuasive one: buried conduit is out of the weather, and a passive network leaves nothing powered outside to fail. Unbreakable and never are on the never-say list for good reason, and abandoning the question concedes a point that was actually yours to win.",
      },
      {
        situation:
          "A resident says the crew left a wire coiled at a green box near their curb weeks ago and nobody came back. They ask if the build was abandoned.",
        options: [
          "Tell them the build is definitely finished and they can order service today.",
          "Say you have no idea and they should call the company.",
          "Explain a coil staged at a pedestal is normal, the line waits there until connections are scheduled, and offer to find out the actual status for their address rather than guessing at a date.",
          "Tell them crews are usually just slow and it will probably get done eventually.",
        ],
        answerIndex: 2,
        explanation:
          "Staged slack at a pedestal is what a build in progress looks like, and saying so answers the real worry. But the status of one address is a fact you do not hold on the porch, so the credible move is naming what you know and offering to confirm what you do not. Declaring it finished, or guessing at timelines, trades ten seconds of confidence for a callback that starts angry.",
      },
    ],
  },
  {
    id: "scn-discovery",
    title: "Discovery judgement",
    questions: [
      {
        situation: "A customer opens with how much is it, before you have said anything else.",
        options: [
          "Explain the value first so the number lands better.",
          "Answer the price plainly, then ask what they are paying now.",
          "Say it depends on the plan and ask what speed they need.",
          "Ask what they are paying now before answering.",
        ],
        answerIndex: 1,
        explanation:
          "Withholding the price to build value is the move every price-sensitive household has seen, and it reads as a trick because it usually is. Answer it, then ask. Asking first, before you have answered, is the softer version of the same dodge.",
      },
      {
        situation: "A customer says their internet is fine, in a tone that suggests it is not.",
        options: [
          "Accept it and leave.",
          "Ask what is wrong with it.",
          "Ask what one thing they would fix about it if they could.",
          "Tell them most people on this street said the same and were wrong.",
        ],
        answerIndex: 2,
        explanation:
          "One small fix is easy to admit; what is wrong with it asks them to condemn their own choice, and they will defend it instead. Telling them their neighbors were wrong makes it a contest.",
      },
    ],
  },
];

const SCENARIO_BY_ID: ReadonlyMap<string, ScenarioSet> = new Map(SCENARIO_SETS.map((s) => [s.id, s]));

export function getScenarioSet(id: string): ScenarioSet | undefined {
  return SCENARIO_BY_ID.get(id);
}

// ── Branching conversations ───────────────────────────────────────────────────
// A short authored tree. Cheaper than the free-text role play and better at one
// specific job: showing a rep that a single sentence changes where the whole
// conversation goes.

export type BranchOption = {
  /** What the rep says. */
  text: string;
  /** Where it leads. */
  next: string;
  /** Quality of this choice, used for the summary at the end. */
  quality: "poor" | "okay" | "strong";
  /** Why, shown after the branch resolves. */
  why: string;
};

export type BranchNode = {
  id: string;
  /** What the customer says at this point. */
  customer: string;
  /** Terminal nodes have no options and carry an outcome. */
  options?: BranchOption[];
  outcome?: "advanced" | "polite_exit" | "lost";
  /** Closing note on a terminal node. */
  note?: string;
};

export type BranchTree = {
  id: string;
  title: string;
  personaId: PersonaId;
  /** Set the scene before the first line. */
  setup: string;
  startNodeId: string;
  nodes: BranchNode[];
};

export const BRANCH_TREES: readonly BranchTree[] = [
  {
    id: "branch-busy-dinner",
    title: "The door that opens mid-dinner",
    personaId: "busy_homeowner",
    setup: "Six forty on a Tuesday. You can hear a pan going. She opens the door about a third of the way.",
    startNodeId: "b1",
    nodes: [
      {
        id: "b1",
        customer: "Hey, sorry, I've got something on the stove. What is this about?",
        options: [
          {
            text: "It'll just take a second, I promise. So we're running fiber through the neighborhood and I wanted to tell you about our plans.",
            next: "b1-poor",
            quality: "poor",
            why: "You asked for a second and then spent thirty. She now knows your word is soft, and everything after this is discounted.",
          },
          {
            text: "Then I won't hold you. One line: fiber went in on your street and it runs the same speed up as down. I'm on this block until about six thirty if you want the rest.",
            next: "b1-strong",
            quality: "strong",
            why: "You gave back the time you asked for, left one concrete fact, and named a window instead of demanding a decision. This is the move.",
          },
          {
            text: "No problem, is there a better time I could come back?",
            next: "b1-okay",
            quality: "okay",
            why: "Respectful, but it leaves nothing behind. If she says no better time, the knock produced nothing at all.",
          },
        ],
      },
      {
        id: "b1-poor",
        customer: "I really do have to go. Sorry.",
        outcome: "lost",
        note: "She was never saying no to fiber. She was saying no to this, right now, and you confirmed her read of you in one sentence.",
      },
      {
        id: "b1-okay",
        customer: "I don't really know. Evenings are all like this, honestly.",
        options: [
          {
            text: "I understand. Here's my card, give me a call whenever.",
            next: "b1-okay-end",
            quality: "okay",
            why: "A card with no reason to use it is a card in a drawer. Give her a fact worth remembering with it.",
          },
          {
            text: "Then let me give you the one line now so the knock isn't wasted: fiber went in on your street, same speed up as down, and I'll write the price on this so you're not going off memory.",
            next: "b1-strong",
            quality: "strong",
            why: "You recovered. The leave-behind now carries a specific reason to be looked at.",
          },
        ],
      },
      {
        id: "b1-okay-end",
        customer: "Okay. Thanks.",
        outcome: "polite_exit",
        note: "Clean, but thin. She has your card and no reason to look at it.",
      },
      {
        id: "b1-strong",
        customer: "Okay, that's actually useful. What would the next step look like?",
        options: [
          {
            text: "Great, so let me get some details and we can get you signed up right now.",
            next: "b1-strong-push",
            quality: "poor",
            why: "She has a pan on the stove. Asking for a full order here trades a good impression for a rushed one.",
          },
          {
            text: "Nothing tonight. I'll write the plan and price on this, and I've got Thursday at ten or Saturday at nine if you want a tech to look at the address.",
            next: "b1-strong-end",
            quality: "strong",
            why: "Two concrete options, no order required tonight, and the leave-behind covers the memory problem. This is a real next step.",
          },
        ],
      },
      {
        id: "b1-strong-push",
        customer: "I really can't do this right now. Just leave the card.",
        outcome: "polite_exit",
        note: "You had it and you reached. The information she needed to decide is now competing with a burnt dinner.",
      },
      {
        id: "b1-strong-end",
        customer: "Saturday morning is better. Write it down and I'll look at it tonight.",
        outcome: "advanced",
        note: "Thirty seconds, kept exactly. That is what the time boundary buys you.",
      },
    ],
  },
  {
    id: "branch-former-kinetic",
    title: "The house that already had us",
    personaId: "former_kinetic",
    setup: "Late afternoon. She recognises the company name on your badge before you finish the sentence.",
    startNodeId: "k1",
    nodes: [
      {
        id: "k1",
        customer: "We had Kinetic. It was terrible. Not doing that again.",
        options: [
          {
            text: "That was probably a while ago though, things have really changed since then.",
            next: "k1-poor",
            quality: "poor",
            why: "You just told her that her experience does not count. Everything you say after this is a sales pitch to someone who has stopped listening.",
          },
          {
            text: "Yeah. If you were on the copper line, I believe every word of that. What actually went wrong?",
            next: "k1-strong",
            quality: "strong",
            why: "You agreed, named the likely cause without excusing it, and handed her the floor. She will tell you exactly what to address.",
          },
          {
            text: "I'm sorry to hear that. Can I show you what the new fiber plans look like?",
            next: "k1-okay",
            quality: "okay",
            why: "The apology is fine, but pivoting straight to plans skips the part where she needs to be heard.",
          },
        ],
      },
      {
        id: "k1-poor",
        customer: "No. We've been through this before. Have a good day.",
        outcome: "lost",
        note: "Arguing with a lived experience is the single fastest way to lose a door, and it takes one sentence.",
      },
      {
        id: "k1-okay",
        customer: "I mean, it's the same company. Why would it be different?",
        options: [
          {
            text: "It's a totally different service now, honestly. New network, new everything.",
            next: "k1-poor",
            quality: "poor",
            why: "New everything is a slogan. She needs one physical, checkable difference, not an assurance.",
          },
          {
            text: "Fair question. The honest answer is that it's a different line into the house. What you had was copper. This is fiber, which is a physical replacement, not a rebrand. What went wrong last time?",
            next: "k1-strong",
            quality: "strong",
            why: "One concrete mechanism, no defence of the past, and a question that lets her finish saying the thing she has been holding.",
          },
        ],
      },
      {
        id: "k1-strong",
        customer: "It went out constantly, and it took three weeks to get somebody out here.",
        options: [
          {
            text: "That won't happen this time, I can promise you that.",
            next: "k1-promise",
            quality: "poor",
            why: "You cannot promise a service outcome. She has already been promised once by this company, and that is the whole problem.",
          },
          {
            text: "Three weeks is unacceptable and I'm not going to defend it. What I can tell you is the crew on this street is local and they're here for a few more weeks. If it helps, I'd rather you check that yourself than take my word.",
            next: "k1-end",
            quality: "strong",
            why: "You named the failure without excusing it, gave a verifiable present-tense fact, and invited verification rather than trust.",
          },
        ],
      },
      {
        id: "k1-promise",
        customer: "That's exactly what they said last time.",
        outcome: "lost",
        note: "A promise to someone who was already promised is worth less than nothing. It confirms the pattern.",
      },
      {
        id: "k1-end",
        customer: "So it's not the same line? That's different, I guess. What's it cost?",
        outcome: "advanced",
        note: "She asked the price. That question only arrives after the objection has actually been dealt with.",
      },
    ],
  },
  {
    id: "branch-price-first",
    title: "The household that only asks the price",
    personaId: "price_sensitive",
    setup: "Midday. She opens the door already holding the question.",
    startNodeId: "p1",
    nodes: [
      {
        id: "p1",
        customer: "How much? That's the only part I care about.",
        options: [
          {
            text: "It depends on the plan, but before we get to that, can I ask what you're using it for?",
            next: "p1-poor",
            quality: "poor",
            why: "She asked one question and you asked her a different one. That is a dodge, and on a budget it reads as a warning.",
          },
          {
            text: "Seventy a month, everything included. That's the whole number. What are you paying now?",
            next: "p1-strong",
            quality: "strong",
            why: "Answer, then ask. The number lands as a fact rather than a reveal, and the follow-up question is now earned.",
          },
          {
            text: "Less than you're paying now, I can almost guarantee it.",
            next: "p1-guarantee",
            quality: "poor",
            why: "You do not know her bill, and almost guarantee is a guarantee with a hedge on it. This is the exact claim the never-say list exists for.",
          },
        ],
      },
      {
        id: "p1-poor",
        customer: "That's more than I've got. Thanks anyway.",
        outcome: "lost",
        note: "She never heard a number. She heard a dodge, and filled in the worst one herself.",
      },
      {
        id: "p1-guarantee",
        customer: "You don't know what I'm paying.",
        outcome: "lost",
        note: "Correct. And now every other thing you say is measured against the one you got wrong in the first ten seconds.",
      },
      {
        id: "p1-strong",
        customer: "Okay, and that's the real number? Nothing gets added later?",
        options: [
          {
            text: "Nothing gets added, ever. That price is locked in.",
            next: "p1-locked",
            quality: "poor",
            why: "Locked in forever is not something you can say. It is on the never-say list because it is the promise most likely to become a complaint.",
          },
          {
            text: "Equipment's in it, and there's no install charge. It's a promotional rate for twelve months and then it goes to the standard rate, which I'll write down for you so there's no surprise.",
            next: "p1-end",
            quality: "strong",
            why: "The disclosure said out loud, before being asked, by a rep who is not hiding it. For a budget household this is the entire sale.",
          },
        ],
      },
      {
        id: "p1-locked",
        customer: "Everybody says that and then the bill goes up in a year.",
        outcome: "lost",
        note: "She has been here before. The overclaim did not just fail, it confirmed the pattern she was testing for.",
      },
      {
        id: "p1-end",
        customer: "Okay. Write that down, both numbers.",
        outcome: "advanced",
        note: "Volunteering the part that sounds bad is what makes the part that sounds good believable.",
      },
    ],
  },
];

const BRANCH_BY_ID: ReadonlyMap<string, BranchTree> = new Map(BRANCH_TREES.map((t) => [t.id, t]));

export function getBranchTree(id: string): BranchTree | undefined {
  return BRANCH_BY_ID.get(id);
}

export function getBranchNode(tree: BranchTree, nodeId: string): BranchNode | undefined {
  return tree.nodes.find((n) => n.id === nodeId);
}

// ── The path ──────────────────────────────────────────────────────────────────

export const PATH_STAGES: readonly PathStage[] = [
  {
    id: "stage-product",
    title: "Know what you are selling",
    outcome: "You can explain what fiber is, and what it does not do, without reading anything.",
    activities: [
      { id: "act-product-card", kind: "reference", title: "What fiber actually is", detail: "The technology, in words a homeowner uses.", minutes: 3, cardId: "product-what-fiber-is" },
      { id: "act-fiber-journey", kind: "fiber_101", title: "How fiber gets to the house", detail: "The six-step trip from the hut to the wall, with the analogy for each step.", minutes: 4, fiberSection: "journey" },
      { id: "act-upload-card", kind: "reference", title: "Why upload is the number that matters", detail: "The one specification most households have never checked.", minutes: 3, cardId: "product-upload-explained" },
      { id: "act-install-card", kind: "reference", title: "What the install involves", detail: "The answer behind most stalls.", minutes: 2, cardId: "product-install" },
      { id: "act-fiber-glossary", kind: "fiber_101", title: "Talk the talk", detail: "Every term you will hear, each with the analogy that makes it land.", minutes: 6, fiberSection: "glossary" },
      { id: "act-product-scenario", kind: "scenario", title: "Product judgement", detail: "Three situations where the technically correct answer is also the honest one.", minutes: 4, scenarioId: "scn-product", passScore: 67 },
      { id: "act-underground-scenario", kind: "scenario", title: "The build, at the door", detail: "Flags in the yard, glass in a storm, and the coil nobody came back for.", minutes: 4, scenarioId: "scn-underground", passScore: 67 },
    ],
  },
  {
    id: "stage-benefits",
    title: "Translate features into outcomes",
    outcome: "You can turn any specification into something a household actually feels.",
    activities: [
      { id: "act-problem-first", kind: "lesson", title: "Problem first", detail: "Start where their evening hurts, not where your product starts.", minutes: 5, lessonId: "m3-problem-first" },
      { id: "act-concrete-numbers", kind: "lesson", title: "Concrete numbers", detail: "Why specifics stick and adjectives evaporate.", minutes: 5, lessonId: "m3-concrete-numbers" },
      { id: "act-benefit-cards", kind: "flashcards", title: "Feature to outcome", detail: "Drill the translation until it is reflex.", minutes: 5 },
    ],
  },
  {
    id: "stage-intro",
    title: "The ten-second introduction",
    outcome: "You can open a door in ten seconds with your name, your reason, and a time boundary.",
    activities: [
      { id: "act-approach", kind: "lesson", title: "The approach", detail: "What happens before you say anything.", minutes: 5, lessonId: "m2-approach" },
      { id: "act-ten-second", kind: "lesson", title: "The ten-second pitch", detail: "The whole reason for the knock, in one breath.", minutes: 5, lessonId: "m9-ten-second-pitch" },
      { id: "act-timed-intro", kind: "timed_intro", title: "Ten seconds, out loud", detail: "Say it against the clock until it fits without rushing.", minutes: 5, passScore: 70 },
    ],
  },
  {
    id: "stage-discovery",
    title: "Ask before you pitch",
    outcome: "You ask two questions that tell you exactly which benefit to lead with.",
    activities: [
      { id: "act-archetypes", kind: "lesson", title: "Reading people", detail: "The households you will meet, and what each needs first.", minutes: 5, lessonId: "m4-archetypes" },
      { id: "act-discovery-scenario", kind: "scenario", title: "Discovery judgement", detail: "When to answer and when to ask.", minutes: 3, scenarioId: "scn-discovery", passScore: 50 },
      { id: "act-discovery-blocks", kind: "pitch_lab", title: "Build your discovery", detail: "Pick the two questions you will actually use.", minutes: 5 },
    ],
  },
  {
    id: "stage-psychology",
    title: "Ethical sales psychology",
    outcome: "You can use the mechanics that move people without using the ones that pressure them.",
    activities: [
      { id: "act-reciprocity", kind: "lesson", title: "Reciprocity", detail: "Give first, and mean it.", minutes: 5, lessonId: "m8-reciprocity" },
      { id: "act-social-proof", kind: "lesson", title: "Social proof mechanics", detail: "Why it works, and why it only works while it is true.", minutes: 5, lessonId: "m8-social-proof-mechanics" },
      { id: "act-loss-framing", kind: "lesson", title: "Loss framing", detail: "Honest loss aversion, and the line it must not cross.", minutes: 5, lessonId: "m8-loss-framing" },
      { id: "act-ethics-scenario", kind: "scenario", title: "Ethical judgement", detail: "Three moments where the profitable move and the right move separate.", minutes: 4, scenarioId: "scn-ethics", passScore: 100 },
    ],
  },
  {
    id: "stage-trust",
    title: "Building trust at a door",
    outcome: "A stranger believes you inside thirty seconds, for reasons they can check.",
    activities: [
      { id: "act-authority", kind: "lesson", title: "Authority signals", detail: "Borrowed authority is real authority.", minutes: 5, lessonId: "m8-authority-signals" },
      { id: "act-mirroring", kind: "lesson", title: "Mirroring and pacing", detail: "Matching a person without imitating them.", minutes: 5, lessonId: "m8-mirroring-pacing" },
      { id: "act-privacy-card", kind: "reference", title: "Customer privacy", detail: "What you hold, and what you may say out loud.", minutes: 3, cardId: "compliance-privacy" },
      { id: "act-branch-former", kind: "branching", title: "The house that already had us", detail: "One sentence decides whether this door stays open.", minutes: 5, branchId: "branch-former-kinetic" },
    ],
  },
  {
    id: "stage-pitch",
    title: "Needs-based pitching",
    outcome: "You have your own pitch, assembled from approved blocks, inside the time budget.",
    activities: [
      { id: "act-skeleton", kind: "lesson", title: "The pitch skeleton", detail: "Four beats, thirty seconds.", minutes: 6, lessonId: "m3-pitch-skeleton" },
      { id: "act-pitch-lab", kind: "pitch_lab", title: "Build your pitch", detail: "Assemble it, check it, rehearse it.", minutes: 10 },
      { id: "act-speech-trainer", kind: "speech_trainer", title: "Say it from memory", detail: "Read it, fill the gaps, then deliver it with the script hidden.", minutes: 6 },
      { id: "act-roleplay-remote", kind: "roleplay", title: "Practise on a remote worker", detail: "She has a call in ten minutes and a real upload problem.", minutes: 8, personaId: "remote_worker", passScore: 60 },
    ],
  },
  {
    id: "stage-competitive",
    title: "Competitive positioning",
    outcome: "You compare honestly, on things the customer can verify, without attacking their choice.",
    activities: [
      { id: "act-cable-card", kind: "reference", title: "Cable, compared honestly", detail: "What is real, and what is a swipe.", minutes: 4, cardId: "competitor-cable" },
      { id: "act-wireless-card", kind: "reference", title: "Fixed wireless and satellite", detail: "Where they genuinely win.", minutes: 3, cardId: "competitor-fixed-wireless" },
      { id: "act-tv-bundle-card", kind: "reference", title: "Breaking the TV bundle", detail: "Layer DIRECTV on the fiber and let their own bill do the comparing.", minutes: 4, cardId: "competitor-tv-bundle" },
      { id: "act-competitor-pivot", kind: "lesson", title: "The competitor pivot", detail: "Answering I already have fiber without calling them wrong.", minutes: 5, lessonId: "m12-competitor-pivot" },
      { id: "act-roleplay-spectrum", kind: "roleplay", title: "Practise on a Spectrum customer", detail: "Content, under contract, quietly annoyed about upload.", minutes: 8, personaId: "spectrum_customer", passScore: 60 },
    ],
  },
  {
    id: "stage-objections",
    title: "Objection handling",
    outcome: "You have a practised, ethical answer to every objection you will actually hear.",
    // The drills are generated from the objection list rather than typed out,
    // so adding a new objection can never leave a hole in the path.
    activities: [
      ...ACADEMY_OBJECTION_KEYS.map((key, i): Activity => ({
        id: `act-objection-${key}`,
        kind: "objection_drill",
        title: `Objection ${i + 1}`,
        detail: "Acknowledge, then answer the question actually asked.",
        minutes: 3,
        objectionKey: key,
      })),
      { id: "act-branch-price", kind: "branching", title: "The household that only asks the price", detail: "Answer first, ask second.", minutes: 5, branchId: "branch-price-first" },
      { id: "act-roleplay-skeptic", kind: "roleplay", title: "Practise on a skeptic", detail: "He expects you to overclaim. Do not.", minutes: 8, personaId: "skeptic", passScore: 60 },
    ],
  },
  {
    id: "stage-closing",
    title: "Closing",
    outcome: "You make one concrete ask with two options, and you leave well when the answer is no.",
    activities: [
      { id: "act-closes", kind: "lesson", title: "The closes", detail: "The six that work, and when each one fits.", minutes: 6, lessonId: "m6-closes" },
      { id: "act-two-day", kind: "lesson", title: "The two-day choice", detail: "Never ask whether. Ask which.", minutes: 5, lessonId: "m14-two-day-choice" },
      { id: "act-honest-walk", kind: "lesson", title: "The honest walk-away", detail: "Leaving well is a close, and it is scored as one.", minutes: 5, lessonId: "m14-honest-walk-away" },
      { id: "act-roleplay-satisfied", kind: "roleplay", title: "Practise leaving well", detail: "This household is genuinely happy. The right outcome may be no sale.", minutes: 6, personaId: "satisfied_customer", passScore: 60 },
    ],
  },
  {
    id: "stage-followup",
    title: "Follow-up",
    outcome: "The callbacks you book actually happen, and the install holds.",
    activities: [
      { id: "act-callback", kind: "lesson", title: "Callback architecture", detail: "Why most callbacks evaporate, and what fixes it.", minutes: 5, lessonId: "m19-callback-architecture" },
      { id: "act-install-date", kind: "lesson", title: "Locking the install date", detail: "The sale is not the sale until the tech is in the calendar.", minutes: 5, lessonId: "m6-install-date" },
      { id: "act-post-shift", kind: "reference", title: "After every shift", detail: "Five minutes that compound.", minutes: 2, cardId: "checklist-post-shift" },
    ],
  },
  {
    id: "stage-compliance",
    title: "Compliance",
    outcome: "You know what you may state as fact, and what stops the conversation entirely.",
    activities: [
      { id: "act-claims-card", kind: "reference", title: "What you may state as fact", detail: "The line between a benefit and a claim.", minutes: 4, cardId: "compliance-never-claim", },
      { id: "act-dnc-card", kind: "reference", title: "Do-not-knock and do-not-call", detail: "Lists, signs, and immediate requests.", minutes: 4, cardId: "compliance-dnc" },
      { id: "act-recording-card", kind: "reference", title: "Recording and consent", detail: "Before you press record on anything.", minutes: 3, cardId: "compliance-recording" },
      { id: "act-escalation-card", kind: "reference", title: "When to stop and escalate", detail: "The situations that are not yours to resolve.", minutes: 3, cardId: "compliance-escalation" },
      { id: "act-never-say", kind: "reference", title: "Never say this", detail: "Ten phrases, why each is prohibited, and what to say instead.", minutes: 5, cardId: "never-say-list" },
      { id: "act-compliance-scenario", kind: "scenario", title: "Compliance judgement", detail: "Three doors where the rule is not obvious in the moment.", minutes: 4, scenarioId: "scn-compliance", passScore: 100 },
    ],
  },
  {
    id: "stage-field",
    title: "Field readiness and safety",
    outcome: "You can work a street safely, and you know what to carry on day one.",
    activities: [
      { id: "act-first-day", kind: "reference", title: "Your first day", detail: "What to have, know and do before the first knock.", minutes: 4, cardId: "checklist-first-day" },
      { id: "act-safety-porch", kind: "reference", title: "On the porch", detail: "Positioning, dogs, and never entering a home.", minutes: 3, cardId: "safety-porch" },
      { id: "act-safety-street", kind: "reference", title: "On the street", detail: "Heat, dark, traffic and other people's driveways.", minutes: 3, cardId: "safety-street" },
      { id: "act-branch-busy", kind: "branching", title: "The door that opens mid-dinner", detail: "Give back the time you asked for.", minutes: 5, branchId: "branch-busy-dinner" },
      { id: "act-roleplay-senior", kind: "roleplay", title: "Practise on a senior resident", detail: "Slow down. Pressure here is both wrong and a compliance problem.", minutes: 8, personaId: "senior_resident", passScore: 60 },
    ],
  },
];

export const ALL_ACTIVITIES: readonly Activity[] = PATH_STAGES.flatMap((s) => s.activities);

const ACTIVITY_BY_ID: ReadonlyMap<string, Activity> = new Map(ALL_ACTIVITIES.map((a) => [a.id, a]));

export function getActivity(id: string): Activity | undefined {
  return ACTIVITY_BY_ID.get(id);
}

export function isActivityId(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_BY_ID.has(value);
}

export function getStage(id: string): PathStage | undefined {
  return PATH_STAGES.find((s) => s.id === id);
}

export function stageForActivity(activityId: string): PathStage | undefined {
  return PATH_STAGES.find((s) => s.activities.some((a) => a.id === activityId));
}

export const TOTAL_ACTIVITIES = ALL_ACTIVITIES.length;

/** Total honest minutes for the whole path. */
export const TOTAL_PATH_MINUTES = ALL_ACTIVITIES.reduce((a, act) => a + act.minutes, 0);

/** Every lesson id the path references, so a test can pin that they all exist. */
export function referencedLessonIds(): string[] {
  return [...new Set(ALL_ACTIVITIES.map((a) => a.lessonId).filter((id): id is string => !!id))];
}

/** True when every referenced lesson exists in the curriculum. */
export function pathLessonsResolve(): boolean {
  return referencedLessonIds().every((id) => !!getTrainingLesson(id));
}

// ── Certifications ────────────────────────────────────────────────────────────

export type Certification = {
  id: string;
  title: string;
  /** What earning it means, in one sentence a supervisor would sign off on. */
  meaning: string;
  /** Stages that must be complete. */
  stageIds: string[];
  /** Extra activities that must be passed, beyond stage completion. */
  activityIds?: string[];
  /** Minimum average role-play score across the required role-plays, if any. */
  minRolePlayScore?: number;
};

export const CERTIFICATIONS: readonly Certification[] = [
  {
    id: "cert-door-ready",
    title: "Door ready",
    meaning: "Knows the product, can open a door in ten seconds, and knows what may not be said.",
    stageIds: ["stage-product", "stage-intro", "stage-compliance", "stage-field"],
  },
  {
    id: "cert-conversation",
    title: "Conversation certified",
    meaning: "Asks before pitching, translates features into outcomes, and builds trust honestly.",
    stageIds: ["stage-benefits", "stage-discovery", "stage-psychology", "stage-trust"],
  },
  {
    id: "cert-objection",
    title: "Objection certified",
    meaning: "Has a practised, ethical answer to every field objection in the dojo and has held them under pressure.",
    stageIds: ["stage-objections"],
    minRolePlayScore: 65,
  },
  {
    id: "cert-full",
    title: "Fiber Sales Academy",
    meaning: "Completed the whole path, including closing, follow-up and competitive positioning.",
    stageIds: PATH_STAGES.map((s) => s.id),
    minRolePlayScore: 65,
  },
];

export function getCertification(id: string): Certification | undefined {
  return CERTIFICATIONS.find((c) => c.id === id);
}
