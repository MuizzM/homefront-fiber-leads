import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

describe("EmptyState", () => {
  it("renders title, description, and an optional action, as a status region", () => {
    render(
      <EmptyState
        testId="demo-empty"
        icon={Inbox}
        title="Nothing here yet"
        description="Add your first item to get started."
        action={<button>Add item</button>}
      />,
    );
    const root = screen.getByTestId("demo-empty");
    expect(root).toHaveAttribute("role", "status"); // announced to assistive tech
    const icon = screen.getByTestId("demo-empty-icon");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("Add your first item to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add item" })).toBeInTheDocument();
  });

  it("works with title only (description/action optional)", () => {
    render(<EmptyState testId="bare" icon={Inbox} title="All done" />);
    expect(screen.getByTestId("bare")).toBeInTheDocument();
    expect(screen.getByText("All done")).toBeInTheDocument();
  });
});
