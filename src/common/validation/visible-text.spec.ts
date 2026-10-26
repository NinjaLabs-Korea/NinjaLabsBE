import { hasNoBidiOverride, hasVisibleText } from './visible-text';

describe('hasVisibleText', () => {
  it.each(['a', '한글', 'a​b', ' x '])('accepts %j', (value) => expect(hasVisibleText(value)).toBe(true));
  it.each(['', ' ', '​', '​​', '​ ⁠﻿', 'ㅤ', 'ᅟᅠ', '⠀⠀', '\u00AD\u00AD', '\u202E', ' ‮', 5, null])('rejects %j', (value) =>
    expect(hasVisibleText(value)).toBe(false));
});

describe('hasNoBidiOverride', () => {
  it.each(['a', 'line\nbreak', 'مرحبا', 'a\u200Fb'])('accepts %j', (v) => expect(hasNoBidiOverride(v)).toBe(true));
  it.each(['\u202E', 'a\u202Eb', '\u202A', '\u2066x', 5])('rejects %j', (v) => expect(hasNoBidiOverride(v)).toBe(false));
});
