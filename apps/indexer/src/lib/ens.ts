import { type Hex, keccak256, stringToBytes, zeroAddress } from "viem";

/**
 * ENSv2 tokenIds carry a version in the low 32 bits, so the same name can surface
 * under different tokenIds. Two tokenIds refer to the same name when their high bits match.
 */
export const sameEnsToken = (a: bigint, b: bigint): boolean => a >> 32n === b >> 32n;

/** keccak256 of the raw label bytes, as CardNames and the registry compute it. */
export const labelHashOf = (label: string): Hex => keccak256(stringToBytes(label));

/**
 * The hex prefix (0x + 56 chars) shared by every id of a name: its labelhash and all versioned tokenIds.
 * Lets LabelUnregistered, which may carry either form, find the row with a LIKE on `ens_names.label_hash`.
 */
export const ensTokenPrefix = (id: bigint): string => `0x${(id >> 32n).toString(16).padStart(56, "0")}`;

/**
 * Kind of a label seen only through the registry. Card labels always contain a dash and collector handles never do
 * (CardNames._requireHandle); CardNamed / CollectorNamed then set the kind authoritatively.
 */
export const nameKindOf = (label: string): "card" | "collector" | "agent" =>
  label === "appraiser" ? "agent" : label.includes("-") ? "card" : "collector";

/**
 * A collector resolver grants its collector root roles, so they can write records for ANY node on it. Only accept a
 * CollectorResolver record when the emitting resolver belongs to a known collector and the node is that collector's
 * own; anything else would let a collector overwrite card rows in ens_records.
 */
export const acceptCollectorRecord = (
  collector: { resolver: Hex; node: Hex } | undefined,
  logAddress: Hex,
  node: Hex,
): boolean =>
  !!collector && collector.resolver.toLowerCase() === logAddress.toLowerCase() && collector.node.toLowerCase() === node.toLowerCase();

const COIN_TYPE_ETH = 60n;

/** ENSIP-11/19 EVM coin types: ETH (60) and 0x80000000 | chainId, where chainId 0 is the default EVM address. */
const isEvmCoinType = (coinType: bigint): boolean =>
  coinType === COIN_TYPE_ETH || (coinType >= 0x80000000n && coinType <= 0xffffffffn);

/**
 * The ens_records key and value for a PermissionedResolver AddressUpdated. The ETH address keeps the `addr` key (the
 * web and the handlers read it), other coin types go under `addr:<coinType>`. Values are lowercase so they compare
 * directly with hex columns such as cards.beneficialOwner; a cleared EVM address reads as the zero address, as addr()
 * returns it.
 */
export const addressRecordOf = (coinType: bigint, addressBytes: Hex): { key: string; value: string } => {
  const key = coinType === COIN_TYPE_ETH ? "addr" : `addr:${coinType}`;
  const value = addressBytes === "0x" && isEvmCoinType(coinType) ? zeroAddress : addressBytes.toLowerCase();
  return { key, value };
};

/** PermissionedResolver.linkToRecord(name, 0) emits Linked(0, node, name): the node no longer has its own record. */
export const isUnlink = (recordId: bigint): boolean => recordId === 0n;
