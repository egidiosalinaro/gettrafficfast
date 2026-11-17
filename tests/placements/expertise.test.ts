import { describe, expect, it } from "vitest";
import { MAX_TOPICS, topicsFor } from "@/lib/placements/expertise";

/**
 * What the model is told the business knows about. The brand is not a
 * topic: GetTrafficFast's own knowledge graph lists the product beside the
 * subjects, and "GetTrafficFast" under "topics they know about" reads as
 * permission to write about the product.
 */
describe("topicsFor", () => {
  it("drops the business's own names, whatever their case, and repeats", () => {
    const topics = topicsFor(
      ["AI SEO content automation", "how to get cited by ChatGPT", "GetTrafficFast"],
      ["ChatGPT", "gettrafficfast", "Get Traffic Fast", "E-E-A-T", "chatgpt "],
      ["GetTrafficFast", "Get Traffic Fast"]
    );
    expect(topics).toEqual(["AI SEO content automation", "how to get cited by ChatGPT", "ChatGPT", "E-E-A-T"]);
  });

  it("caps the list and skips blanks", () => {
    const many = Array.from({ length: 60 }, (_, i) => `topic ${i}`);
    expect(topicsFor(many, ["", "  "], [])).toHaveLength(MAX_TOPICS);
    expect(topicsFor([], [], ["GetTrafficFast"])).toEqual([]);
  });
});
