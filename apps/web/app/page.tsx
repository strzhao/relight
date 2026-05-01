import { DailyHero } from "@/components/daily-hero";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-8 text-center text-4xl font-bold tracking-tight">拾光</h1>
      <p className="mb-12 text-center text-muted-foreground">每天拾起一段值得回忆的时光</p>
      <DailyHero />
    </main>
  );
}
