import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UseSpeechResult {
  supported: boolean;
  speakingMessageId: string | null;
  speak: (id: string, text: string) => void;
  stop: () => void;
  toggle: (id: string, text: string) => void;
}

function pickVoice(
  voices: SpeechSynthesisVoice[],
  lang: string | undefined,
): SpeechSynthesisVoice | undefined {
  if (!lang) return undefined;
  const prefix = lang.toLowerCase();
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix));
}

/**
 * Read-aloud via the Web Speech API. A single utterance plays at a time across
 * the whole conversation; `speakingMessageId` tracks which message is active.
 * Speech is cancelled on unmount. Best-effort voice selection by BCP-47 prefix.
 */
export function useSpeech(lang?: string): UseSpeechResult {
  const supported = useMemo(
    () =>
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      "SpeechSynthesisUtterance" in window,
    [],
  );
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null,
  );
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!supported) return;
    const loadVoices = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };
    loadVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", loadVoices);
    };
  }, [supported]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
    setSpeakingMessageId(null);
  }, [supported]);

  const speak = useCallback(
    (id: string, text: string) => {
      if (!supported) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(trimmed);
      const voice = pickVoice(voicesRef.current, lang);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else if (lang) {
        utterance.lang = lang;
      }

      const clear = () => {
        if (!mountedRef.current) return;
        if (utteranceRef.current === utterance) {
          utteranceRef.current = null;
          setSpeakingMessageId(null);
        }
      };
      utterance.onend = clear;
      utterance.onerror = clear;

      utteranceRef.current = utterance;
      setSpeakingMessageId(id);
      window.speechSynthesis.speak(utterance);
    },
    [supported, lang],
  );

  const toggle = useCallback(
    (id: string, text: string) => {
      if (speakingMessageId === id) {
        stop();
      } else {
        speak(id, text);
      }
    },
    [speakingMessageId, speak, stop],
  );

  return { supported, speakingMessageId, speak, stop, toggle };
}
