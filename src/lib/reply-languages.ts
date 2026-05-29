import type { SelectProps } from "antd";
import type { ReplyLanguage } from "../types";

export const REPLY_LANGUAGE_OPTIONS: NonNullable<
  SelectProps<ReplyLanguage>["options"]
> = [
  { label: "English", value: "english" },
  { label: "Hindi", value: "hindi" },
  { label: "Bengali", value: "bengali" },
  { label: "Marathi", value: "marathi" },
  { label: "Tamil", value: "tamil" },
  { label: "Punjabi", value: "punjabi" },
  { label: "Spanish", value: "spanish" },
  { label: "French", value: "french" },
  { label: "Mandarin", value: "mandarin" },
  { label: "Portuguese", value: "portuguese" },
  { label: "Japanese", value: "japanese" },
];

export const REPLY_LANGUAGE_SELECT_PROPS: Pick<
  SelectProps<ReplyLanguage>,
  "showSearch" | "optionFilterProp" | "listHeight"
> = {
  showSearch: true,
  optionFilterProp: "label",
  listHeight: 128,
};

export const REPLY_LANGUAGE_BCP47: Record<ReplyLanguage, string> = {
  english: "en",
  hindi: "hi",
  bengali: "bn",
  marathi: "mr",
  tamil: "ta",
  punjabi: "pa",
  spanish: "es",
  french: "fr",
  mandarin: "zh",
  portuguese: "pt",
  japanese: "ja",
};

export function replyLanguageToBcp47(lang: ReplyLanguage): string {
  return REPLY_LANGUAGE_BCP47[lang] ?? "en";
}
