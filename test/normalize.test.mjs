import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normSlotCode, normNumber, normText } from '../src/lib/normalize.js';

test('normSlotCode normalizes full-width digits and spaces', () => {
  assert.equal(normSlotCode('火１'), '火1');
  assert.equal(normSlotCode(' 火 1 '), '火1');
  assert.equal(normSlotCode('月'), '月');
  assert.equal(normSlotCode('土'), null);
  assert.equal(normSlotCode(''), null);
});

test('normNumber', () => {
  assert.equal(normNumber('１２３．４'), 123.4);
  assert.equal(normNumber(' 145 '), 145);
  assert.equal(normNumber(''), null);
  assert.equal(normNumber(null), null);
  assert.equal(normNumber(98.5), 98.5);
  assert.equal(normNumber('記録なし'), 'invalid');
  assert.equal(normNumber('-3'), 'invalid');
});

test('normText', () => {
  assert.equal(normText('　山田　太郎 '), '山田 太郎');
  assert.equal(normText('   '), null);
  assert.equal(normText(undefined), null);
});
