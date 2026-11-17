"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

/**
 * Sign out, on Settings → Account. Since 2026-11-14 the phone has no More
 * sheet and no account menu, so this is where a person signs out there; the
 * desktop sidebar's account menu does the same (user-menu-dashboard.tsx).
 */
export function SignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setSigningOut(true);
    setError(null);
    try {
      const { error: failed } = await createClient().auth.signOut();
      if (failed) throw failed;
      router.push("/auth/sign-up");
      router.refresh();
    } catch {
      setError("Could not sign out. Try again.");
      setSigningOut(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={signOut} disabled={signingOut} className="h-11 md:h-9">
        <LogOut className="h-4 w-4" aria-hidden="true" />
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
