import Link from "next/link";
import { CONTACT_EMAIL, SITE_HOST } from "@/lib/site";
import { LEGAL_OPERATOR, vatNumberLine } from "@/lib/legal";

export function LandingFooter() {
  return (
    <footer className="w-full border-t bg-card">
      <div className="w-full max-w-[1400px] mx-auto px-5 py-12">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div>
            <Link href="/" className="text-xl font-bold mb-4 inline-block">
              GetTrafficFast
            </Link>
            <p className="text-sm text-muted-foreground">
              See whether answer engines cite your product on the prompts you
              chose, then publish the article that should be the source, or
              post the reply drafted in your voice.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/auth/sign-up" className="text-muted-foreground hover:text-foreground">
                  Sign In
                </Link>
              </li>
              <li>
                <Link href="/#pricing" className="text-muted-foreground hover:text-foreground">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/#examples" className="text-muted-foreground hover:text-foreground">
                  Examples
                </Link>
              </li>
              <li>
                <Link href="/docs" className="text-muted-foreground hover:text-foreground">
                  Docs
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-muted-foreground hover:text-foreground">
                  {CONTACT_EMAIL}
                </a>
              </li>
              <li>
                <Link href="/blog" className="text-muted-foreground hover:text-foreground">
                  Blog
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-sm">
              <li>
                <Link href="/privacy-policy" className="text-muted-foreground hover:text-foreground">
                  Privacy policy
                </Link>
              </li>
              <li>
                <Link href="/terms-and-conditions" className="text-muted-foreground hover:text-foreground">
                  Terms and conditions
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <div className="space-y-1 text-center md:text-left">
            <p>© {new Date().getFullYear()} GetTrafficFast. All rights reserved.</p>
            <p className="text-xs">
              {LEGAL_OPERATOR.name}, {LEGAL_OPERATOR.town}, {LEGAL_OPERATOR.country}
              {vatNumberLine() ? ` · ${vatNumberLine()}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <p className="text-xs">{SITE_HOST}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}

