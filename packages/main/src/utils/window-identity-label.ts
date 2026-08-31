export const normalizeWindowIdentityName = (name?: string) =>
  (name || '未命名').replace(/\s+/g, ' ').trim() || '未命名';

export const getWindowIdentityBadgeText = (name?: string) => {
  const normalized = normalizeWindowIdentityName(name);
  const characters = Array.from(normalized);
  // The badge is rendered in a small taskbar icon. Keep the most useful,
  // usually unique suffix instead of shrinking a long name into unreadable
  // text (for example, X0001 -> 0001).
  return characters.length > 4 ? characters.slice(-4).join('') : normalized;
};

export const escapeWindowIdentityXml = (value: string) =>
  value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  })[character] || character);

export const isWindowIconBadgeEnabled = () => process.env.CLOAK_WINDOW_ICON_BADGE !== '0';
