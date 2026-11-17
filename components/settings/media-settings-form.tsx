"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Image as ImageIcon, Loader2, Youtube } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MEDIA_SETTINGS,
  IMAGE_STYLES,
  INLINE_IMAGE_OPTIONS,
  MediaSettings,
} from "@/lib/media/settings";
import { refreshOnboarding } from "@/lib/onboarding";
import { BrandPalettePicker } from "./brand-palette-picker";
import { ImageStylePreview } from "./image-style-preview";

/**
 * Media settings.
 *
 * Two questions are the customer's: how should the images look, and how many
 * does an article get: one featured image unless the business asks for
 * in-article ones too. Images are included in the plan, so no choice shows a
 * price; what a render costs the platform is the owner's (docs/MEDIA.md).
 * Format and quality stay product decisions.
 *
 * The videos switch is offered only when the platform can actually look for
 * videos (`videoAvailable` from the API). A switch that does nothing is a
 * promise the product does not keep.
 */

const STYLE_INSTRUCTIONS_MAX = 500;

/** The choice of how many images an article gets. */
export function InlineImagesChoice({
  value,
  onChange,
}: {
  value: number;
  onChange: (count: number) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium leading-none">Images per article</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {INLINE_IMAGE_OPTIONS.map((option) => {
          const isSelected = value === option.count;
          return (
            <label
              key={option.count}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition",
                isSelected
                  ? "border-foreground ring-1 ring-foreground"
                  : "border-border hover:border-foreground/40"
              )}
            >
              <input
                type="radio"
                name="inline-images"
                checked={isSelected}
                onChange={() => onChange(option.count)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="block font-medium">{option.label}</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Images are included in your plan. In-article images are added only where
        a section is easier to grasp with a picture, so an article can get fewer
        than the number you allow, never more.
      </p>
    </fieldset>
  );
}

/**
 * The videos card. `available` is whether the platform can look for videos
 * at all: null while unknown (no switch yet), false when it cannot, and then
 * the card says so instead of offering a switch.
 */
export function VideosCard({
  available,
  enabled,
  onChange,
}: {
  available: boolean | null;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Youtube className="h-5 w-5" />
            <h2 className="text-xl font-semibold">YouTube videos</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Find a genuinely relevant YouTube video for each article and attach
            it to the right section. If nothing clears the relevance bar, no
            video is added. That is the normal outcome.
          </p>
        </div>
        {available === true && (
          <label className="flex items-center gap-2 text-sm font-medium shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onChange(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Enabled
          </label>
        )}
      </div>
      {available === false && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-100"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Videos are not available right now. Video search is not set up on
            GetTrafficFast yet, so no article gets a video
            {enabled ? ", even though this was turned on for your site" : ""}. It
            is on our side: there is nothing for you to change, and nothing is
            spent on it.
          </p>
        </div>
      )}
    </Card>
  );
}

export function MediaSettingsForm() {
  const [settings, setSettings] = useState<MediaSettings>(DEFAULT_MEDIA_SETTINGS);
  const [hasBusiness, setHasBusiness] = useState(true);
  // Unknown until the API answers; the videos card offers no switch before.
  const [videoAvailable, setVideoAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/business/media-settings");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setSettings(data.settings);
        setHasBusiness(data.hasBusiness);
        setVideoAvailable(data.videoAvailable === true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof MediaSettings>(key: K, value: MediaSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      const res = await fetch("/api/business/media-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "Failed to save settings" });
        return;
      }
      setSettings(data.settings);
      setMessage({ type: "success", text: "Images and video settings saved." });
      refreshOnboarding();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-6">
      {message && (
        <div
          className={`flex items-center gap-2 p-4 rounded-md ${
            message.type === "success"
              ? "bg-green-50 dark:bg-green-950/40 text-green-900 dark:text-green-100 border border-green-200 dark:border-green-800"
              : "bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100 border border-red-200 dark:border-red-800"
          }`}
        >
          {message.type === "success" ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : (
            <AlertCircle className="h-5 w-5" />
          )}
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {!hasBusiness && (
        <div className="flex items-center gap-2 p-4 rounded-md bg-yellow-50 dark:bg-yellow-950/40 border border-yellow-200 dark:border-yellow-800 text-sm text-yellow-900 dark:text-yellow-100">
          <AlertCircle className="h-5 w-5 shrink-0" />
          Set up your business first (Settings → Business): media settings are saved per business.
        </div>
      )}

      <Card className="p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <ImageIcon className="h-5 w-5" />
              <h2 className="text-xl font-semibold">AI Images</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Every article gets one featured image, generated for it and
              included in your plan. Off until you turn it on; from then on
              every new article gets its image.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.imagesEnabled}
              onChange={(e) => set("imagesEnabled", e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Enabled
          </label>
        </div>

        {settings.imagesEnabled && (
          <div className="space-y-6 pt-4 border-t border-border">
            <InlineImagesChoice
              value={settings.inlineImagesPerArticle}
              onChange={(count) => set("inlineImagesPerArticle", count)}
            />

            <div className="space-y-3">
              <Label>Image style</Label>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {IMAGE_STYLES.map((style) => {
                  const isSelected = settings.style === style.value;
                  return (
                    <button
                      key={style.value}
                      type="button"
                      onClick={() => set("style", style.value)}
                      aria-pressed={isSelected}
                      className={cn(
                        // flex-col is load-bearing: a stretched <button> centres
                        // its own content box, so the cards with shorter
                        // descriptions were padded above AND below, leaving a
                        // white band over the thumbnail. As a flex column the
                        // content starts at the top and the slack goes below.
                        "flex h-full flex-col overflow-hidden rounded-lg border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected
                          ? "border-foreground ring-1 ring-foreground"
                          : "border-border hover:border-foreground/40",
                        style.value === "custom" && !isSelected && "border-dashed"
                      )}
                    >
                      <div className="aspect-[16/10] w-full overflow-hidden bg-muted">
                        <ImageStylePreview style={style.value} />
                      </div>
                      <div className="p-3">
                        <div className="text-sm font-medium">{style.label}</div>
                        <div className="mt-0.5 text-xs leading-snug text-muted-foreground">
                          {style.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Images show real people, places and objects, never text or
                screens. With Photography, a business that has nothing physical
                to photograph (software, an online service) gets a clean
                editorial illustration instead.
              </p>
            </div>

            {settings.style === "custom" && (
              <div className="space-y-2">
                <Label htmlFor="media-style-instructions">Image instructions</Label>
                <Textarea
                  id="media-style-instructions"
                  value={settings.styleInstructions}
                  onChange={(e) => set("styleInstructions", e.target.value)}
                  maxLength={STYLE_INSTRUCTIONS_MAX}
                  rows={3}
                  placeholder="Be specific about what you want AND what to avoid. E.g. 'Watercolour painting, soft edges, organic textures, artistic feel. Do NOT create photographs, 3D renders, diagrams or infographics.'"
                />
                <div className="flex items-start justify-between gap-4">
                  <p className="text-xs text-muted-foreground">
                    Write your own style. Tip: include what to avoid, e.g. &quot;Do NOT
                    create diagrams.&quot;
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {settings.styleInstructions.length}/{STYLE_INSTRUCTIONS_MAX}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <Label>Brand colors</Label>
              <BrandPalettePicker
                value={settings.brandPalette}
                onChange={(colors) => set("brandPalette", colors)}
              />
            </div>
          </div>
        )}
      </Card>

      <VideosCard
        available={videoAvailable}
        enabled={settings.videosEnabled}
        onChange={(enabled) => set("videosEnabled", enabled)}
      />

      <Button type="submit" size="lg" disabled={saving || !hasBusiness} className="w-full sm:w-auto">
        {saving ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          "Save Changes"
        )}
      </Button>
    </form>
  );
}
