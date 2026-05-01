import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function DailyHero() {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-[4/3] bg-muted" />
      <CardHeader>
        <h2 className="text-xl font-semibold">今日精选</h2>
        <p className="text-sm text-muted-foreground">AI 将每日为你挑选最值得回忆的瞬间</p>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-3/4" />
      </CardContent>
    </Card>
  );
}
