import { VoiceSettingsForm } from "@/components/settings/voice-settings-form";

export const dynamic = "force-dynamic";

export default function VoicePage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold mb-2">Voice and facts</h1>
        <p className="text-muted-foreground">
          How GetTrafficFast sounds when it writes in your name, and the facts it may use. Replies speak only from
          About you; articles only from Facts for articles. Every reply draft still goes through the audit before
          you can copy it.
        </p>
      </div>
      <VoiceSettingsForm />
    </div>
  );
}
