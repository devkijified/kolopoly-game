'use strict';
// Talk lines for the in-match wheel. A pack with no city is universal.
// A pack with a city id only shows on a table of that city. Adding a
// city later is another pack in this list, not a code change.
const PACKS = [
  {
    id: 'universal',
    city: null,
    lines: [
      { id: 'shine', line: 'Shine your eye!' },
      { id: 'cast', line: 'E don cast!' },
      { id: 'pay', line: 'Pay me my money!' },
      { id: 'nawa', line: 'Na wa o!' },
      { id: 'who', line: 'Who send you?' },
      { id: 'oya', line: 'Oya roll!' }
    ]
  },
  {
    id: 'lagos',
    city: 'lagos',
    lines: [
      { id: 'jam', line: 'Third Mainland jam!' },
      { id: 'island', line: 'Island people, pay up!' }
    ]
  }
];

function homeCity() {
  const tagged = PACKS.find((p) => p.city);
  return tagged ? tagged.city : null;
}
function linesFor(cityId) {
  const out = [];
  for (const pack of PACKS) {
    if (pack.city && pack.city !== cityId) continue;
    for (const line of pack.lines) out.push({ id: line.id, line: line.line, city: pack.city, pack: pack.id });
  }
  return out;
}
function byId(id) {
  for (const pack of PACKS) {
    const line = pack.lines.find((l) => l.id === id);
    if (line) return { id: line.id, line: line.line, city: pack.city, pack: pack.id };
  }
  return null;
}

module.exports = { PACKS, homeCity, linesFor, byId };
