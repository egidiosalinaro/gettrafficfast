import { ImageStyle, MediaSettings } from "./settings";

/**
 * Whether the business has something a camera can be pointed at. Decided by
 * the image-brief agent from the business's niche and description, as a field
 * of its structured output: a bakery, a clinic and a building firm are
 * "physical"; a scheduling tool or an API is "digital".
 */
export type SubjectKind = "physical" | "digital";

/** The look a render actually gets: a preset, the business's own, or the editorial fallback. */
export type ImageLook = Exclude<ImageStyle, "custom"> | "custom" | "editorial";

/**
 * Composes the final image prompt from the agent's scene description and the
 * business's style settings. Deterministic code, not inference: the agent
 * describes WHAT the picture shows; the brand look is applied the same way
 * every time.
 *
 * Each directive says what to produce AND what to avoid: image models drift
 * toward the average of their training data, and naming the neighbouring
 * styles as exclusions is what keeps four looks actually distinct.
 */

const STYLE_DIRECTIVES: Record<Exclude<ImageStyle, "custom">, string> = {
  photographic:
    "Realistic professional photograph, natural lighting, shallow depth of field, fine detail. Do NOT produce illustrations, 3D renders, diagrams or infographics.",
  render_3d:
    "Stylized 3D CGI render: smooth glossy materials, subtly exaggerated cartoon proportions, vivid saturated colours, strong studio key light with a soft rim light, clean synthetic surfaces. It must be unmistakably computer-generated. Do NOT produce photographs or anything photorealistic, and do NOT produce flat illustrations or diagrams.",
  illustration:
    "Flat vector illustration, bold simple shapes, limited palette, generous negative space. Do NOT produce photographs, 3D renders or diagrams.",
  claymation:
    "Playful clay-sculpted scene, handmade plasticine textures, soft rounded forms, warm studio light. Do NOT produce photographs, flat vector art or diagrams.",
};

/**
 * For a business with nothing physical when the style is photography. A
 * "professional photograph" of software has no subject, and the model fills
 * the gap with the glowing-brain stock look; a plain editorial illustration
 * of an everyday scene is a look it can actually deliver.
 */
const EDITORIAL_DIRECTIVE =
  "Clean editorial illustration, like a magazine spot illustration: simple hand-drawn shapes, flat muted colours, a limited palette, calm composition, generous negative space. Do NOT produce photographs, 3D renders, glow or neon effects, diagrams or infographics.";

const UNIVERSAL_CONSTRAINTS =
  "No text, no words, no letters, no numbers, no logos, no watermarks, no screens, no user interfaces, no charts, no signs.";

/**
 * For a digital subject (since 2026-11-12) a person at a laptop or a monitor
 * is an allowed scene, so "no screens" would contradict it: the screen is
 * there, and shows nothing legible.
 */
const DIGITAL_CONSTRAINTS =
  "No text, no words, no letters, no numbers, no logos, no watermarks, no user interfaces, no charts, no signs. Any laptop or monitor screen is out of focus and shows only soft blurred shapes, never legible text.";

/**
 * The look this render gets. Photography needs a photographable subject, so
 * a digital business that is set to photography (the default nobody chose,
 * as often as not) gets the editorial illustration instead. Every other
 * style, and a style the business wrote itself, is applied as chosen: an
 * illustration or a clay scene does not promise a real subject.
 */
export function resolveImageLook(settings: MediaSettings, subject: SubjectKind): ImageLook {
  if (settings.style === "custom") {
    return settings.styleInstructions.trim() ? "custom" : resolveImageLook({ ...settings, style: "photographic" }, subject);
  }
  if (settings.style === "photographic" && subject === "digital") return "editorial";
  return settings.style;
}

function directiveFor(look: ImageLook, settings: MediaSettings): string {
  if (look === "custom") return settings.styleInstructions.trim();
  if (look === "editorial") return EDITORIAL_DIRECTIVE;
  return STYLE_DIRECTIVES[look];
}

/**
 * The full prompt. `subject` defaults to "physical", which applies the
 * business's style exactly as set: the default for callers that render a
 * fixed scene (the style previews), not for articles, where the brief says
 * which it is.
 */
export function composeImagePrompt(
  scene: string,
  settings: MediaSettings,
  subject: SubjectKind = "physical"
): string {
  const parts = [scene.trim(), directiveFor(resolveImageLook(settings, subject), settings)];

  if (settings.brandPalette.length > 0) {
    parts.push(
      `Color palette leaning on ${settings.brandPalette.join(", ")} — as accents, never flooding the scene.`
    );
  }
  parts.push(subject === "digital" ? DIGITAL_CONSTRAINTS : UNIVERSAL_CONSTRAINTS);

  return parts.join(" ");
}
