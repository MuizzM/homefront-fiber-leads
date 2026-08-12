// InstallAppBanner - the pre-auth install ask.
//
// On iPhone this banner is the whole notification pipeline: no Home Screen
// install means no web push, ever. So the branching here is not cosmetic, and
// the three ways it can silently do the wrong thing are all covered below:
//
//   1. Showing when there is nothing to offer. A banner over the sign-in form
//      that cannot be acted on (already installed, or a browser with no install
//      path) is pure obstruction.
//   2. Offering the wrong control. Safari has no install API - an "Install"
//      button there is dead. Chrome has one - making a rep read Share-sheet
//      steps there wastes the one-tap path.
//   3. Forgetting a dismissal, or remembering it forever. Both are bad: the
//      first nags, the second silently opts a first-morning rep out of every
//      notification the app will ever send.
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InstallAppBanner } from "@/components/InstallAppBanner";
import { _resetInstallPromptForTests, captureInstallPrompt } from "@/lib/installPrompt";

const DISMISS_KEY = "hfs:install-banner-dismissed-until";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126 Mobile Safari/537.36";

function setUA(ua: string) {
  Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
}

/** Stand in for Chrome's event: preventDefault-able, promptable, single-use. */
function fireBeforeInstallPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn(() => Promise.resolve());
  const e: any = new Event("beforeinstallprompt");
  e.prompt = prompt;
  e.userChoice = Promise.resolve({ outcome });
  // The event originates outside React, so the subscriber's setState lands
  // outside React's batching without this.
  act(() => { window.dispatchEvent(e); });
  return prompt;
}

beforeEach(() => {
  localStorage.clear();
  _resetInstallPromptForTests();
  captureInstallPrompt();
  setUA(IPHONE);
  (navigator as any).standalone = false;
  // jsdom's matchMedia is absent; isStandalone() reads display-mode through it.
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as any;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("InstallAppBanner", () => {
  it("on iPhone in a tab, offers the Share-sheet walkthrough and no dead Install button", async () => {
    render(<InstallAppBanner />);
    await screen.findByTestId("install-app-banner");

    expect(screen.getByTestId("install-banner-how")).toHaveTextContent("How to install");
    // Safari cannot be driven into an install - a button claiming otherwise
    // would be a control that does nothing when tapped.
    expect(screen.queryByTestId("install-banner-install")).toBeNull();

    // The steps are behind the tap, not dumped over the sign-in form on arrival.
    expect(screen.queryByTestId("a2hs-steps")).toBeNull();
    fireEvent.click(screen.getByTestId("install-banner-how"));
    expect(screen.getByTestId("a2hs-steps")).toBeTruthy();
  });

  it("stays hidden once the app is already installed", async () => {
    (navigator as any).standalone = true;
    render(<InstallAppBanner />);
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());
  });

  it("stays hidden on a browser with no install path at all", async () => {
    setUA(ANDROID); // not iOS, and no beforeinstallprompt has fired
    render(<InstallAppBanner />);
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());
  });

  it("appears with a real Install button once Chrome fires beforeinstallprompt", async () => {
    setUA(ANDROID);
    render(<InstallAppBanner />);
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());

    // Fired AFTER mount - the case a listener inside the component would miss.
    const prompt = fireBeforeInstallPrompt();
    const btn = await screen.findByTestId("install-banner-install");
    expect(btn).toHaveTextContent("Install");
    expect(screen.queryByTestId("install-banner-how")).toBeNull();

    fireEvent.click(btn);
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    // The event is single-use, so the banner must not sit there offering a
    // spent prompt.
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());
  });

  it("clears itself when the app is installed from somewhere else", async () => {
    setUA(ANDROID);
    render(<InstallAppBanner />);
    fireBeforeInstallPrompt();
    await screen.findByTestId("install-banner-install");

    act(() => { window.dispatchEvent(new Event("appinstalled")); });
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());
  });

  it("a dismissal is remembered, but expires rather than opting the rep out forever", async () => {
    const { unmount } = render(<InstallAppBanner />);
    await screen.findByTestId("install-app-banner");
    fireEvent.click(screen.getByTestId("install-banner-not-now"));
    expect(screen.queryByTestId("install-app-banner")).toBeNull();

    const until = Number(localStorage.getItem(DISMISS_KEY));
    expect(until).toBeGreaterThan(Date.now());

    unmount();
    render(<InstallAppBanner />);
    await waitFor(() => expect(screen.queryByTestId("install-app-banner")).toBeNull());

    // Past the window, the ask comes back - a rep who tapped "Not now" on day
    // one, before ever seeing a bonus go live, is not opted out permanently.
    localStorage.setItem(DISMISS_KEY, String(Date.now() - 1000));
    render(<InstallAppBanner />);
    expect(await screen.findByTestId("install-app-banner")).toBeTruthy();
  });
});
