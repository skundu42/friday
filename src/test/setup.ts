import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => "test-uuid",
    },
  });
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => {
      const maxWidthMatch = /max-width:\s*([0-9.]+)px/i.exec(query);
      const minWidthMatch = /min-width:\s*([0-9.]+)px/i.exec(query);
      const maxWidth = maxWidthMatch ? Number(maxWidthMatch[1]) : null;
      const minWidth = minWidthMatch ? Number(minWidthMatch[1]) : null;

      return {
        get matches() {
          if (maxWidth !== null && window.innerWidth > maxWidth) {
            return false;
          }
          if (minWidth !== null && window.innerWidth < minWidth) {
            return false;
          }
          return true;
        },
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
}

if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: () => {},
    writable: true,
  });
}
