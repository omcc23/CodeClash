import { useSyncExternalStore } from 'react';

export interface Palette {
  bg: string;
  surface: string;
  raised: string;
  fg: string;
  muted: string;
  line: string;
  accent: string;
  accentFg: string;
  ok: string;
  bad: string;
  warn: string;
}

export interface Theme { id: string; name: string; dark: boolean; colors: Palette }

const t = (id: string, name: string, dark: boolean, c: [string, string, string, string, string, string, string, string, string, string, string]): Theme => ({
  id,
  name,
  dark,
  colors: { bg: c[0], surface: c[1], raised: c[2], fg: c[3], muted: c[4], line: c[5], accent: c[6], accentFg: c[7], ok: c[8], bad: c[9], warn: c[10] },
});

//                                bg         surface    raised     fg         muted      line       accent     on-accent  ok         bad        warn
export const THEMES: Theme[] = [
  t('paper', 'Paper', false, ['#f6f4ef', '#fffcf7', '#ebe6dc', '#1a1814', '#5f584e', '#ddd6c8', '#1e3a8a', '#ffffff', '#1b7a38', '#b42318', '#8a5a00']),
  t('latte', 'Latte', false, ['#eff1f5', '#e6e9ef', '#dce0e8', '#4c4f69', '#6c6f85', '#ccd0da', '#8839ef', '#ffffff', '#2f7d1f', '#d20f39', '#b86e0b']),
  t('solarized', 'Solarized', false, ['#fdf6e3', '#f5eed8', '#eee8d5', '#073642', '#586e75', '#e3dcc6', '#1d6fa8', '#fdf6e3', '#5f7a00', '#c8261f', '#946f00']),
  t('paperback', 'Paperback', false, ['#f3ead8', '#faf4e8', '#e7dcc4', '#2a2118', '#6b5c49', '#d4c4a6', '#9a3412', '#fff8ee', '#3f6f1c', '#a61b16', '#8a5a00']),
  t('dawn', 'Rosé Dawn', false, ['#f7f0e8', '#fffaf5', '#efe4da', '#3f3858', '#6d6780', '#e0d4c8', '#1d5c73', '#ffffff', '#2f6d5a', '#a14d64', '#946214']),
  t('mint', 'Mint', false, ['#f3f7f4', '#ffffff', '#e5eee8', '#14241e', '#4d6458', '#d3e0d7', '#0f6e56', '#ffffff', '#1c6b34', '#b42318', '#8a5a00']),
  t('sakura', 'Sakura', false, ['#faf7f6', '#ffffff', '#f1e8e6', '#2c1c22', '#6d5560', '#e6d5d2', '#b4335a', '#ffffff', '#2b7a3e', '#a12828', '#8a5a00']),
  t('mono', 'Monochrome', false, ['#fafafa', '#ffffff', '#f0f0f0', '#111111', '#4a4a4a', '#d4d4d4', '#111111', '#ffffff', '#111111', '#111111', '#525252']),
  t('midnight', 'Midnight', true, ['#0d1117', '#151b23', '#1c2430', '#e6edf3', '#8d96a0', '#2a323c', '#58a6ff', '#0d1117', '#3fb950', '#f85149', '#d29922']),
  t('dracula', 'Dracula', true, ['#282a36', '#21222c', '#343746', '#f8f8f2', '#a3a8c3', '#3c3f52', '#bd93f9', '#1e1f29', '#50fa7b', '#ff5555', '#f1fa8c']),
  t('nord', 'Nord', true, ['#2e3440', '#3b4252', '#434c5e', '#eceff4', '#aab3c5', '#4c566a', '#88c0d0', '#2e3440', '#a3be8c', '#e07a84', '#ebcb8b']),
  t('gruvbox', 'Gruvbox', true, ['#282828', '#32302f', '#3c3836', '#ebdbb2', '#a89984', '#504945', '#fabd2f', '#282828', '#b8bb26', '#fb4934', '#fe8019']),
  t('tokyo', 'Tokyo Night', true, ['#1a1b26', '#1f2335', '#292e42', '#c0caf5', '#8b93bd', '#2f3549', '#7aa2f7', '#1a1b26', '#9ece6a', '#f7768e', '#e0af68']),
  t('mocha', 'Mocha', true, ['#1e1e2e', '#181825', '#313244', '#cdd6f4', '#a6adc8', '#3a3b50', '#cba6f7', '#1e1e2e', '#a6e3a1', '#f38ba8', '#f9e2af']),
  t('monokai', 'Monokai', true, ['#272822', '#1f201b', '#3e3d32', '#f8f8f2', '#b0aa8f', '#45443a', '#66d9ef', '#272822', '#a6e22e', '#f92672', '#e6db74']),
  t('onedark', 'One Dark', true, ['#282c34', '#21252b', '#2c313a', '#dcdfe4', '#9da5b4', '#3b4048', '#61afef', '#1e2127', '#98c379', '#e06c75', '#e5c07b']),
  t('ocean', 'Ocean', true, ['#0e1c24', '#132833', '#1a3644', '#d7ebe4', '#8eafb0', '#244556', '#3d9e8f', '#0e1c24', '#6db87a', '#d46a6a', '#d4a85a']),
  t('synthwave', 'Synthwave', true, ['#1a1522', '#221c2c', '#2c2438', '#efe6f4', '#b3a4c4', '#3a3148', '#d57ab5', '#1a1522', '#7dcaa8', '#e07a84', '#e2c56a']),
  t('terminal', 'Terminal', true, ['#121612', '#181d18', '#222822', '#d5e6d2', '#8aa384', '#2c382c', '#7dbe6a', '#101510', '#8fbf78', '#d4786a', '#c6a15a']),
  t('amber', 'Amber CRT', true, ['#1a140c', '#221b12', '#2c2418', '#f0e2c4', '#b39a6e', '#3d3220', '#d89a3a', '#1a140c', '#8fb56a', '#d4725c', '#e0b15a']),
];

const KEY = 'cc.theme';
/** index.html reads this before the bundle loads, so a reload does not flash the default theme. */
const VARS_KEY = 'cc.theme.vars';

function cssVars(theme: Theme): Record<string, string> {
  const c = theme.colors;
  return {
    '--bg': c.bg, '--surface': c.surface, '--raised': c.raised, '--fg': c.fg, '--muted': c.muted, '--line': c.line,
    '--accent': c.accent, '--accent-fg': c.accentFg, '--ok': c.ok, '--bad': c.bad, '--warn': c.warn,
  };
}

function initial(): Theme {
  const stored = localStorage.getItem(KEY);
  const found = THEMES.find((theme) => theme.id === stored);
  if (found) return found;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return THEMES.find((theme) => theme.id === (prefersDark ? 'midnight' : 'paper'))!;
}

let current = initial();
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  const root = document.documentElement;
  const vars = cssVars(theme);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  localStorage.setItem(VARS_KEY, JSON.stringify({ id: theme.id, dark: theme.dark, vars }));
}

apply(current);

export function setTheme(id: string) {
  const next = THEMES.find((theme) => theme.id === id);
  if (!next) return;
  current = next;
  localStorage.setItem(KEY, id);
  apply(next);
  listeners.forEach((listener) => listener());
}

export function useTheme() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}

/** Monaco colours derived from the same palette; token colours reuse accent / ok / warn. */
export function monacoTheme(theme: Theme) {
  const c = theme.colors;
  const bare = (hex: string) => hex.replace('#', '');
  return {
    base: (theme.dark ? 'vs-dark' : 'vs') as 'vs' | 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: bare(c.muted), fontStyle: 'italic' },
      { token: 'keyword', foreground: bare(c.accent) },
      { token: 'string', foreground: bare(c.ok) },
      { token: 'number', foreground: bare(c.warn) },
    ],
    colors: {
      'editor.background': c.surface,
      'editor.foreground': c.fg,
      'editorGutter.background': c.surface,
      'editorLineNumber.foreground': c.muted,
      'editorLineNumber.activeForeground': c.fg,
      'editorCursor.foreground': c.accent,
      'editor.selectionBackground': `${c.accent}40`,
      'editor.inactiveSelectionBackground': `${c.accent}26`,
      'editor.lineHighlightBackground': c.raised,
      'editor.lineHighlightBorder': c.raised,
      'editorIndentGuide.background1': c.line,
      'editorWidget.background': c.surface,
      'editorWidget.border': c.line,
      'scrollbarSlider.background': `${c.muted}33`,
      'scrollbarSlider.hoverBackground': `${c.muted}55`,
    },
  };
}
