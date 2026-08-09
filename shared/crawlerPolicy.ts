// ── Keeping crawlers, and AI crawlers in particular, off the portal ─────────
//
// ── WHAT THIS ACTUALLY ACHIEVES, STATED PLAINLY ────────────────────────────
//
// robots.txt is a REQUEST, not a control. Well-behaved crawlers (Google,
// OpenAI, Anthropic, Perplexity, Common Crawl) publish their user-agents and
// honour it. A scraper that wants your data will send a Chrome user-agent and
// ignore all of this.
//
// So this file is two layers with different strengths:
//
//   robots.txt + X-Robots-Tag   asks the honest ones to stay out, and — more
//                               importantly — tells search engines not to index
//                               or cache what they do see.
//   the user-agent block below  actually refuses the request, for the agents
//                               that identify themselves.
//
// THE REAL PROTECTION IS NEITHER OF THOSE. It is that every route serving
// customer data requires a session, so an anonymous crawler — polite or not —
// sees a login page and a JavaScript bundle. Nothing about leads, reps,
// commissions, or territories is reachable without authenticating.
//
// Keep that ordering in mind before adding anything here: a bot blocklist that
// makes people feel protected is worse than useless if it distracts from an
// endpoint that forgot its auth check.

/**
 * Crawlers that identify themselves and are used to build or feed AI systems.
 *
 * Matched case-insensitively as substrings of the User-Agent. Deliberately a
 * conservative list of self-identifying agents — matching on loose keywords
 * like "bot" would block uptime monitors, link previews in a rep's text
 * message, and Slack unfurls.
 */
export const AI_CRAWLER_AGENTS = [
  // OpenAI
  "gptbot", "chatgpt-user", "oai-searchbot",
  // Anthropic
  "claudebot", "claude-web", "anthropic-ai", "claude-searchbot",
  // Common Crawl — the corpus most models train from
  "ccbot",
  // Google's AI training opt-out agent (separate from Googlebot)
  "google-extended",
  // Perplexity
  "perplexitybot", "perplexity-user",
  // ByteDance / TikTok
  "bytespider",
  // Meta
  "meta-externalagent", "facebookbot",
  // Amazon
  "amazonbot",
  // Apple
  "applebot-extended",
  // Others that publish an agent and scrape at scale
  "diffbot", "omgili", "omgilibot", "cohere-ai", "youbot", "petalbot",
  "img2dataset", "timpibot", "webzio-extended", "scrapy",
] as const;

/** Should this request be refused outright? */
export function isAiCrawler(userAgent: string | null | undefined): boolean {
  const ua = String(userAgent ?? "").toLowerCase();
  if (!ua) return false;
  return AI_CRAWLER_AGENTS.some(agent => ua.includes(agent));
}

/**
 * The header that does the most work.
 *
 * `noindex` keeps the portal out of results; `noarchive`/`nosnippet` stop a
 * cached copy or an excerpt being shown even when a crawler did fetch the page.
 * `noai`/`noimageai` are the emerging opt-out signals — not universally
 * honoured, and included because the cost is zero and the alternative is
 * relying on a convention that has not settled.
 */
export const X_ROBOTS_TAG =
  "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai";

/**
 * robots.txt for a private portal.
 *
 * Disallow: / for everyone, then the named AI agents again explicitly. The
 * repetition is deliberate: several crawlers only look for their OWN
 * user-agent block and ignore the wildcard, so a bare `User-agent: *` is not
 * the blanket it appears to be.
 */
export function robotsTxt(): string {
  const named = AI_CRAWLER_AGENTS
    // The list is lowercase for matching; robots.txt is conventionally written
    // in the agent's published casing, and matching there is case-insensitive
    // anyway.
    .map(a => `User-agent: ${a}\nDisallow: /`)
    .join("\n\n");

  return [
    "# Homefront portal - private application, not a public website.",
    "# Every route that serves data requires a session; there is nothing here",
    "# for a crawler to index.",
    "",
    "User-agent: *",
    "Disallow: /",
    "",
    named,
    "",
  ].join("\n");
}
