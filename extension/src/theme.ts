export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'kikiweb-theme';

export const getInitialTheme = (): Theme => {
  const storedTheme = window.localStorage.getItem(STORAGE_KEY);
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#101415' : '#183f4a',
  );
};

export const saveTheme = (theme: Theme) => {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
};
