import { hasNoBidiOverride, hasVisibleText } from './visible-text';

describe('hasVisibleText', () => {
  it.each(['a', '한글', 'a​b', ' x '])('accepts %j', (value) => expect(hasVisibleText(value)).toBe(true));
  it.each(['', ' ', '​', '​​', '​ ⁠﻿', 'ㅤ', 'ᅟᅠ', '⠀⠀', '\u00AD\u00AD', '\u202E', ' ‮', 5, null])('rejects %j', (value) =>
    expect(hasVisibleText(value)).toBe(false));
});

describe('hasVisibleText: Default_Ignorable와 결합 문자만', () => {
  it.each(['\u034F\u034F\u034F', '\uFE0F\uFE0F\uFE0F', '\uFFFC\uFFFC', '\u17B4\u17B4', '\u180B\u180B', '\uE000\uE000', '\u0378\u0378', '\u0301', '\uFE0F', '\u034F'])(
    'rejects %j',
    (value) => expect(hasVisibleText(value)).toBe(false),
  );
  it.each(['e\u0301', 'ก็', 'a\u034Fb'])('accepts %j', (value) => expect(hasVisibleText(value)).toBe(true));
});

describe('hasNoBidiOverride', () => {
  it.each(['a', 'line\nbreak', 'مرحبا', 'a\u200Fb'])('accepts %j', (v) => expect(hasNoBidiOverride(v)).toBe(true));
  it.each(['\u202E', 'a\u202Eb', '\u202A', '\u2066x', 5])('rejects %j', (v) => expect(hasNoBidiOverride(v)).toBe(false));
});
