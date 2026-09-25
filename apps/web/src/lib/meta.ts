type CardRow = { id: bigint; label: string; ensName: string; state: string; condition: string; language: string; scryfallId: string };
type CardInfo = { name: string; setName: string; set: string; image: string; collectorNumber: string; rarity: string };

export type CardMetadata = ReturnType<typeof buildMetadata>;

/** ERC-721 metadata for a vault card, served at /api/meta/[id] (the vault's tokenURI). */
export function buildMetadata(card: CardRow, info: CardInfo, siteBase: string) {
  const base = siteBase.replace(/\/+$/, "");
  return {
    name: `${info.name} (${info.set.toUpperCase()}) #${card.id.toString()}`,
    description: `${info.name}, ${info.setName} #${info.collectorNumber}, ${card.condition}, held in the Kura vault. State: ${card.state}.`,
    image: info.image,
    external_url: `${base}/app/cards/${card.id.toString()}`,
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
