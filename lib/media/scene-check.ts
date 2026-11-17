/**
 * What a scene description may not say, checked in code before a render is
 * paid for.
 *
 * In production on 2026-11-10, 72 of the 82 image prompts of one site read
 * like "A futuristic, holographic calendar… projected from a stylized,
 * glowing AI brain", followed by the photographic style directive. A camera
 * cannot photograph a holographic calendar, so the model resolved the
 * contradiction the only way it could: the stock "AI picture" look, on every
 * article. Asking the model not to do it was already in the prompt. This is
 * the part that does not depend on being obeyed.
 *
 * Two lists, both deterministic and both about the SCENE, never about a
 * vendor or a style:
 *
 *  - abstract vocabulary: words for things that are not in front of a camera
 *    or on an illustrator's desk (glows, holograms, data streams, "a
 *    representation of");
 *  - written surfaces: things that only make sense with text on them
 *    (screens, dashboards, charts, calendars, signs). Image models fill them
 *    with letter-shaped noise, which is worse than no image.
 *
 * A scene that names any of them is rejected, the agent is asked once more,
 * and a scene that still fails is not rendered.
 */

interface Term {
  label: string;
  pattern: RegExp;
}

function term(label: string, source: string): Term {
  return { label, pattern: new RegExp(`\\b(?:${source})\\b`, "i") };
}

const ABSTRACT_TERMS: Term[] = [
  term("glowing", "glow(?:s|ing|ed)?|luminous|luminescent|shimmering|neon"),
  term("holographic", "holograph(?:ic|y)?|holograms?"),
  term("futuristic", "futuristic|sci-?fi|science[- ]fiction|cyber(?:punk|space)?|high-tech"),
  term("AI brain", "(?:ai|digital|electronic|robotic|artificial|cyber|mechanical)[- ]brains?|brain made of|artificial intelligence"),
  term("AI", "ai"),
  term("neural", "neural|neurons?|synap(?:se|ses|tic)"),
  term("data streams", "data[- ]?(?:streams?|flows?|points?|particles?|visuali[sz]ations?)|streams? of (?:data|information|light)|binary code|lines of code"),
  term("digital landscape", "digital (?:landscape|world|realm|space|universe|environment|ecosystem|network|interface|overlay)s?|virtual (?:world|space|reality|environment)s?"),
  term("abstract", "abstract(?:ion|ions|ly)?|conceptual|surreal"),
  term("representation of", "(?:representation|visuali[sz]ation|depiction|embodiment|personification|metaphor|symbol)s? (?:of|for)|represent(?:s|ing)|symboli[sz](?:e|es|ing|ed)|metaphor(?:ical|ically)?|the concept of|the idea of"),
  term("stylized", "styli[sz]ed"),
  term("floating elements", "floating (?:icons?|symbols?|shapes?|screens?|interfaces?|data|numbers?|panels?|windows?|elements?|graphs?|charts?)|hovering (?:icons?|symbols?|screens?|panels?)"),
  term("nodes", "nodes?|interconnected (?:lines|dots|points)|network of (?:lines|dots|points|lights)|circuit(?:ry| boards?)?|pixels?|wireframes?"),
  term("energy", "energy (?:fields?|waves?|beams?|lines?)|beams? of light|light trails?|particles of light|ethereal|cosmic|aura"),
  term("icons", "icons?|emojis?|pictograms?"),
];

const WRITTEN_SURFACE_TERMS: Term[] = [
  term("screen", "screens?|monitors?|touchscreens?|(?:digital|computer|laptop|phone|led|lcd) displays?|projections?|projected"),
  term("dashboard", "dashboards?|user interfaces?|interfaces?|ui|apps?|websites?|web ?pages?|browser(?: window)?s?|software windows?|search results?|search bar"),
  term("chart", "charts?|graphs?|diagrams?|infographics?|flowcharts?|spreadsheets?|statistics|analytics"),
  term("calendar", "calendars?|planners?|schedules?|timetables?|timelines?"),
  term("signage", "signage|signs?|signboards?|billboards?|banners?|posters?|placards?|whiteboards?|blackboards?|chalkboards?|sticky notes?|post-?its?"),
  term("text", "text|words?|lettering|numbers?(?! of)|numerals?|digits?|captions?|headlines?|typography|logos?|watermarks?|handwriting|handwritten|printed (?:page|document)s?"),
];

function hits(text: string, terms: Term[]): string[] {
  return terms.filter((entry) => entry.pattern.test(text)).map((entry) => entry.label);
}

/** The abstract vocabulary a scene uses; empty when it uses none. */
export function abstractVocabularyIn(scene: string): string[] {
  return hits(scene, ABSTRACT_TERMS);
}

/** The text-bearing surfaces a scene puts in the frame; empty when none. */
export function writtenSurfacesIn(scene: string): string[] {
  return hits(scene, WRITTEN_SURFACE_TERMS);
}

/**
 * What makes a screen acceptable for a digital subject (2026-11-12): it is
 * out of focus, or shows only shapes, so there is nothing legible on it.
 * These phrases are also taken out of the scene before the other checks
 * run, so "soft abstract shapes" and "no legible text" describing the
 * screen are not read as abstract vocabulary or as text in the frame.
 */
const BLURRED_SCREEN =
  /\b(?:out of focus|out-of-focus|blurred|blurry|soft[- ]focus|unreadable|illegible|indistinct|no (?:legible|readable) (?:text|writing|words)|nothing legible|(?:soft |abstract |blurred |blurry |coloured |colored |pastel )+(?:shapes|blocks of colou?r|colou?r blocks|gradients?)|blocks of colou?r)\b/gi;

function withoutBlurPhrases(scene: string): string {
  return scene.replace(BLURRED_SCREEN, " ");
}

/** True when the scene says its screen shows nothing legible. */
export function screenIsBlurred(scene: string): boolean {
  return new RegExp(BLURRED_SCREEN.source, "i").test(scene);
}

/**
 * Every reason this scene may not be rendered, as the labels the agent is
 * told when it is asked again. Empty means the scene is acceptable.
 *
 * `subject` is the kind of business (lib/media/prompt.ts). For a digital
 * one, since 12 November 2026, a person at a laptop or a monitor is a
 * scene: the screen is allowed when the scene says it shows only blurred
 * shapes, with no legible text. A dashboard, an app, a website, a chart or
 * a spreadsheet is still refused for every subject, blurred or not: that is
 * legible UI, and image models fill it with letter-shaped noise. Before,
 * "no screens" for every subject pushed an article about AI SEO software
 * into a florist arranging tulips.
 */
export function sceneProblems(scene: string, subject: "physical" | "digital" = "physical"): string[] {
  const blurredScreen = subject === "digital" && screenIsBlurred(scene);
  const checked = blurredScreen ? withoutBlurPhrases(scene) : scene;
  const problems = [...abstractVocabularyIn(checked), ...writtenSurfacesIn(checked)];
  return blurredScreen ? problems.filter((label) => label !== "screen") : problems;
}

// ── Does the scene belong to this article? ──────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from get guide guides how i in into is it its me my of on or our " +
    "should the their this to top up use using vs versus what when where which who why will with without you your " +
    "best complete ways way tips step steps easy simple ultimate new make makes making"
  ).split(" ")
);

/** A word reduced to a comparable stem: "writers", "writer" and "writing" are one concept. */
function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  let stripped = false;
  for (const suffix of ["ing", "er", "ed"]) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      stripped = true;
      break;
    }
  }
  // "bake", "baker", "baking" and "baked" all end up "bak".
  if (!stripped && w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The concepts a text names: its content words, stemmed. */
export function conceptsOf(text: string): Set<string> {
  return new Set(
    text
      .split(/[^A-Za-z0-9]+/)
      .filter((word) => word.length >= 2 && !STOPWORDS.has(word.toLowerCase()))
      .map(stem)
      .filter((word) => word.length >= 2)
  );
}

/** The generic scene a software article may always use: a person working at a desk with a laptop or a monitor. */
export function isGenericDeskScene(scene: string): boolean {
  return /\bdesks?\b/i.test(scene) && /\b(?:laptops?|monitors?|computers?)\b/i.test(scene);
}

/**
 * The concepts the scene shares with the article, empty when none. A scene
 * that shares none, and is not the generic desk scene, belongs to another
 * article (the florist under "AI SEO Content Writer", 2026-11-12).
 */
export function sharedConcepts(scene: string, article: { title: string; keyword: string; heading?: string }): string[] {
  const wanted = [...conceptsOf(`${article.title} ${article.keyword} ${article.heading ?? ""}`)];
  // The same stem, or one inside the other when both are words of four
  // letters or more: "dough" belongs to an article on "sourdough".
  const same = (a: string, b: string) =>
    a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
  return [...conceptsOf(scene)].filter((concept) => wanted.some((w) => same(concept, w)));
}

/** The label the agent is told when its scene is about something else. */
export const OFF_TOPIC = "off-topic: the scene shares no idea with the article's title or keyword";

/** Why a scene does not belong to this article; empty when it does. */
export function relevanceProblems(scene: string, article: { title: string; keyword: string; heading?: string }): string[] {
  if (isGenericDeskScene(scene) || sharedConcepts(scene, article).length > 0) return [];
  return [OFF_TOPIC];
}

/**
 * The hero used when the model's scene is still off-topic after the second
 * ask: a person at a desk, the laptop seen from the side so no screen is in
 * the frame. Fixed text, not made from the title, and acceptable for every
 * subject.
 */
export const FALLBACK_HERO_SCENE = {
  scene:
    "A person working at a desk with an open laptop seen from the side, a paper notebook and a cup of coffee beside it, soft natural window light",
  alt: "A person working at a desk with an open laptop",
  caption: null,
} as const;

/** Alt text is one line a screen reader speaks; longer is cut off or skipped. */
export const ALT_MAX_LENGTH = 125;

const ALT_FRAMING =
  /\b(?:abstract|abstrakt\w*|abstrait\w*|abstract[oa]s?|astratt\w+|conceptual|representation|rappresentazione|representaci[oó]n|repr[ée]sentation|darstellung|represent(?:s|ing)|symboli[sz](?:e|es|ing)|depict(?:s|ing|ion)|illustration of|image of|picture of|photo(?:graph)? of|concept of|metaphor)\b/i;

/**
 * Alt text says what is in the picture, not what the picture means. "Abstract
 * representation of growth" describes an intention; a reader who cannot see
 * the image learns nothing from it. Alt text is in the article's language, so
 * only the framing words are checked here, in the languages articles are
 * written in; the scene it was written from has already passed the full
 * check. True when the alt frames instead of describing.
 */
export function altIsFraming(alt: string): boolean {
  return ALT_FRAMING.test(alt);
}
