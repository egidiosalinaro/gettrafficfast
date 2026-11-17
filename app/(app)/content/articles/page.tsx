import { CalendarView } from "@/components/dashboard/calendar-view";
import { BackToContent } from "@/components/content/back-to-content";

/** "All articles": the full production board, every article by day. */
export default function ContentArticlesPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6">
      <div>
        <BackToContent />
        <h1 className="text-3xl font-bold">Articles</h1>
      </div>
      <CalendarView />
    </div>
  );
}
