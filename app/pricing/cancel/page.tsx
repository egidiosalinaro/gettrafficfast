import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function PricingCancelPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-5">
      <div className="max-w-md w-full text-center">
        <h1 className="text-3xl font-bold mb-4">Payment Canceled</h1>
        <p className="text-muted-foreground mb-8">
          Your payment was canceled. No charges were made.
        </p>
        <div className="flex gap-4 justify-center">
          <Link href="/pricing">
            <Button>Try Again</Button>
          </Link>
          <Link href="/">
            <Button variant="outline">Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}




