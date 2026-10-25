/**
 * 极简的 formatInTimeZone，替代 date-fns-tz（及其依赖 date-fns，打包后约 13 MB）。
 *
 * 行为与 date-fns-tz@3.2.0 的 `formatInTimeZone` 逐步对应（含时区解析、偏移计算、
 * 以本机时区构造“墙上时间”的方式和错误信息），test/format-in-time-zone.test.js
 * 会把本实现与 date-fns-tz 的输出逐一对比。
 *
 * 只支持通知模块用到的格式记号：yyyy MM dd HH mm ss SSS XXX zzz，以及 '...' 字面量。
 * 其他拉丁字母记号会抛出 RangeError（与 date-fns 对未知记号的处理一致）。
 */

const MILLISECONDS_IN_HOUR = 3600000;
const MILLISECONDS_IN_MINUTE = 60000;

const tzPatterns = {
  timezoneZ: /^(Z)$/,
  timezoneHH: /^([+-]\d{2})$/,
  timezoneHHMM: /^([+-])(\d{2}):?(\d{2})$/,
};

const dtfCache: Record<string, Intl.DateTimeFormat> = {};
function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  if (!dtfCache[timeZone]) {
    dtfCache[timeZone] = new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23',
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return dtfCache[timeZone];
}

const typeToPos: Record<string, number> = { year: 0, month: 1, day: 2, hour: 3, minute: 4, second: 5 };

function tzTokenizeDate(date: Date, timeZone: string): number[] {
  try {
    const formatted = getDateTimeFormat(timeZone).formatToParts(date);
    const filled: number[] = [];
    for (const part of formatted) {
      const pos = typeToPos[part.type];
      if (pos !== undefined) filled[pos] = parseInt(part.value, 10);
    }
    return filled;
  } catch (error) {
    if (error instanceof RangeError) return [NaN];
    throw error;
  }
}

function newDateUTC(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): Date {
  const utcDate = new Date(0);
  utcDate.setUTCFullYear(y, mo, d);
  utcDate.setUTCHours(h, mi, s, ms);
  return utcDate;
}

function calcOffset(date: Date, timeZone: string): number {
  const t = tzTokenizeDate(date, timeZone);
  const asUTC = newDateUTC(t[0], t[1] - 1, t[2], t[3] % 24, t[4], t[5], 0).getTime();
  let asTS = date.getTime();
  const over = asTS % 1000;
  asTS -= over >= 0 ? over : 1000 + over;
  return asUTC - asTS;
}

function validateTimezone(hours: number, minutes?: number): boolean {
  return -23 <= hours && hours <= 23 && (minutes == null || (0 <= minutes && minutes <= 59));
}

const validIanaCache: Record<string, boolean> = {};
function isValidTimezoneIANAString(timeZone: string): boolean {
  if (validIanaCache[timeZone]) return true;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    validIanaCache[timeZone] = true;
    return true;
  } catch {
    return false;
  }
}

/** 与 date-fns-tz 的 tzParseTimezone(timeZone, date, true) 相同：返回 (UTC - 本地) 毫秒数，无效时 NaN。 */
function tzParseTimezone(timeZone: string, date: Date): number {
  if (!timeZone) return 0;
  if (tzPatterns.timezoneZ.exec(timeZone)) return 0;
  let token = tzPatterns.timezoneHH.exec(timeZone);
  if (token) {
    const hours = parseInt(token[1], 10);
    if (!validateTimezone(hours)) return NaN;
    return -(hours * MILLISECONDS_IN_HOUR);
  }
  token = tzPatterns.timezoneHHMM.exec(timeZone);
  if (token) {
    const hours = parseInt(token[2], 10);
    const minutes = parseInt(token[3], 10);
    if (!validateTimezone(hours, minutes)) return NaN;
    const absoluteOffset = Math.abs(hours) * MILLISECONDS_IN_HOUR + minutes * MILLISECONDS_IN_MINUTE;
    return token[1] === '+' ? -absoluteOffset : absoluteOffset;
  }
  if (isValidTimezoneIANAString(timeZone)) {
    // date-fns-tz 中为 `new Date(date || Date.now())`；这里 date 总是 Date 对象（真值）。
    return -calcOffset(new Date(date.getTime()), timeZone);
  }
  return NaN;
}

function addLeadingZeros(number: number, targetLength: number): string {
  const sign = number < 0 ? '-' : '';
  let output = Math.abs(number).toString();
  while (output.length < targetLength) output = '0' + output;
  return sign + output;
}

function formatTimezone(offset: number, delimiter = ''): string {
  const sign = offset > 0 ? '-' : '+';
  const absOffset = Math.abs(offset);
  return sign + addLeadingZeros(Math.floor(absOffset / 60), 2) + delimiter + addLeadingZeros(Math.floor(absOffset % 60), 2);
}

function getTimeZoneOffsetMinutes(timeZone: string, originalDate: Date): number {
  const offset = timeZone
    ? tzParseTimezone(timeZone, originalDate) / MILLISECONDS_IN_MINUTE
    : originalDate?.getTimezoneOffset() ?? 0;
  if (Number.isNaN(offset)) throw new RangeError('Invalid time zone specified: ' + timeZone);
  return offset;
}

function tzShortName(date: Date, timeZone: string): string | undefined {
  const parts = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(date);
  for (let i = parts.length - 1; i >= 0; --i) {
    if (parts[i].type === 'timeZoneName') return parts[i].value;
  }
  return undefined;
}

/** 与 date-fns-tz 的 toZonedTime 相同：用本机时区的 Date 表示目标时区的墙上时间。 */
function toZonedTime(date: Date, timeZone: string): Date {
  const offsetMilliseconds = tzParseTimezone(timeZone, date);
  const d = new Date(date.getTime() - offsetMilliseconds);
  const resultDate = new Date(0);
  resultDate.setFullYear(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  resultDate.setHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return resultDate;
}

// 与 date-fns 相同的记号切分正则
const formattingTokensRegExp = /[yYQqMLwIdDecihHKkms]o|(\w)\1*|''|'(''|[^'])+('|$)|./g;
const tzFormattingTokensRegExp = /([xXOz]+)|''|'(''|[^'])+('|$)/g;
const escapedStringRegExp = /^'([^]*?)'?$/;
const doubleQuoteRegExp = /''/g;
const unescapedLatinCharacterRegExp = /[a-zA-Z]/;

function cleanEscapedString(input: string): string {
  const matched = input.match(escapedStringRegExp);
  if (!matched) return input;
  return matched[1].replace(doubleQuoteRegExp, "'");
}

function formatToken(date: Date, token: string): string {
  switch (token[0]) {
    case 'y': {
      const signedYear = date.getFullYear();
      const year = signedYear > 0 ? signedYear : 1 - signedYear;
      return addLeadingZeros(token === 'yy' ? year % 100 : year, token.length);
    }
    case 'M':
      if (token === 'MM') return addLeadingZeros(date.getMonth() + 1, 2);
      break;
    case 'd':
      if (token === 'dd' || token === 'd') return addLeadingZeros(date.getDate(), token.length);
      break;
    case 'H':
      if (token === 'HH' || token === 'H') return addLeadingZeros(date.getHours(), token.length);
      break;
    case 'm':
      if (token === 'mm' || token === 'm') return addLeadingZeros(date.getMinutes(), token.length);
      break;
    case 's':
      if (token === 'ss' || token === 's') return addLeadingZeros(date.getSeconds(), token.length);
      break;
    case 'S': {
      const n = token.length;
      const fractional = Math.trunc(date.getMilliseconds() * Math.pow(10, n - 3));
      return addLeadingZeros(fractional, n);
    }
  }
  throw new RangeError(`Unsupported format token \`${token}\` in formatInTimeZone helper`);
}

/** date-fns `format` 的子集（只处理上面列出的记号）。 */
function formatPlain(date: Date, formatStr: string): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid time value');
  const tokens = formatStr.match(formattingTokensRegExp) || [];
  return tokens
    .map((substring) => {
      if (substring === "''") return "'";
      const firstCharacter = substring[0];
      if (firstCharacter === "'") return cleanEscapedString(substring);
      if (/^[yMdHmsS]$/.test(firstCharacter)) return formatToken(date, substring);
      if (unescapedLatinCharacterRegExp.test(firstCharacter)) {
        throw new RangeError('Format string contains an unescaped latin alphabet character `' + firstCharacter + '`');
      }
      return substring;
    })
    .join('');
}

/**
 * 在指定时区格式化日期，等价于 date-fns-tz 的 `formatInTimeZone(date, timeZone, formatStr)`。
 * timeZone 可以是 IANA 名称（如 "Asia/Shanghai"）、"Z"、"±hh"、"±hh:mm" / "±hhmm"。
 */
export function formatInTimeZone(date: Date, timeZone: string, formatStr: string): string {
  const originalDate = new Date(date.getTime());
  const zoned = toZonedTime(originalDate, timeZone);

  let str = String(formatStr);
  const matches = str.match(tzFormattingTokensRegExp);
  if (matches) {
    const d = new Date(originalDate.getTime());
    str = matches.reduce((result, token) => {
      if (token[0] === "'") return result;
      const pos = result.indexOf(token);
      const precededByQuotedSection = result[pos - 1] === "'";
      let value: string | undefined;
      if (token === 'XXX') {
        const offset = getTimeZoneOffsetMinutes(timeZone, d);
        value = offset === 0 ? 'Z' : formatTimezone(offset, ':');
      } else if (token === 'zzz' || token === 'zz' || token === 'z') {
        value = tzShortName(d, timeZone);
      } else {
        throw new RangeError(`Unsupported time zone token \`${token}\` in formatInTimeZone helper`);
      }
      const replaced = result.replace(token, "'" + value + "'");
      return precededByQuotedSection ? replaced.substring(0, pos - 1) + replaced.substring(pos + 1) : replaced;
    }, str);
  }
  return formatPlain(zoned, str);
}
