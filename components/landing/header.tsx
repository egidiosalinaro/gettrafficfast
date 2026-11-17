import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { UserMenu } from "@/components/user-menu";

export async function LandingHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="w-full">
      <div className="w-full max-w-[1400px] mx-auto px-5 py-3 flex justify-between items-center">
        <Link href="/" className="flex items-center gap-2">
          {/* The mark in the text's colour, so it holds in both themes. */}
          <BrandMark className="h-8 w-8" />
          <span className="text-xl font-bold">GetTrafficFast</span>
        </Link>
        <nav className="hidden md:flex items-center gap-6 text-sm">
          <Link href="/#product" className="hover:opacity-70 transition">
            Product
          </Link>
          <Link href="/#day" className="hover:opacity-70 transition">
            How you use it
          </Link>
          <Link href="/#pricing" className="hover:opacity-70 transition">
            Pricing
          </Link>
          <Link href="/#faq" className="hover:opacity-70 transition">
            FAQ
          </Link>
          <Link href="/docs" className="hover:opacity-70 transition">
            Docs
          </Link>
        </nav>
        {user ? (
          <UserMenu
            userEmail={user.email}
            avatarUrl={
              (user.user_metadata?.avatar_url as string | undefined) ??
              (user.user_metadata?.picture as string | undefined)
            }
          />
        ) : (
          <Link href="/auth/sign-up">
            <Button variant="outline" size="sm">
              Sign In
            </Button>
          </Link>
        )}
      </div>
    </header>
  );
}

