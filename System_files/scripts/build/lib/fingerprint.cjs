#!/usr/bin/env node
'use strict';

/**
 * ============================================================
 * System_files/scripts/build/lib/fingerprint.cjs
 * ============================================================
 *
 * 역할:
 * - “내용 중복 판정”을 위한 fingerprint(지문 키) 생성 유틸
 *
 * 설계 목표:
 * - 입력(title/angle/audience/intent)을 안정적으로 정규화(normalize)한 뒤
 * - 해시(SHA1)로 fingerprint 생성
 * - seed-ledger.cjs 등에서 “이미 사용된 내용” 재사용 차단에 사용
 *
 * 주의:
 * - ID(예: app-ever-001)는 중복 판단에 쓰지 않습니다.
 * - 내용 중복은 fingerprint로만 판단합니다.
 */

const crypto = require('crypto');

const FP_VERSION = 'fp1'; // fingerprint 버전(정규화/구성 바뀌면 fp2로 올리기)

/**
 * 유니코드/공백/대소문자에 흔들리지 않도록 “과하지 않게” 정규화합니다.
 * - 너무 공격적으로 punctuation을 삭제하면 서로 다른 문장이 같은 값이 되기 쉬움
 * - 그래서 핵심은:
 *   1) NFKC 정규화
 *   2) 소문자화
 *   3) 공백 표준화(연속 공백 -> 1칸)
 *   4) 제로폭 문자 제거
 */
function normalizeText(input) {
  let s = String(input || '');

  // 1) 유니코드 정규화
  try { s = s.normalize('NFKC'); } catch {}

  // 2) 제로폭/제어 문자 제거(의미 없는 오염 제거)
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width
  s = s.replace(/[\u0000-\u001F\u007F]/g, ' '); // control chars -> space

  // 3) 흔한 유니코드 공백을 일반 공백으로
  s = s.replace(/\s+/g, ' ');

  // 4) 앞뒤 공백 제거 + 소문자
  s = s.trim().toLowerCase();

  return s;
}

/**
 * 입력 4필드 기반 fingerprint 생성
 * - separator는 일반 텍스트에 거의 등장하지 않는 U+001F(단위 구분자) 사용
 * - 해시는 SHA1(40 hex). 충돌 위험은 실무적으로 매우 낮음.
 *
 * @param {object} params
 * @param {string} params.normalizedTitle  이미 정규화된 title(권장) 또는 원문(title도 허용)
 * @param {string} params.angle
 * @param {string} params.audience
 * @param {string} params.intent
 * @returns {string} fp1:sha1hex
 */
function buildFingerprint({ normalizedTitle, angle, audience, intent }) {
  const t = normalizeText(normalizedTitle);
  const a = normalizeText(angle);
  const u = normalizeText(audience);
  const i = normalizeText(intent);

  // 누락 방지: title은 최소 핵심
  // (완전 누락이면 “무의미한 중복 판정”이 되어버림)
  if (!t) throw new Error('fingerprint: title missing');

  const payload = [t, a, u, i].join('\u001F');

  const hex = crypto
    .createHash('sha1')
    .update(payload, 'utf8')
    .digest('hex');

  return `${FP_VERSION}:${hex}`;
}

/**
 * seed 객체(시드 한 건)에서 fingerprint 생성
 * - seed.title/angle/audience/intent를 사용
 */
function buildFingerprintFromSeed(seed) {
  const s = seed && typeof seed === 'object' ? seed : {};
  return buildFingerprint({
    normalizedTitle: s.title,
    angle: s.angle,
    audience: s.audience,
    intent: s.intent,
  });
}

module.exports = {
  FP_VERSION,
  normalizeText,
  buildFingerprint,
  buildFingerprintFromSeed,
};
