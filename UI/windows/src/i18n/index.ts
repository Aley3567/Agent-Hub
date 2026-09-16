import { create } from 'zustand';
import messages from './en.json';

export type Language = 'zh-CN' | 'en';
export const LANGUAGE_STORAGE_KEY = 'agent-hub.desktop.language';
export function readLanguage(): Language {
  try { return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}
export const useLocale = create<{ language: Language; setLanguage(language: Language): void }>((set) => ({
  language: readLanguage(),
  setLanguage(language) {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session preference remains usable. */ }
    document.documentElement.lang = language;
    set({ language });
  },
}));
/** Only interface copy is translated. Provider names, models and backend errors stay intact. */
export function t(source: string, values: readonly (string | number | null | undefined)[] = []): string {
  const template = useLocale.getState().language === 'en'
    ? (messages as Record<string, string>)[source] ?? source : source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] == null ? match : String(values[Number(index)]));
}
export function bilingual(chinese: string, english: string): string {
  return useLocale.getState().language === 'en' ? english : chinese;
}
