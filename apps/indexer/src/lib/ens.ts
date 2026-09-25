/**
 * ENSv2 tokenIds carry a version in the low 32 bits, so the same name can surface
 * under different tokenIds. Two tokenIds refer to the same name when their high bits match.
 */
export const sameEnsToken = (a: bigint, b: bigint): boolean => a >> 32n === b >> 32n;
