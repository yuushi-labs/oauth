import { ulid } from 'ulid';

export const ID_PREFIXES = ['usr', 'ses', 'acc', 'evt', 'tok', 'wac', 'wch'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ULID_LENGTH = 26;
const SEPARATOR = '_';

export function newId(prefix: IdPrefix): string {
  return `${prefix}${SEPARATOR}${ulid()}`;
}

export function isIdPrefix(value: string): value is IdPrefix {
  return (ID_PREFIXES as readonly string[]).includes(value);
}

export type ParsedId = { prefix: IdPrefix; ulid: string };

export function parseId(value: string, expectedPrefix?: IdPrefix): ParsedId {
  const separatorIndex = value.indexOf(SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error('不正なID形式です');
  }

  const prefix = value.slice(0, separatorIndex);
  const id = value.slice(separatorIndex + 1);

  if (!isIdPrefix(prefix)) {
    throw new Error(`不正なID prefix です: ${prefix}`);
  }
  if (expectedPrefix && prefix !== expectedPrefix) {
    throw new Error(`期待しないID prefix です: ${prefix}`);
  }
  if (id.length !== ULID_LENGTH) {
    throw new Error('不正なULIDです');
  }

  return { prefix, ulid: id };
}