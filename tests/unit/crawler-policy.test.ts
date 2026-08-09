// Crawler and AI-bot policy.
//
// The tests that matter here are the FALSE POSITIVES. A blocklist that also
// refuses a link preview in a rep's text message, or an uptime monitor, breaks
// something real in exchange for stopping a crawler that could have lied about
// its user-agent anyway.
import { describe, expect, it } from "vitest";
import { isAiCrawler, robotsTxt, AI_CRAWLER_AGENTS, X_ROBOTS_TAG } from "../../shared/crawlerPolicy";

describe("who gets refused", () => {
  it("catches the major AI crawlers by their published agents", () => {
    for (const ua of [
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
      "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "CCBot/2.0 (https://commoncrawl.org/faq/)",
      "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
      "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
      "meta-externalagent/1.1",
      "Amazonbot/0.1",
      "Google-Extended",
      "Scrapy/2.11 (+https://scrapy.org)",
    ]) {
      expect(isAiCrawler(ua), ua).toBe(true);
    }
  });

  it("is case-insensitive - agents are not consistent about casing", () => {
    expect(isAiCrawler("gptbot/1.0")).toBe(true);
    expect(isAiCrawler("GPTBOT/1.0")).toBe(true);
    expect(isAiCrawler("Mozilla/5.0 (compatible; CLAUDEBOT/1.0)")).toBe(true);
  });
});

describe("who must NOT be refused", () => {
  it("lets real reps through", () => {
    for (const ua of [
      // The actual field fleet.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    ]) {
      expect(isAiCrawler(ua), ua).toBe(false);
    }
  });

  it("does not block link previews or monitors - the false positives that hurt", () => {
    // A blocklist matching loose keywords like "bot" would break the preview
    // card when a manager texts a rep a link, and silence uptime alerting.
    for (const ua of [
      "WhatsApp/2.23.20.0 A",
      "Mozilla/5.0 (compatible; Slackbot-LinkExpanding 1.0; +https://api.slack.com/robots)",
      "Twitterbot/1.0",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Pingdom.com_bot_version_1.4",
      "UptimeRobot/2.0",
      "curl/8.4.0",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
    ]) {
      expect(isAiCrawler(ua), ua).toBe(false);
    }
  });

  it("treats a missing user-agent as a human, not a bot", () => {
    // Plenty of legitimate clients send none — a native fetch, a health probe,
    // a stripped mobile browser. Blocking on absence fails closed against real
    // people for no security gain, since a crawler can send any string it likes.
    expect(isAiCrawler(undefined)).toBe(false);
    expect(isAiCrawler(null)).toBe(false);
    expect(isAiCrawler("")).toBe(false);
  });
});

describe("robots.txt", () => {
  const txt = robotsTxt();

  it("disallows everything for everyone", () => {
    expect(txt).toContain("User-agent: *\nDisallow: /");
  });

  it("also names each AI agent explicitly", () => {
    // Several crawlers only read their OWN block and ignore the wildcard, so
    // `User-agent: *` alone is not the blanket it looks like.
    for (const agent of AI_CRAWLER_AGENTS) {
      expect(txt.toLowerCase()).toContain(`user-agent: ${agent}`);
    }
  });

  it("says what the portal is, for whoever reads it", () => {
    expect(txt).toContain("private application");
  });
});

describe("the robots header", () => {
  it("blocks indexing, caching and excerpting - not just indexing", () => {
    // noindex alone still permits a cached copy and a snippet in results.
    for (const d of ["noindex", "nofollow", "noarchive", "nosnippet", "noimageindex"]) {
      expect(X_ROBOTS_TAG).toContain(d);
    }
  });

  it("carries the AI opt-out signals", () => {
    expect(X_ROBOTS_TAG).toContain("noai");
    expect(X_ROBOTS_TAG).toContain("noimageai");
  });
});
