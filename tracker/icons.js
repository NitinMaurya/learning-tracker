// Authored icon set: 16px grid, 1.5px stroke, round caps, currentColor.
// One family, one weight. No emoji, no unicode glyphs standing in for icons.

const S = (body, { size = 16, fill = false } = {}) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"
     stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
     ${fill ? 'style="fill:currentColor;stroke:none"' : ''}>${body}</svg>`;

const PATHS = {
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  grip: '<circle cx="6" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r=".9" fill="currentColor" stroke="none"/>',
  check: '<path d="M3 8.5 6.3 11.8 13 5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  edit: '<path d="M9.5 3.2 12.8 6.5M3 13h3l7.2-7.2a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0L3 10z"/>',
  play: '<path d="M5 3.6 12.5 8 5 12.4z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.8V8l2.2 1.6"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  link: '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.9-.9"/>',
  file: '<path d="M9 1.8H4.6a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.3z"/><path d="M9 1.8v3.5h3.7"/>',
  paperclip: '<path d="M12.6 7.5 8 12.1a2.9 2.9 0 0 1-4.1-4.1l4.8-4.8a1.9 1.9 0 0 1 2.7 2.7l-4.7 4.7a.9.9 0 0 1-1.3-1.3l4.3-4.3"/>',
  flask: '<path d="M6.4 2h3.2M6.9 2v4L3.6 12a1.2 1.2 0 0 0 1 1.9h6.8a1.2 1.2 0 0 0 1-1.9L9.1 6V2"/><path d="M5.2 9.4h5.6"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M10 3v10"/>',
  database: '<ellipse cx="8" cy="4" rx="5" ry="2.1"/><path d="M3 4v8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1V4"/><path d="M3 8c0 1.2 2.2 2.1 5 2.1s5-.9 5-2.1"/>',
  circle: '<circle cx="8" cy="8" r="4.2"/>',
  dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
  arrowDown: '<path d="M8 3v10M4.5 9.5 8 13l3.5-3.5"/>',
  list: '<path d="M3 4.5h10M3 8h10M3 11.5h6"/>',
  graph: '<circle cx="8" cy="3.6" r="2"/><circle cx="8" cy="12.4" r="2"/><path d="M8 5.6v4.8"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.3 10.3 2.7 2.7"/>',
  download: '<path d="M8 2.5v7.5M4.8 7l3.2 3 3.2-3M3 13h10"/>',
  upload: '<path d="M8 10.5V3M4.8 6l3.2-3 3.2 3M3 13h10"/>',
  warning: '<path d="M8 2.8 14 12.8H2z"/><path d="M8 6.6v3M8 11.2v.05"/>',
  video: '<rect x="1.5" y="3.5" width="13" height="9" rx="2.4"/><path d="M6.7 6.4 10.2 8l-3.5 1.6z" fill="currentColor" stroke="none"/>',
};

export const icon = (name, opts) => (PATHS[name] ? S(PATHS[name], opts) : '');

// File-kind glyph, chosen from the extension. Same family, same weight.
export const fileIcon = (name = '') => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return S('<rect x="2" y="3" width="12" height="10" rx="1.4"/><circle cx="6" cy="6.5" r="1.1"/><path d="m3 11.5 3.2-3 2.4 2.2 2-1.8L14 12"/>');
  if (['log', 'txt', 'md', 'json', 'csv'].includes(ext)) return S(PATHS.file);
  return S(PATHS.paperclip);
};
