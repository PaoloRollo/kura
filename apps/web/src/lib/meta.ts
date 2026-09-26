type CardRow = { id: bigint; label: string; ensName: string; state: string; condition: string; language: string; scryfallId: string };
type CardInfo = { name: string; setName: string; set: string; image: string; collectorNumber: string; rarity: string };

export type CardMetadata = ReturnType<typeof buildMetadata>;

/** Where card pages live when the vault's siteURI can't be read. Never localhost: the URL goes on chain and on labels. */
export const CARD_PAGE_FALLBACK = "https://kuravault.xyz/app/cards/";

/** A card's page: the vault's siteURI followed by the id, as CardVault builds it (`string.concat(siteURI, id)`). */
export function cardPageUrl(siteUri: string | undefined | null, id: bigint | number): string {
  return `${siteUri || CARD_PAGE_FALLBACK}${id.toString()}`;
}

/** ERC-721 metadata for a vault card, served at /api/meta/[id] (the vault's tokenURI). `siteUri` is the vault's siteURI. */
export function buildMetadata(card: CardRow, info: CardInfo, siteUri: string) {
  return {
    name: `${info.name} (${info.set.toUpperCase()}) #${card.id.toString()}`,
    description: `${info.name}, ${info.setName} #${info.collectorNumber}, ${card.condition}, held in the Kura vault. State: ${card.state}.`,
    image: info.image,
    external_url: cardPageUrl(siteUri, card.id),
    attributes: [
      { trait_type: "ENS", value: card.ensName },
      { trait_type: "Set", value: info.set.toUpperCase() },
      { trait_type: "Condition", value: card.condition },
      { trait_type: "Language", value: card.language },
      { trait_type: "Rarity", value: info.rarity },
      { trait_type: "State", value: card.state },
    ],
  };
}

/** The card's own name from a metadata name ("Black Lotus (LEA) #1" -> "Black Lotus"). */
export function metaCardName(name: string): string {
  return name.replace(/ \([A-Z0-9]+\) #\d+$/, "");
}

/** A trait's value from metadata attributes. */
export function metaTrait(meta: Pick<CardMetadata, "attributes">, trait: string): string | undefined {
  return meta.attributes.find((a) => a.trait_type === trait)?.value;
}
