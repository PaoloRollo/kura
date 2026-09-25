import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's structured-output helper is built on Zod 4; zod@3.25 ships it under the `zod/v4` subpath.
import { z } from "zod/v4";

export class RecognitionUnavailableError extends Error {
  constructor(message = "recognition unavailable") {
    super(message);
    this.name = "RecognitionUnavailableError";
  }
}

const RecognitionSchema = z.object({
  name: z.string().describe("The card's English name as printed by Wizards of the Coast, even if the card is in another language"),
  setHint: z.string().nullable().describe("Lowercase Scryfall set code if the set symbol or code is recognisable, else null"),
  collectorNumber: z.string().nullable().describe("Collector number if printed and legible, else null"),
  language: z.string().describe("Scryfall language code of the printed text: en, ja, zhs, zht, ko, de, fr, it, es, pt, ru"),
  foil: z.boolean().describe("True if the card surface shows foil treatment"),
  confidence: z.number().min(0).max(1).describe("Confidence that the name is correct"),
});

export type Recognition = z.infer<typeof RecognitionSchema>;

export type RecognizeInput = { imageBase64: string; mediaType: "image/jpeg" | "image/png" | "image/webp"; languageHint?: string };

let client: Anthropic | null = null;
function visionClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/** Identify a Magic card from a webcam frame. Structured output; a missing key, API errors, refusals and parse failures become RecognitionUnavailableError. */
export async function recognizeCard(input: RecognizeInput): Promise<Recognition> {
  if (!process.env.ANTHROPIC_API_KEY) throw new RecognitionUnavailableError("vision model is not configured");
  const model = process.env.VISION_MODEL ?? "claude-opus-5-5";
  const hint = input.languageHint ? ` The vendor says the printed language is probably "${input.languageHint}".` : "";
  let response;
  try {
    response = await visionClient().messages.parse({
      model,
      max_tokens: 2048,
      output_config: { effort: "low", format: zodOutputFormat(RecognitionSchema) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 } },
            {
              type: "text",
              text:
                "This is a photo of a single Magic: The Gathering card held in front of a webcam. Identify it. " +
                "Report the English card name exactly as Wizards prints it, the set code if the set symbol or bottom-left code is legible, " +
                "the collector number if legible, the language of the printed text, whether it is foil, and your confidence." + hint,
            },
          ],
        },
      ],
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new RecognitionUnavailableError(`api ${e.status}: ${e.message}`);
    // Structured-output parse/validation failures (and other SDK errors) are AnthropicError.
    if (e instanceof Anthropic.AnthropicError) throw new RecognitionUnavailableError(e.message);
    throw e;
  }
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new RecognitionUnavailableError(response.stop_reason ?? "no output");
  return response.parsed_output;
}
