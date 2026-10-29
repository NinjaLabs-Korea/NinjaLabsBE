import { isReservedNickname, isSavableNickname, NICKNAME } from './nickname';

// 로마 숫자 ⅽ(U+217D) ⅼ(U+217C), 닷리스 ı(U+0131), 스몰캡 ᴍ(U+1D0D), IPA ɑ(U+0251), 체로키 Ꭺ(U+13AA), 리수 ꓐ(U+A4D0), 아르메니아 ո(U+0578)
const HOMOGLYPHS = ['ɑdmin', 'ᎪDMIN', 'ꓐdmin', 'coreոinja', 'ⅽoreninja', 'buiⅼderone', 'buılderone', 'adᴍn'];

describe('nickname homoglyph guard', () => {
  it.each(HOMOGLYPHS)('rejects %s', (name) => {
    expect(NICKNAME.test(name)).toBe(false);
    expect(isSavableNickname(name)).toBe(false);
  });

  it('rejects other scripts mixed with Latin (Cyrillic, Greek, Georgian, Coptic)', () => {
    for (const name of ['аdmin', 'buіlderone', 'οrbit', 'ninjaა', 'ninjaⲁ']) expect(isSavableNickname(name)).toBe(false);
  });

  it.each(['coreninja', 'coreninja2', 'builder_one', '닌자', '忍者', 'ninja닌자', 'ninja忍者', 'ninjaニンジャ', 'café', 'Zoë', 'José', 'user123', 'a1'])('still accepts %s', (name) => {
    expect(isSavableNickname(name)).toBe(true);
  });

  // 결정: 키릴 전용, 그리스 전용 이름은 기존대로 허용 (라틴과 섞일 때만 거부). 예약어 닮은꼴은 골격으로 막는다.
  it('keeps Cyrillic-only and Greek-only names allowed', () => {
    expect(isSavableNickname('Привет')).toBe(true);
    expect(isSavableNickname('Αθήνα')).toBe(true);
  });

  it('folds all-foreign-script look-alikes of reserved words', () => {
    expect(isReservedNickname('адмін')).toBe(false); // админ is not "admin"
    expect(isReservedNickname('аdmin')).toBe(true);
    expect(isReservedNickname('ᎪᎠᎷᎵᏀ')).toBe(false);
    expect(isReservedNickname('ᎪᎠᎷᎵո')).toBe(true); // Ꭺ Ꭰ Ꮇ Ꭵ ո -> admin
    expect(isReservedNickname('ան')).toBe(false);
  });
});
