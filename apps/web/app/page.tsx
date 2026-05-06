import { DailyHero } from "@/components/daily-hero";

export default function HomePage() {
  return (
    <main className="paper-grain flex h-dvh min-h-[640px] flex-col bg-background text-foreground">
      <DailyHero />
    </main>
  );
}
