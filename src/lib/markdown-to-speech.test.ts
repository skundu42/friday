import { describe, expect, it } from "vitest";
import { markdownToSpeech } from "./markdown-to-speech";

describe("markdownToSpeech", () => {
  it("replaces fenced code blocks with a spoken placeholder", () => {
    const md = "Here is code:\n\n```ts\nconst x = 1;\n```\n\nDone.";
    const out = markdownToSpeech(md);
    expect(out).toContain("code block omitted");
    expect(out).not.toContain("const x = 1");
  });

  it("keeps link text but drops the URL", () => {
    const out = markdownToSpeech("See [Friday](https://example.com) docs.");
    expect(out).toContain("Friday");
    expect(out).not.toContain("https://example.com");
    expect(out).not.toContain("](");
  });

  it("strips heading, emphasis, and list markers", () => {
    const out = markdownToSpeech("# Title\n\n- **bold** item\n- second");
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).toContain("bold item");
  });

  it("drops a standalone attachment tag line", () => {
    const out = markdownToSpeech("📎 notes.txt\nActual content");
    expect(out).not.toContain("📎");
    expect(out).toContain("Actual content");
  });

  it("strips a leading warning glyph", () => {
    const out = markdownToSpeech("⚠️ Something failed");
    expect(out.startsWith("⚠️")).toBe(false);
    expect(out).toContain("Something failed");
  });
});
