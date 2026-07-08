import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL: unmount + wipe the DOM after every test so component tests don't leak
// nodes into one another (jsdom persists between tests in the same file).
afterEach(() => cleanup());
