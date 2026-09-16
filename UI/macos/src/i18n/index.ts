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
const dictionary = messages as Record<string, string>;
// Match only known built-in message templates. Captured paths, names and model
// identifiers are inserted verbatim; arbitrary upstream text is not translated.
const templates = Object.entries(dictionary)
  .filter(([source]) => /\{\d+\}/.test(source) && /\p{Script=Han}/u.test(source))
  .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
  .map(([source, translated]) => {
    const indices: number[] = [];
    const pattern = source.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { indices.push(Number(part.slice(1, -1))); return '([\\s\\S]*?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    return { pattern: new RegExp(`^${pattern}$`), translated, indices };
  });

/** Interface text only; callers must not pass user-authored content here. */
export function t(source: string, values: readonly (string | number | null | undefined)[] = []): string {
  let template = source;
  if (useLocale.getState().language === 'en') {
    const key = source.trim().replace(/\s+/g, ' ');
    const translated = dictionary[source] ?? dictionary[source.trim()] ?? dictionary[key];
    if (translated !== undefined) {
      template = source === source.trim() ? translated : `${source.match(/^\s*/)?.[0] ?? ''}${translated}${source.match(/\s*$/)?.[0] ?? ''}`;
    } else if (!values.length && /\p{Script=Han}/u.test(source) && source.length < 16_384) {
      for (const candidate of templates) {
        const match = candidate.pattern.exec(source);
        if (!match) continue;
        const captured: string[] = [];
        candidate.indices.forEach((index, position) => { captured[index] = match[position + 1]; });
        return candidate.translated.replace(/\{(\d+)\}/g, (part, index: string) => captured[Number(index)] ?? part);
      }
    }
  }
  return template.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] == null ? match : String(values[Number(index)]));
}
export function bilingual(chinese: string, english: string): string {
  return useLocale.getState().language === 'en' ? english : chinese;
}
