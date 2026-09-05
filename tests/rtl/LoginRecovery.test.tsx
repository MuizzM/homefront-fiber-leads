import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const login = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ login }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/InstallAppBanner", () => ({ InstallAppBanner: () => null }));
import Login from "../../client/src/pages/Login";
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); login.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function enterEmail() {
  render(<Login />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "fixture@example.test" } });
  fireEvent.click(screen.getByTestId("button-send-code"));
  await screen.findByTestId("code-box-0");
}
function enterCode() { fireEvent.change(screen.getByTestId("code-box-0"), { target: { value: "123456" } }); }
function readCode() { return Array.from({ length: 6 }, (_, i) => (screen.getByTestId(`code-box-${i}`) as HTMLInputElement).value).join(""); }

describe("sign-in recovery", () => {
  it.each(["offline", "gateway", "incomplete"])("retains entered digits after %s and allows a successful retry", async failure => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await enterEmail();
    if (failure === "offline") fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    else fetchMock.mockResolvedValueOnce(failure === "gateway" ? new Response("<html>proxy-host</html>", { status: 502 }) : Response.json({}));
    enterCode();
    await screen.findByRole("alert");
    expect(readCode()).toBe("123456"); expect(login).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).not.toHaveTextContent("proxy-host");
    fetchMock.mockResolvedValueOnce(Response.json({ sessionId: "fixture-session", user: { id: 1, role: "rep" } }));
    fireEvent.click(screen.getByTestId("button-verify-code"));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });
  it("clears only an explicitly rejected code", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true })); await enterEmail();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Invalid code" }, { status: 401 }));
    enterCode(); await screen.findByRole("alert"); expect(readCode()).toBe("");
  });
  it("honors Retry-After elapsed time across browser suspension", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true })); await enterEmail(); vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Please wait" }, { status: 429, headers: { "Retry-After": "60" } }));
    await act(async () => enterCode());
    expect(screen.getByTestId("button-verify-code")).toBeDisabled();
    vi.setSystemTime(Date.now() + 61_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByTestId("button-verify-code")).toBeEnabled();
    expect(readCode()).toBe("123456");
  });
  it("bounds stalled requests and prevents duplicate submits or changing the requested email", async () => {
    vi.useFakeTimers(); fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<Login />);
    const email = screen.getByLabelText("Email");
    fireEvent.change(email, { target: { value: "fixture@example.test" } });
    const form = email.closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(email).toBeDisabled(); expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    expect(email).toBeEnabled(); expect(screen.getByTestId("button-send-code")).toBeEnabled();
  });
});

it("stops the cooldown timer once resend becomes available", async () => {
  vi.useFakeTimers(); fetchMock.mockResolvedValue(Response.json({ ok: true }));
  render(<Login />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "fixture@example.test" } });
  await act(async () => fireEvent.click(screen.getByTestId("button-send-code")));
  expect(screen.getByTestId("button-resend-code")).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
  expect(screen.getByTestId("button-resend-code")).toBeEnabled();
  expect(vi.getTimerCount()).toBe(0);
});
