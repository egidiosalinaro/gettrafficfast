import Link from "next/link";
import { SetPasswordForm } from "@/components/set-password-form";

export const metadata = { robots: { index: false, follow: false } };

/**
 * Where the reviewer account's set-password email lands (docs/API.md "The
 * reviewer account"). Public, because the link may carry its session in the
 * URL fragment, before any cookie exists; the form checks the session and
 * the save route refuses any account not on PASSWORD_LOGIN_EMAILS.
 */
export default function SetPasswordPage() {
  return (
    <div className="min-h-svh flex flex-col">
      <header className="w-full border-b">
        <div className="w-full max-w-[1400px] mx-auto px-5 py-4">
          <Link href="/" className="flex items-center">
            <span className="text-xl font-bold">GetTrafficFast</span>
          </Link>
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-md">
          <SetPasswordForm />
        </div>
      </div>
    </div>
  );
}
