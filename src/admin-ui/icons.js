const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  agents: '<circle cx="9" cy="8" r="2.5"/><circle cx="16.5" cy="9.5" r="2"/><path d="M4.5 19a4.5 4.5 0 0 1 9 0"/><path d="M13.5 19a3.5 3.5 0 0 1 7 0"/>',
  channels: '<path d="M5 7h14"/><path d="M5 12h10"/><path d="M5 17h7"/><circle cx="19" cy="12" r="2"/>',
  link: '<path d="M10 13a5 5 0 0 1 0-7l1.2-1.2a5 5 0 0 1 7 7L17 13"/><path d="M14 11a5 5 0 0 1 0 7l-1.2 1.2a5 5 0 1 1-7-7L7 11"/>',
  ai: '<rect x="6" y="7" width="12" height="10" rx="2"/><path d="M9 4v3"/><path d="M15 4v3"/><path d="M9 17v3"/><path d="M15 17v3"/><path d="M3 10h3"/><path d="M18 10h3"/><path d="M3 14h3"/><path d="M18 14h3"/>',
  tokens: '<path d="M12 3v18"/><path d="M7 7h7.5a3.5 3.5 0 0 1 0 7H9.5a3.5 3.5 0 0 0 0 7H17"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12h2"/><path d="M3 12h2"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="m17 7 1.5-1.5"/><path d="M5.5 18.5 7 17"/><path d="m17 17 1.5 1.5"/><path d="M5.5 5.5 7 7"/>',
  discord: '<path d="M7.5 8.5c3-1.2 6-1.2 9 0"/><path d="M6 16c1.2 1.1 3.5 2 6 2s4.8-.9 6-2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M6.5 9.5 5 14"/><path d="M17.5 9.5 19 14"/>',
  telegram: '<path d="M21 4 3 11l6 2 2 6 10-15Z"/><path d="m9 13 8-6"/>',
  kakao: '<path d="M12 5c5 0 9 2.8 9 6.3s-4 6.3-9 6.3c-.7 0-1.4-.1-2-.2L6.5 20l.9-3.4C4.7 15.5 3 13.6 3 11.3 3 7.8 7 5 12 5Z"/><path d="M8.5 11.5h.01"/><path d="M12 11.5h.01"/><path d="M15.5 11.5h.01"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  edit: '<path d="m4 20 4.5-1 9-9a2.1 2.1 0 0 0-3-3l-9 9L4 20Z"/><path d="m13.5 6.5 4 4"/>',
  play: '<path d="m8 6 10 6-10 6V6Z"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4"/><path d="M3 12A9 9 0 0 1 18.4 5.6"/><path d="M3 17v-4h4"/><path d="M21 7v4h-4"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m8 11 .8 7h6.4l.8-7"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 2.7 8 7 10 4.3-2 7-5.5 7-10V6l-7-3Z"/><path d="m9.5 12 1.8 1.8 3.7-3.8"/>',
  notice: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  server: '<rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01"/><path d="M8 17h.01"/>',
  chart: '<path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-7"/>',
  sparkles: '<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="m19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z"/><path d="m5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z"/>',
  login: '<path d="M10 17 5 12l5-5"/><path d="M5 12h10"/><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  close: '<path d="M6 6 18 18"/><path d="M18 6 6 18"/>',
};

export function renderIcon(name, className = 'ui-icon') {
  const markup = ICONS[name] || ICONS.sparkles;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
}
