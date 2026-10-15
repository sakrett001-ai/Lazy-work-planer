const paths = {
pin: '<path d="m14 3 7 7-4 1-3 5-2-2-6 7 4-9-2-2 5-3 1-4Z"/>',
pause: '<path d="M8 5v14M16 5v14"/>',
board: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h1m6 0h1m-8 3h1"/>',
timeline: '<path d="M4 4v16h16M8 6h5m-3 5h8m-4 5h6"/>',
archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8m-10 4h6"/>',
message: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V7a4 4 0 0 1 4-4h6a8 8 0 0 1 8 8Z"/><path d="M7 8h8m-8 4h5"/>',
spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Zm8-2v4m-2-2h4"/>',
plus: '<path d="M12 5v14M5 12h14"/>',close: '<path d="m6 6 12 12M6 18 18 6"/>',check: '<path d="m5 12 4 4L19 6"/>',
eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
alert: '<path d="m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2.3 2.3 0 0 0-4 0Z"/><path d="M12 9v4m0 4h.01"/>',clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',upRight: '<path d="M6 18 18 6M6 6h12v12"/>',down: '<path d="m6 9 6 6 6-6"/>',left: '<path d="m15 5-7 7 7 7"/>',right: '<path d="m9 5 7 7-7 7"/>',
trophy: '<path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 1v5m-4 3h8m-8-1h8"/>',flag: '<path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',bolt: '<path d="m14 2-11 12h8l-1 8 11-12h-8l1-8Z"/>',pen: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z"/>',sliders: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',motion: '<path d="M3 6h7M3 12h4M3 18h7m4-14 6 8-6 8"/>',
copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',document: '<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h6"/>',play: '<path d="m8 4 12 8-12 8V4Z"/>',refresh: '<path d="M20 7V3l-3 3a8 8 0 1 0 3 9M20 3h-5"/>',people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-4a6 6 0 0 1 12 0v4m2-16a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v3"/>',moon: '<path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z"/>',send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2"/>',lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',folder: '<path d="M3 7V4h7l3 3h8v13H3V7Z"/>',info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
graph: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M9 6h6M7.5 8.5 10.5 15.5M16.5 8.5 13.5 15.5"/>',
bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'
};
export function icon(name, cls = '') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`; }
