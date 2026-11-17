// Single source of truth for the language articles/keywords/descriptions are
// generated in. Stored on businesses.content_language (ISO 639-1 code).

export const SUPPORTED_CONTENT_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
] as const;

export type ContentLanguageCode =
  (typeof SUPPORTED_CONTENT_LANGUAGES)[number]["code"];

export const DEFAULT_CONTENT_LANGUAGE: ContentLanguageCode = "en";

const ENGLISH_NAMES: Record<ContentLanguageCode, string> = {
  en: "English",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export function isContentLanguage(value: unknown): value is ContentLanguageCode {
  return SUPPORTED_CONTENT_LANGUAGES.some((l) => l.code === value);
}

/** English name of the language, for use inside AI prompts. */
export function contentLanguageName(code: string | null | undefined): string {
  return isContentLanguage(code) ? ENGLISH_NAMES[code] : ENGLISH_NAMES.en;
}
