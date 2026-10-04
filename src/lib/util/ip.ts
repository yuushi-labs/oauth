import { hmacSha256Hex } from './crypto';

const IPV4_MASKED_SUFFIX = 'xxx';

/** 表示用に IP を部分マスクする（§20）。保存は生値、表示のみマスク（D-13）。 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    return maskIpv6(ip);
  }

  const octets = ip.split('.');
  if (octets.length !== 4) {
    return ip;
  }
  return `${octets.slice(0, 3).join('.')}.${IPV4_MASKED_SUFFIX}`;
}

function maskIpv6(ip: string): string {
  const groups = ip.split(':');
  const keep = Math.max(1, Math.ceil(groups.length / 2));
  return `${groups.slice(0, keep).join(':')}:${IPV4_MASKED_SUFFIX}`;
}

/** pepper を Mix した hash（§20: 生 IP を保存せず、比較用途だけ hash で持つ）。 */
export function hashIp(ip: string, pepper: string): string {
  return hmacSha256Hex(pepper, ip);
}