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
