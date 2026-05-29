import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSpeech } from "./useSpeech";

describe("useSpeech", () => {
  it("reports supported when speechSynthesis exists", () => {
    const { result } = renderHook(() => useSpeech("en"));
    expect(result.current.supported).toBe(true);
  });

  it("speaks a message and tracks the speaking id", () => {
    const { result } = renderHook(() => useSpeech("en"));
    act(() => {
      result.current.speak("m1", "Hello there");
    });
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
    expect(result.current.speakingMessageId).toBe("m1");
  });

  it("clears the speaking id when the utterance ends", () => {
    const { result } = renderHook(() => useSpeech("en"));
    act(() => {
      result.current.speak("m1", "Hello");
    });
    const utterance = vi.mocked(window.speechSynthesis.speak).mock
      .calls[0][0] as unknown as { onend: (() => void) | null };
    act(() => {
      utterance.onend?.();
    });
    expect(result.current.speakingMessageId).toBeNull();
  });

  it("toggles off when the same message is already speaking", () => {
    const { result } = renderHook(() => useSpeech("en"));
    act(() => {
      result.current.speak("m1", "Hello");
    });
    act(() => {
      result.current.toggle("m1", "Hello");
    });
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
    expect(result.current.speakingMessageId).toBeNull();
  });
});
