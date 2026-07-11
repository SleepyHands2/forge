/**
 * Minimal 5-field cron parser (minute hour day-of-month month day-of-week),
 * dependency-free. Supports *, numbers, lists (a,b), ranges (a-b), and steps
 * (*\/n, a-b/n). Standard cron semantics: when both day-of-month and
 * day-of-week are restricted, a date matches if EITHER matches.
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have 5 fields (minute hour day month weekday), got ${fields.length}: '${expression}'`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return {
    minute: parseField(minute, 0, 59, 'minute'),
    hour: parseField(hour, 0, 23, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 1, 31, 'day-of-month'),
    month: parseField(month, 1, 12, 'month'),
    dayOfWeek: normalizeSunday(parseField(dayOfWeek, 0, 7, 'day-of-week')),
    domRestricted: dayOfMonth !== '*',
    dowRestricted: dayOfWeek !== '*',
  };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.has(date.getMinutes())) return false;
  if (!spec.hour.has(date.getHours())) return false;
  if (!spec.month.has(date.getMonth() + 1)) return false;

  const domMatch = spec.dayOfMonth.has(date.getDate());
  const dowMatch = spec.dayOfWeek.has(date.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}

function parseField(field: string, min: number, max: number, label: string): Set<number> {
  const values = new Set<number>();
  if (!field) throw new Error(`Empty cron ${label} field.`);

  for (const part of field.split(',')) {
    const [rangePart, stepPart, ...extra] = part.split('/');
    if (extra.length > 0 || rangePart === '') {
      throw new Error(`Invalid cron ${label} field: '${part}'`);
    }
    const step = stepPart === undefined ? 1 : parseNumber(stepPart, label);
    if (step < 1) throw new Error(`Invalid cron ${label} step: '${part}'`);

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [rawStart, rawEnd, ...rest] = rangePart.split('-');
      if (rest.length > 0) throw new Error(`Invalid cron ${label} range: '${part}'`);
      start = parseNumber(rawStart, label);
      end = parseNumber(rawEnd, label);
      if (start > end) throw new Error(`Cron ${label} range is reversed: '${part}'`);
    } else {
      start = parseNumber(rangePart, label);
      // A bare number with a step (e.g. '3/5') means 'from 3 to max, every 5'.
      end = stepPart === undefined ? start : max;
    }

    if (start < min || end > max) {
      throw new Error(`Cron ${label} value out of range ${min}-${max}: '${part}'`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function parseNumber(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid cron ${label} value: '${raw}'`);
  return Number(raw);
}

/** Cron allows Sunday as both 0 and 7. */
function normalizeSunday(values: Set<number>): Set<number> {
  if (values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return values;
}
