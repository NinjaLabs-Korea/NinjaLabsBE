import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { listSourceFiles } from '../test-support/source-files';
import { ONBOARDING_STEP } from './onboarding-step';

const SRC_ROOT = join(__dirname, '..');

describe('ONBOARDING_STEP', () => {
  it('keeps the stored values the FE and existing rows depend on (2 wallet, 3 profile, 4 profile saved)', () => {
    expect(ONBOARDING_STEP).toEqual({ WALLET: 2, PROFILE: 3, PROFILE_SAVED: 4 });
  });

  it('server code compares or assigns onboarding steps only through the constant (no bare step numbers)', () => {
    const bare = /onboarding_step\s*(?:=|>=|<=|>|<)\s*\d|GREATEST\(\s*onboarding_step\s*,\s*\d|onboardingStep:\s*\d/;
    const offenders = listSourceFiles(SRC_ROOT, { include: /^(?!test-|users\/onboarding-step\.ts$)/ })
      .filter((file) => bare.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
