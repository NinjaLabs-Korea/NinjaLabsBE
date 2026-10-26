import { hasVisibleText } from './visible-text';

describe('hasVisibleText', () => {
  it.each(['a', '한글', 'a​b', ' x '])('accepts %j', (value) => expect(hasVisibleText(value)).toBe(true));
  it.each(['', ' ', '​', '​​', '​ ⁠﻿', 'ㅤ', 'ᅟᅠ', ' ‮', 5, null])('rejects %j', (value) =>
    expect(hasVisibleText(value)).toBe(false));
});
