// jschardet 4 (chardet 7 port) changed result names and the confidence scale. These tests pin the
// SftpService.readFile auto-detection outcome so a detector upgrade cannot silently start decoding
// e.g. Shift_JIS / EUC-KR / Windows-1251 files as GB18030.
const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const iconv = require('iconv-lite');
const { SftpService } = require('../dist/sftp/sftp.service.js');

const readWithAutoDetect = async buffer => {
  const sent = [];
  const states = new Map([[
    's1',
    {
      sftp: { createReadStream: () => Readable.from(buffer.length ? [buffer] : []) },
      ws: { send: msg => sent.push(JSON.parse(msg)) },
    },
  ]]);
  const service = new SftpService(states);
  await service.readFile('s1', '/file.txt', 'r1');
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1, 'exactly one reply');
  assert.equal(sent[0].type, 'sftp:readfile:success', JSON.stringify(sent[0]));
  assert.equal(Buffer.from(sent[0].payload.rawContentBase64, 'base64').equals(buffer), true, 'raw bytes are passed through');
  return sent[0].payload.encodingUsed;
};

const zh = '这是一个用于测试编码检测的中文文本文件，包含一些常见的汉字和标点符号。服务器配置文件路径和日志说明。\n'.repeat(3);
const ja = 'これは文字コード判定のテスト用の日本語テキストです。設定ファイルの説明。\n'.repeat(3);
const ko = '이것은 인코딩 감지를 위한 한국어 텍스트 파일입니다. 설정 파일 설명.\n'.repeat(3);
const ru = 'Это тестовый текст на русском языке для определения кодировки.\n'.repeat(3);
const fr = 'Café crème brûlée à la française, façade naïve — déjà vu. Où est le garçon?\n'.repeat(3);

const decodesBack = (buffer, encodingUsed, text) => {
  assert.equal(iconv.encodingExists(encodingUsed), true, `${encodingUsed} must be an iconv-lite encoding`);
  assert.equal(iconv.decode(buffer, encodingUsed), text);
};

test('UTF-8, ASCII, empty and UTF-8-with-BOM files decode as utf-8', async () => {
  assert.equal(await readWithAutoDetect(Buffer.from(zh)), 'utf-8');
  assert.equal(await readWithAutoDetect(Buffer.from('#!/bin/sh\necho hello\n')), 'utf-8');
  assert.equal(await readWithAutoDetect(Buffer.alloc(0)), 'utf-8');
  assert.equal(await readWithAutoDetect(Buffer.from('\uFEFFhello 世界')), 'utf-8');
});

test('GBK text is decoded as gb18030 (Chinese family)', async () => {
  assert.equal(await readWithAutoDetect(iconv.encode(zh, 'gbk')), 'gb18030');
  assert.equal(await readWithAutoDetect(iconv.encode('中文测试', 'gbk')), 'gb18030');
});

test('non-Chinese legacy encodings keep the detected codec instead of GB18030', async () => {
  for (const [text, enc] of [[ja, 'shift_jis'], [ja, 'euc-jp'], [ko, 'euc-kr'], [ru, 'cp1251'], [fr, 'cp1252']]) {
    const buffer = iconv.encode(text, enc);
    const used = await readWithAutoDetect(buffer);
    assert.notEqual(used, 'gb18030', `${enc} must not be decoded as gb18030`);
    decodesBack(buffer, used, text);
  }
});
