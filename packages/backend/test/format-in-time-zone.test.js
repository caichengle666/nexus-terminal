// 本地 formatInTimeZone 替代了 date-fns-tz（生产包少约 13 MB）。这里把它与 date-fns-tz
// （仅作为 devDependency 保留用于对比）在大量日期 / 时区 / 格式组合上的输出逐一对比。
const assert = require('node:assert/strict');
const test = require('node:test');
const { formatInTimeZone } = require('../dist/utils/format-in-time-zone.js');
const reference = require('date-fns-tz').formatInTimeZone;

// 通知模块实际使用的两种格式，外加若干字面量 / 转义组合
const FORMATS = [
  'yyyy-MM-dd HH:mm:ss zzz',
  "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
  "'at' HH:mm '(''quoted'')' zzz",
  'zzz yyyy',
  "XXX'T'",
];

const ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Casablanca',
  'Pacific/Apia',
  'Etc/GMT+12',
  'Etc/GMT-14',
  'Z',
  '+08',
  '-05',
  '+05:30',
  '-0930',
  '+00:00',
];

function collectDates() {
  const dates = [
    new Date('2026-01-01T00:00:00.000Z'),
    new Date('2026-03-08T06:59:59.999Z'), // 美东夏令时切换前后
    new Date('2026-03-08T07:00:00.000Z'),
    new Date('2026-03-29T00:59:59.500Z'), // 欧洲夏令时切换
    new Date('2026-03-29T01:00:00.001Z'),
    new Date('2026-10-25T00:59:59.000Z'),
    new Date('2026-10-25T01:00:00.000Z'),
    new Date('2026-11-01T05:30:00.123Z'),
    new Date('2026-11-01T06:30:00.456Z'),
    new Date('2024-02-29T23:59:59.999Z'), // 闰日
    new Date('1999-12-31T23:59:59.001Z'),
    new Date('2038-01-19T03:14:07.000Z'),
    new Date(0),
    new Date(Date.now()),
  ];
  // 一年内每隔约 37 小时取一个点，覆盖各种墙上时间
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 240; i++) dates.push(new Date(start + i * 37 * 3600 * 1000 + (i * 7919) % 1000));
  return dates;
}

function outcome(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, name: error.name, message: error.message };
  }
}

test('formatInTimeZone matches date-fns-tz for every zone/format/date combination', () => {
  const dates = collectDates();
  let compared = 0;
  for (const zone of ZONES) {
    for (const fmt of FORMATS) {
      for (const date of dates) {
        const expected = outcome(() => reference(date, zone, fmt));
        const actual = outcome(() => formatInTimeZone(date, zone, fmt));
        assert.deepEqual(actual, expected, `zone=${zone} fmt=${fmt} date=${date.toISOString()}`);
        compared++;
      }
    }
  }
  assert.ok(compared > 25000);
});

test('formatInTimeZone matches date-fns-tz for invalid input (same error)', () => {
  const cases = [
    [new Date('2026-05-01T12:00:00Z'), 'Not/AZone'],
    [new Date('2026-05-01T12:00:00Z'), '+25'],
    [new Date('2026-05-01T12:00:00Z'), '+05:75'],
    [new Date(NaN), 'Asia/Shanghai'],
    [new Date(NaN), 'UTC'],
    [new Date(NaN), '+08:00'],
  ];
  for (const [date, zone] of cases) {
    for (const fmt of FORMATS.slice(0, 2)) {
      const expected = outcome(() => reference(date, zone, fmt));
      const actual = outcome(() => formatInTimeZone(date, zone, fmt));
      assert.equal(expected.ok, false, `reference should throw for ${zone} ${fmt}`);
      assert.deepEqual(actual, expected, `zone=${zone} fmt=${fmt} date=${String(date)}`);
    }
  }
});

test('formatInTimeZone produces the expected notification timestamps', () => {
  const date = new Date('2026-10-25T12:03:04.567Z');
  assert.equal(formatInTimeZone(date, 'Asia/Shanghai', "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"), '2026-10-25T20:03:04.567+08:00');
  assert.equal(formatInTimeZone(date, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"), '2026-10-25T12:03:04.567Z');
  assert.match(formatInTimeZone(date, 'Asia/Shanghai', 'yyyy-MM-dd HH:mm:ss zzz'), /^2026-10-25 20:03:04 \S+/);
});
