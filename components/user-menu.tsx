"use client";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRouter, usePathname } from "next/navigation";
import { CreditCard, LogOut, LayoutDashboard } from "lucide-react";
import { useState } from "react";
import { useBillingPortal } from "@/components/billing/use-billing-portal";
import Link from "next/link";
import { APP_HOME } from "@/lib/app-home";

interface UserMenuProps {
  userEmail?: string;
  avatarUrl?: string;
}

export function UserMenu({ userEmail, avatarUrl }: UserMenuProps) {
  const router = useRouter();
  const pathname = usePathname();
  const billing = useBillingPortal();
  const isLoadingBilling = billing.opening;
  const [isLoadingLogout, setIsLoadingLogout] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const showAvatar = Boolean(avatarUrl) && !avatarFailed;
  
  const isDashboard = pathname?.startsWith("/dashboard") || 
    pathname === "/calendar" || 
    pathname === "/keywords" || 
    pathname === "/settings" || 
    pathname === "/help";

  const handleLogout = async () => {
    setIsLoadingLogout(true);
    try {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/auth/sign-up");
      router.refresh();
    } catch (error) {
      console.error("Error logging out:", error);
    } finally {
      setIsLoadingLogout(false);
    }
  };

  // Get user initials from email
  const getInitials = (email?: string) => {
    if (!email) return "U";
    const parts = email.split("@")[0];
    if (parts.length >= 2) {
      return parts.substring(0, 2).toUpperCase();
    }
    return email.substring(0, 1).toUpperCase();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 w-9 rounded-full p-0 overflow-hidden">
          {showAvatar ? (
            // Plain <img>: Google avatar hosts are not in next/image remotePatterns,
            // and no-referrer avoids googleusercontent 403s.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt="Profile"
              referrerPolicy="no-referrer"
              onError={() => setAvatarFailed(true)}
              className="h-full w-full rounded-full object-cover"
            />
          ) : (
            <span className="text-sm font-semibold">
              {getInitials(userEmail)}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {userEmail && (
          <>
            <div className="px-2 py-1.5 text-sm">
              <div className="font-medium">{userEmail}</div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {!isDashboard && (
          <>
            <DropdownMenuItem asChild>
              <Link href={APP_HOME}>
                <LayoutDashboard className="mr-2 h-4 w-4" />
                <span>Open the app</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          // Keep the menu open: the portal link arrives after a fetch, and a
          // failure is said here rather than in a native alert.
          onSelect={(event) => {
            event.preventDefault();
            billing.open();
          }}
          disabled={isLoadingBilling || isLoadingLogout}
        >
          <CreditCard className="mr-2 h-4 w-4" />
          <span>{isLoadingBilling ? "Opening billing..." : "Billing"}</span>
        </DropdownMenuItem>
        {billing.error && (
          <p role="alert" className="px-2 py-1.5 text-xs text-red-700 dark:text-red-400">
            {billing.error}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleLogout}
          disabled={isLoadingBilling || isLoadingLogout}
          className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:text-red-400 dark:focus:text-red-300 dark:focus:bg-red-950"
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>Logout</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

