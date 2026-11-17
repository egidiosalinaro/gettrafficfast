"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, CheckCircle2, AlertCircle, Languages } from "lucide-react";
import {
  DEFAULT_CONTENT_LANGUAGE,
  SUPPORTED_CONTENT_LANGUAGES,
} from "@/lib/content-language";
import { CONTACT_EMAIL } from "@/lib/site";
import { APP_HOME } from "@/lib/app-home";

interface BusinessData {
  name: string;
  websiteUrl: string;
  niche: string;
  description: string;
  sitemapUrl: string;
  blogUrl: string;
  contentLanguage: string;
  isLocked: boolean;
}

export default function BusinessPage() {
  const [businessData, setBusinessData] = useState<BusinessData>({
    name: "",
    websiteUrl: "",
    niche: "",
    description: "",
    sitemapUrl: "",
    blogUrl: "",
    contentLanguage: DEFAULT_CONTENT_LANGUAGE,
    isLocked: false,
  });
  const [descriptionLength, setDescriptionLength] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  /**
   * "Add a site" opens the same form with nothing in it, and saving creates a
   * second business instead of editing the selected one. Read from the URL in
   * an effect rather than with useSearchParams, which would drag a Suspense
   * boundary into a form that has no other reason for one.
   */
  const [isNew, setIsNew] = useState(false);

  // Load existing business data
  useEffect(() => {
    const creating = new URLSearchParams(window.location.search).get("new") === "1";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the URL on mount, see above; flagged by eslint-plugin-react-hooks 7.1
    setIsNew(creating);

    async function loadBusinessData() {
      if (creating) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch("/api/business/get");
        if (!response.ok) {
          throw new Error("Failed to load business data");
        }
        const { business } = await response.json();
        
        if (business) {
          setBusinessData({
            name: business.name || "",
            websiteUrl: business.website_url || "",
            niche: business.niche || "",
            description: business.description || "",
            sitemapUrl: business.sitemap_url || "",
            blogUrl: business.blog_url || "",
            contentLanguage: business.content_language || DEFAULT_CONTENT_LANGUAGE,
            isLocked: business.is_locked || false,
          });
          setDescriptionLength(business.description?.length || 0);
          // If business has been saved before, mark as analyzed
          if (business.is_locked || business.niche || business.description || business.sitemap_url || business.blog_url) {
            setHasAnalyzed(true);
          }
        }
      } catch (error) {
        console.error("Error loading business data:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadBusinessData();
  }, []);

  // Check if we should mark as analyzed when loading existing data
  useEffect(() => {
    if (businessData.niche || businessData.description || businessData.sitemapUrl || businessData.blogUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- existing derived-state effect, flagged by eslint-plugin-react-hooks 7.1; behaviour unchanged
      setHasAnalyzed(true);
    }
  }, [businessData.niche, businessData.description, businessData.sitemapUrl, businessData.blogUrl]);

  const handleAnalyze = async () => {
    if (!businessData.websiteUrl || businessData.isLocked) return;

    setIsAnalyzing(true);
    setMessage(null);

    try {
      const response = await fetch("/api/business/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          websiteUrl: businessData.websiteUrl,
          contentLanguage: businessData.contentLanguage,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to analyze website");
      }

      const analysis = await response.json();

      setBusinessData((prev) => ({
        ...prev,
        niche: analysis.niche || prev.niche,
        description: analysis.description || prev.description,
        sitemapUrl: analysis.sitemapUrl || prev.sitemapUrl,
        blogUrl: analysis.blogUrl || prev.blogUrl,
      }));
      setDescriptionLength(analysis.description?.length || 0);
      setHasAnalyzed(true);
      setMessage({
        type: "success",
        text: "Website analyzed successfully! Please review and adjust the fields as needed.",
      });
    } catch (error) {
      console.error("Error analyzing website:", error);
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to analyze website. Please try again.",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/business/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: businessData.name,
          websiteUrl: businessData.websiteUrl,
          niche: businessData.niche,
          description: businessData.description,
          sitemapUrl: businessData.sitemapUrl,
          blogUrl: businessData.blogUrl,
          contentLanguage: businessData.contentLanguage,
          createNew: isNew,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save business data");
      }

      const { business } = await response.json();
      
      setBusinessData((prev) => ({
        ...prev,
        isLocked: business.is_locked || true,
      }));

      const firstSetup = !businessData.isLocked || isNew;

      setMessage({
        type: "success",
        text: isNew
          ? "Site added. It is now the selected one."
          : firstSetup
            ? "Business saved. Next the agent proposes keywords for this site."
            : "Business information saved successfully!",
      });

      // First save (or a newly added site) goes to Today, the first screen
      // of the day, not this form again.
      setTimeout(() => {
        window.location.href = firstSetup ? APP_HOME : "/settings/business";
      }, 1500);
    } catch (error) {
      console.error("Error saving business data:", error);
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to save business data. Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleInputChange = (field: keyof BusinessData, value: string) => {
    if (field === "description") {
      setDescriptionLength(value.length);
    }
    setBusinessData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  if (isLoading) {
    return (
      <div className="flex-1 w-full flex flex-col gap-8 max-w-3xl">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isNameEditable = !businessData.isLocked;
  const isWebsiteUrlEditable = !businessData.isLocked;
  // These fields are editable only after analysis and before save
  const areAnalysisFieldsEditable = !businessData.isLocked && hasAnalyzed;
  // Description is editable after analysis OR after save (always editable once analyzed or saved)
  const isDescriptionEditable = hasAnalyzed || businessData.isLocked;

  return (
    <div className="flex-1 w-full flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">{isNew ? "Add a site" : "Business"}</h1>
        <p className="text-muted-foreground">
          {isNew
            ? "A second site gets its own keywords, calendar, articles and destination. Nothing is shared with the one you already have."
            : "The name, address, niche and language GetTrafficFast writes and measures for."}
        </p>
      </div>

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

      <form onSubmit={handleSave} className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            type="text"
            value={businessData.name}
            onChange={(e) => handleInputChange("name", e.target.value)}
            disabled={!isNameEditable}
            className={!isNameEditable ? "bg-muted" : ""}
            required
          />
          <p className="text-xs text-muted-foreground">
            The name of your business as it appears to your customers
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="websiteUrl">Website URL</Label>
          <div className="flex gap-2">
            <Input
              id="websiteUrl"
              name="websiteUrl"
              type="url"
              value={businessData.websiteUrl}
              onChange={(e) => {
                handleInputChange("websiteUrl", e.target.value);
                setHasAnalyzed(false);
              }}
              disabled={!isWebsiteUrlEditable}
              className={!isWebsiteUrlEditable ? "bg-muted" : ""}
              placeholder="https://example.com"
              required
            />
            {!businessData.isLocked && (
              <Button
                type="button"
                onClick={handleAnalyze}
                disabled={!businessData.websiteUrl || isAnalyzing || businessData.websiteUrl.trim() === ""}
                className="whitespace-nowrap"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  "Analyze Website"
                )}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            The URL of your business website
          </p>
          {!businessData.isLocked && !hasAnalyzed && (
            <p className="text-xs text-muted-foreground mt-2">
              Click &quot;Analyze Website&quot; to let our AI analyze your website and automatically fill in the niche, description, sitemap URL, and blog URL. This may take a few moments.
            </p>
          )}
          {businessData.isLocked && (
            <p className="text-xs text-muted-foreground mt-2">
              Your website URL is fundamental to how we generate content for your account. This setting is locked to maintain consistency and prevent misuse. If you need to change your website URL, please reach out to our support team at{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-foreground underline underline-offset-4">
                {CONTACT_EMAIL}
              </a>{" "}
              and we&apos;ll help you set up a new business profile that aligns with your needs.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="contentLanguage" className="flex items-center gap-1.5">
            <Languages className="h-4 w-4" />
            Content Language
          </Label>
          <select
            id="contentLanguage"
            name="contentLanguage"
            value={businessData.contentLanguage}
            onChange={(e) => handleInputChange("contentLanguage", e.target.value)}
            className="flex h-11 w-full max-w-xs rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus:outline-none focus:ring-1 focus:ring-ring md:h-9 md:text-sm"
          >
            {SUPPORTED_CONTENT_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            <strong>Your description, keywords and articles will be generated in
            this language</strong>, independent of the language of your website.
            For example, pick English here to run an English blog for an
            Italian-language site.
          </p>
          {hasAnalyzed && !businessData.isLocked && (
            <p className="text-xs text-muted-foreground">
              Changed the language after analyzing? Click &quot;Analyze
              Website&quot; again to regenerate the niche and description in the
              new language.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="niche">Niche</Label>
          <Input
            id="niche"
            name="niche"
            type="text"
            value={businessData.niche}
            onChange={(e) => handleInputChange("niche", e.target.value)}
            disabled={!areAnalysisFieldsEditable}
            className={!areAnalysisFieldsEditable ? "bg-muted" : ""}
            placeholder={!hasAnalyzed ? "Will be filled after website analysis" : ""}
          />
          <p className="text-xs text-muted-foreground">
            The main industry or category your business operates in (max 3 words)
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <div className="relative">
            <Textarea
              id="description"
              name="description"
              value={businessData.description}
              onChange={(e) => handleInputChange("description", e.target.value)}
              disabled={!isDescriptionEditable}
              className={`pr-16 ${!isDescriptionEditable ? "bg-muted" : ""}`}
              maxLength={1000}
              rows={6}
              placeholder={!hasAnalyzed ? "Will be filled after website analysis" : ""}
            />
            <div className="absolute bottom-2 right-2 text-xs text-muted-foreground">
              {descriptionLength}/1000 characters
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            A brief description of what your business is about
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sitemapUrl">Sitemap URL</Label>
          <Input
            id="sitemapUrl"
            name="sitemapUrl"
            type="url"
            value={businessData.sitemapUrl}
            onChange={(e) => handleInputChange("sitemapUrl", e.target.value)}
            disabled={!areAnalysisFieldsEditable}
            className={!areAnalysisFieldsEditable ? "bg-muted" : ""}
            placeholder={!hasAnalyzed ? "Will be filled after website analysis" : ""}
          />
          <p className="text-xs text-muted-foreground">
            The URL that points to your sitemap.xml file
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="blogUrl">Blog URL</Label>
          <Input
            id="blogUrl"
            name="blogUrl"
            type="url"
            value={businessData.blogUrl}
            onChange={(e) => handleInputChange("blogUrl", e.target.value)}
            disabled={!areAnalysisFieldsEditable}
            className={!areAnalysisFieldsEditable ? "bg-muted" : ""}
            placeholder={!hasAnalyzed ? "Will be filled after website analysis" : ""}
          />
          <p className="text-xs text-muted-foreground">
            The URL where your blog articles are published
          </p>
        </div>

        {!businessData.isLocked && hasAnalyzed && (
          <div className="bg-yellow-50 dark:bg-yellow-950/40 border border-yellow-200 dark:border-yellow-800 rounded-md p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100 mb-1">
                  Important Notice
                </p>
                <p className="text-xs text-yellow-800 dark:text-yellow-200">
                  After clicking &quot;Save Changes&quot;, the Name, Website URL, Niche, Sitemap URL, and Blog URL fields will be locked and cannot be modified. Only the Description field will remain editable. Please review all fields carefully before saving.
                </p>
              </div>
            </div>
          </div>
        )}

        <Button
          type="submit"
          size="lg"
          className="w-full sm:w-auto"
          disabled={isSaving || isAnalyzing || (!hasAnalyzed && !businessData.isLocked)}
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
        {!hasAnalyzed && !businessData.isLocked && (
          <p className="text-xs text-muted-foreground">
            Please analyze your website first before saving.
          </p>
        )}
      </form>
    </div>
  );
}
