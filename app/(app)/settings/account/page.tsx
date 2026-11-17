import { requireAppAccess } from "@/lib/app-access";
import { signInMethod } from "@/lib/sign-in-method";
import { CONTACT_EMAIL } from "@/lib/site";
import { ThemeChoice } from "@/components/settings/theme-choice";
import { SignOutButton } from "@/components/settings/sign-out-button";

/**
 * Account: read-only. There is nothing to save here: the name comes from the
 * Google profile when there is one, and the email is the sign-in itself. The
 * page used to show an editable name and a Save button with no handler, and a
 * "UTC" timezone line the app does not follow.
 *
 * Appearance is the one choice on the page, and it is not saved to the
 * account either: System, Light or Dark lives in this browser (lib/theme.ts).
 *
 * Sign out is here since 2026-11-14: the phone lost its More sheet, and the
 * account menu that was in it.
 */
export default async function AccountPage() {
  const { user } = await requireAppAccess();
  const metadata = user?.user_metadata as { full_name?: unknown; name?: unknown } | undefined;
  const fullName =
    (typeof metadata?.full_name === "string" && metadata.full_name) ||
    (typeof metadata?.name === "string" && metadata.name) ||
    null;
  const email = user?.email ?? null;
  const method = signInMethod(user);

  return (
    <div className="flex-1 w-full flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Account</h1>
        <p className="text-muted-foreground">Who is signed in, and how.</p>
      </div>

      <dl className="space-y-6">
        {fullName && (
          <div className="space-y-1">
            <dt className="text-sm font-medium">Name</dt>
            <dd className="text-sm">{fullName}</dd>
            <dd className="text-xs text-muted-foreground">From your Google profile.</dd>
          </div>
        )}

        <div className="space-y-1">
          <dt className="text-sm font-medium">Email</dt>
          <dd className="text-sm break-all">{email ?? "Not available"}</dd>
          <dd className="text-xs text-muted-foreground">
            {method === "google"
              ? "You sign in with Google, as this address."
              : "You sign in with a link sent to this address."}{" "}
            It cannot be changed here. To move the account to another address, write to{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-foreground underline underline-offset-4"
            >
              {CONTACT_EMAIL}
            </a>
            .
          </dd>
        </div>
      </dl>

      <section aria-labelledby="appearance-heading" className="space-y-2">
        <h2 id="appearance-heading" className="text-sm font-medium">
          Appearance
        </h2>
        <ThemeChoice />
        <p className="text-xs text-muted-foreground">
          System follows your device and switches with it. The choice is kept on this device only.
        </p>
      </section>

      <section aria-labelledby="sign-out-heading" className="space-y-2">
        <h2 id="sign-out-heading" className="text-sm font-medium">
          Sign out
        </h2>
        <p className="text-xs text-muted-foreground">Signs out of this device. Your sites and settings stay as they are.</p>
        <SignOutButton />
      </section>
    </div>
  );
}
