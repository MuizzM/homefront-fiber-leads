import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BottomTabs } from "../../client/src/components/BottomTabs";

describe("BottomTabs mobile More action", () => {
  it("opens the app-native More sheet without dispatching the legacy drawer event", () => {
    const onMore = vi.fn();
    const legacy = vi.fn();
    window.addEventListener("hfs:open-menu", legacy);
    render(<BottomTabs onMore={onMore} moreOpen />);

    const button = screen.getByTestId("tab-more");
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(button);
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    window.removeEventListener("hfs:open-menu", legacy);
  });
});
