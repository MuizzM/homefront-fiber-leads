// ── The invite carries the org-chart half of the offer ───────────────────────
//
// Role and upline travel WITH the invite, the way the comp terms already do.
// Three rules from the shared hierarchy module must show up in the form: the
// role list is capped by HIRABLE_ROLES (a manager cannot invite a manager),
// the supervisor list holds only active members ranking strictly above the
// chosen role, and changing the role resets the supervisor — eligibility
// changed with it. What leaves the form is exactly invitedRole +
// invitedSupervisorId (the schema is .strict()).
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: 1, name: "Mia Manager", role: "manager", teamMemberId: 5 } }),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import Applications from "../../client/src/pages/Applications";

const PIPELINE = {
  configured: true,
  gustoConfigured: false,
  summary: { total: 0, needsAction: 0, inProgress: 0, active: 0 },
  records: [],
};

// The inviter (id 5) is on the roster as a manager; Tara is an active team
// lead; Rex is a rep (never a supervisor); Ina is an offboarded team lead.
const TEAM = [
  { id: 5, name: "Mia Manager", role: "manager", active: true },
  { id: 7, name: "Tara Lead", role: "team_lead", active: true },
  { id: 9, name: "Rex Rep", role: "rep", active: true },
  { id: 11, name: "Ina Inactive", role: "team_lead", active: false },
];

function renderPage() {
  apiRequest.mockImplementation((method: string, url?: string) => {
    if (method === "GET" && typeof url === "string" && url.includes("/api/team")) {
      return Promise.resolve({ json: () => Promise.resolve(TEAM) });
    }
    if (method === "GET") return Promise.resolve({ json: () => Promise.resolve(PIPELINE) });
    return Promise.resolve({ json: () => Promise.resolve({ invitation: { candidateName: "Jordan Deal" } }) });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Applications /></QueryClientProvider>);
}

const roleSelect = () => screen.getByTestId("invite-role-select") as HTMLSelectElement;
const supervisorSelect = () => screen.getByTestId("invite-supervisor-select") as HTMLSelectElement;
const invitePost = () => apiRequest.mock.calls.find(call => call[1] === "/api/onboarding/invitations");

function fillCandidate() {
  fireEvent.change(screen.getByTestId("input-candidate-name"), { target: { value: "Jordan Deal" } });
  fireEvent.change(screen.getByTestId("input-candidate-email"), { target: { value: "jordan@example.com" } });
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId("invite-role-select")).toBeInTheDocument());
  // The roster arrives async — the supervisor options (and the self default)
  // only exist once it lands.
  await waitFor(() => expect(within(supervisorSelect()).getByText(/Tara Lead/)).toBeInTheDocument());
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("the invite form's role & upline", () => {
  it("caps the role options at HIRABLE_ROLES — a manager sees rep and team lead, never manager", async () => {
    renderPage();
    await ready();
    const values = Array.from(roleSelect().options).map(option => option.value);
    expect(values).toEqual(["rep", "team_lead"]);
  });

  it("offers only active members who outrank the chosen role as supervisors", async () => {
    renderPage();
    await ready();
    const labels = Array.from(supervisorSelect().options).map(option => option.textContent ?? "");
    expect(labels.some(label => label.includes("Tara Lead"))).toBe(true);
    expect(labels.some(label => label.includes("Mia Manager"))).toBe(true);
    expect(labels.some(label => label.includes("Rex Rep"))).toBe(false);      // a rep supervises nobody
    expect(labels.some(label => label.includes("Ina Inactive"))).toBe(false); // offboarded
  });

  it("defaults the supervisor to the inviter's own member row", async () => {
    renderPage();
    await ready();
    expect(supervisorSelect().value).toBe("5");
  });

  it("changing the role RESETS the supervisor — a team lead can't keep a team-lead upline", async () => {
    renderPage();
    await ready();
    // The manager deliberately picks Tara for a rep invite…
    fireEvent.change(supervisorSelect(), { target: { value: "7" } });
    expect(supervisorSelect().value).toBe("7");
    // …then changes the invite to a team lead. Tara can no longer supervise
    // (peers never do), so the pick is gone and the default (self) is back.
    fireEvent.change(roleSelect(), { target: { value: "team_lead" } });
    const labels = Array.from(supervisorSelect().options).map(option => option.textContent ?? "");
    expect(labels.some(label => label.includes("Tara Lead"))).toBe(false);
    expect(supervisorSelect().value).toBe("5");
  });

  it("THE REQUIREMENT: the invite POST carries invitedRole and invitedSupervisorId", async () => {
    renderPage();
    await ready();
    fillCandidate();
    fireEvent.change(roleSelect(), { target: { value: "team_lead" } });
    fireEvent.click(screen.getByTestId("send-candidate-invite"));

    await waitFor(() => expect(invitePost()).toBeTruthy());
    const body = invitePost()![2] as any;
    expect(body.invitedRole).toBe("team_lead");
    expect(body.invitedSupervisorId).toBe(5);
  });

  it("choosing top-level sends an explicit null, not an absent key", async () => {
    renderPage();
    await ready();
    fillCandidate();
    fireEvent.change(supervisorSelect(), { target: { value: "none" } });
    fireEvent.click(screen.getByTestId("send-candidate-invite"));

    await waitFor(() => expect(invitePost()).toBeTruthy());
    const body = invitePost()![2] as any;
    expect(body.invitedRole).toBe("rep");
    expect(body.invitedSupervisorId).toBeNull();
    expect("invitedSupervisorId" in body).toBe(true);
  });
});
