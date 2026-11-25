'use strict';
// Weekly events. Each row names a city id, or null when every city
// plays it. The week index picks the row. Adding a city is another
// row, not a change to the picker.
const EVENTS = [
  {
    id: 'owambe-week',
    city: 'lagos',
    name: 'Owambe Week',
    blurb: 'The pot dey pay double this week.',
    effect: 'pot-double',
    sticker: { id: 'event-owambe', name: 'Owambe Week' }
  },
  {
    id: 'nepa-blackout',
    city: 'lagos',
    name: 'NEPA Blackout',
    blurb: 'One street don lose light. Rent no go land there.',
    effect: 'lights-out',
    sticker: { id: 'event-nepa', name: 'NEPA Blackout' }
  },
  {
    id: 'toll-holiday',
    city: 'lagos',
    name: 'Toll Holiday',
    blurb: 'Toll gates dey greet you free this week.',
    effect: 'toll-free',
    sticker: { id: 'event-toll', name: 'Toll Holiday' }
  },
  {
    id: 'marina-night',
    city: 'lagos',
    name: 'Marina Night',
    blurb: 'The marina dey glow. Catch the week sticker.',
    effect: 'banner',
    sticker: { id: 'event-marina', name: 'Marina Night' }
  }
];

function weekIndex(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return 0;
  const ms = Date.UTC(y, m - 1, d);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  const thu = ms + (3 - dow) * 86400000;
  return Math.floor(thu / (7 * 86400000));
}
function weekEnd(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  const end = ms + (6 - dow) * 86400000;
  return new Date(end).toISOString().slice(0, 10);
}
function current(iso) {
  return EVENTS[Math.abs(weekIndex(iso)) % EVENTS.length];
}
function forCity(iso, cityId) {
  const ev = current(iso);
  if (!ev) return null;
  if (ev.city && cityId && ev.city !== cityId) return null;
  return {
    id: ev.id,
    city: ev.city,
    name: ev.name,
    blurb: ev.blurb,
    effect: ev.effect,
    sticker: ev.sticker,
    ends: weekEnd(iso)
  };
}

module.exports = { EVENTS, current, forCity, weekEnd };
