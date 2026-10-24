import { maxLength } from 'class-validator';
import { charLength, MaxChars } from './max-chars';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

class Probe {
  @MaxChars(5) value!: unknown;
}

const errors = async (value: unknown) => (await validate(plainToInstance(Probe, { value }))).length;

describe('MaxChars (Postgres VARCHAR length = code points)', () => {
  it('counts astral characters once and variation selectors as their own code point, like char_length()', () => {
    expect(charLength('😀😀')).toBe(2);
    expect(charLength('❤️')).toBe(2); // U+2764 U+FE0F
    // class-validator's MaxLength drops U+FE0F from the count — the reason this validator exists
    expect(maxLength('❤️'.repeat(3), 5)).toBe(true);
  });

  it('accepts up to the limit and rejects beyond it', async () => {
    expect(await errors('abcde')).toBe(0);
    expect(await errors('😀'.repeat(5))).toBe(0);
    expect(await errors('abcdef')).toBe(1);
    expect(await errors('❤️'.repeat(3))).toBe(1);
  });

  it('leaves non-strings to @IsString()', async () => {
    expect(await errors(123)).toBe(0);
  });
});
