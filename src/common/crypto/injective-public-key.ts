import { getEthereumAddress } from '@injectivelabs/sdk-ts';
import { computeAddress } from 'ethers';

/**
 * 클라이언트가 보낸 공개키가 그 inj1 주소의 키인지 - 서명 없이 할 수 있는 확인 (에이전트 등록 시점).
 *
 * Injective(ethsecp256k1)의 주소 = keccak256(비압축 공개키)[12:] - EVM 주소와 같은 파생이고 inj1…은 그 20바이트의 bech32다.
 * 그래서 ethers `computeAddress`(압축 키 → 0x 주소)와 inj1 → 0x 변환을 비교한다 (ADR-36 verify의 1단계와 같은 판정).
 * 이 확인이 없으면 남의 공개키를 내 지갑에 붙여 등록해 uq_agent_public_key를 선점하고, 그 키 주인의 등록을 24시간 409로 막을 수 있다.
 *
 * @param address      inj1… 주소
 * @param publicKeyB64 압축 secp256k1 공개키 (base64, 33바이트 - Keplr signArbitrary 응답의 pub_key.value)
 */
export function injectivePublicKeyMatchesAddress(address: string, publicKeyB64: string): boolean {
  try {
    const key = Buffer.from(publicKeyB64, 'base64');
    if (key.length !== 33) return false;
    return computeAddress(`0x${key.toString('hex')}`).toLowerCase() === getEthereumAddress(address).toLowerCase();
  } catch {
    return false; // 잘못된 bech32/곡선 밖의 점 등은 전부 "불일치"
  }
}
