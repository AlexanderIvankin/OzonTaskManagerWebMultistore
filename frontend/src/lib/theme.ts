// Управление темой (light / dark) для класса .dark на <html>.
// Выбор сохраняется в localStorage; при первом входе берётся системная тема.

export type Theme = "light" | "dark";

const THEME_KEY = "theme";

export function getStoredTheme(): Theme | null {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

export function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Применяет тему к документу и сохраняет выбор пользователя */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem(THEME_KEY, theme);
}

/** Определяет тему при старте: сохранённая → системная. Применяет и возвращает её */
export function initTheme(): Theme {
  const theme = getStoredTheme() ?? getSystemTheme();
  document.documentElement.classList.toggle("dark", theme === "dark");
  return theme;
}

/** Переключает тему на противоположную и возвращает новую */
export function toggleTheme(current: Theme): Theme {
  const next: Theme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
