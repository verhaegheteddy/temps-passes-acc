// Jours ouvrés (lundi-vendredi, hors jours fériés français métropolitains).

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseYmd = (s) => new Date(`${s}T00:00:00Z`);
export const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};

// Dimanche de Pâques (algorithme de Meeus/Jones/Butcher).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(month)}-${pad(day)}`;
}

const holidayCache = new Map();
export function frenchHolidays(y) {
  if (!holidayCache.has(y)) {
    const e = easter(y);
    holidayCache.set(
      y,
      new Set([
        `${y}-01-01`, addDays(e, 1), `${y}-05-01`, `${y}-05-08`, addDays(e, 39), addDays(e, 50),
        `${y}-07-14`, `${y}-08-15`, `${y}-11-01`, `${y}-11-11`, `${y}-12-25`,
      ]),
    );
  }
  return holidayCache.get(y);
}

// opts.pentecostWorked : lundi de Pentecôte travaillé (journée de solidarité).
export function isWorkingDay(s, opts = {}) {
  const dow = parseYmd(s).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (!frenchHolidays(Number(s.slice(0, 4))).has(s)) return true;
  return !!opts.pentecostWorked && s === addDays(easter(Number(s.slice(0, 4))), 50);
}

// Lundi de la semaine contenant `s`.
export function weekStart(s) {
  const dow = (parseYmd(s).getUTCDay() + 6) % 7;
  return addDays(s, -dow);
}

export function* days(start, end) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}
