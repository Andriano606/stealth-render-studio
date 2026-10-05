// Контраст токенів (public/css/base.css): білий текст на фонах кнопок і тексти на
// виділених картках — WCAG AA 4.5:1 для звичайного (не великого) тексту. Щоб пари не
// регресували непомітно.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'css', 'base.css'), 'utf8');
const root = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')));
const token = (name) => {
  const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(root);
  assert.ok(m, 'токен --' + name);
  return m[1];
};
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('контраст: білий на кнопках (primary/danger, hover) і --text-dim на виділеній картці ≥ 4.5:1', () => {
  for (const t of ['accent-btn', 'accent-btn-hover', 'danger-btn', 'danger-btn-hover']) {
    const r = ratio('#ffffff', token(t));
    assert.ok(r >= 4.5, '--' + t + ': ' + r.toFixed(2));
  }
  assert.ok(ratio(token('text-dim'), token('bg-accent-weak')) >= 4.5);
  for (const t of ['text', 'text-2', 'text-muted', 'text-dim', 'text-faint']) assert.ok(ratio(token(t), token('bg')) >= 4.5, '--' + t + ' на --bg');
  // Кнопки справді використовують «кнопкові» токени, а не --accent/--danger (3.7 / 4.2 : 1).
  assert.match(CSS, /\.btn-primary \{ background: var\(--accent-btn\)/);
  assert.match(CSS, /\.btn-danger \{ background: var\(--danger-btn\)/);
});
