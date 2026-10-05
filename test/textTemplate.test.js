// Юніт-тести шаблону тексту (lib/textTemplate.js): {d} {l} {{ та legacy random.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplate, stepText } from '../lib/textTemplate.js';
import { mulberry32 } from '../lib/rng.js';

test('expandTemplate: {d} → цифра, {l} → літера, {{ → «{»', () => {
  const r = mulberry32(3);
  assert.match(expandTemplate('john{d}{d}@ex.com', r), /^john[0-9]{2}@ex\.com$/);
  assert.match(expandTemplate('{l}{l}{l}', r), /^[a-z]{3}$/);
  assert.equal(expandTemplate('a{{d}b', r), 'a{d}b'); // екранування
  assert.equal(expandTemplate('{{{{', r), '{{');
});

test('expandTemplate: усе інше — літерально (старі 1-символьні під-дії не змінюються)', () => {
  for (const s of ['{', '}', 'd', '{x}', '{d', 'l}', '{ d}', 'Ї', '']) assert.equal(expandTemplate(s), s);
  assert.equal(expandTemplate(null), '');
  assert.equal(expandTemplate(undefined), '');
  assert.equal(expandTemplate(42), '42');
});

test('expandTemplate: детермінований з тим самим rng; межі rng (0 і ~1)', () => {
  assert.equal(expandTemplate('{d}{l}', mulberry32(9)), expandTemplate('{d}{l}', mulberry32(9)));
  assert.equal(expandTemplate('{d}{l}', () => 0), '0a');
  assert.equal(expandTemplate('{d}{l}', () => 0.9999999), '9z');
});

test('stepText: legacy random має пріоритет; інакше шаблон', () => {
  assert.match(stepText({ text: 'x', random: 'digit' }, mulberry32(1)), /^[0-9]$/);
  assert.match(stepText({ text: 'x', random: 'letter' }, mulberry32(1)), /^[a-z]$/);
  assert.equal(stepText({ text: 'x' }), 'x');
  assert.match(stepText({ text: '+380{d}{d}' }, mulberry32(1)), /^\+380[0-9]{2}$/);
});
