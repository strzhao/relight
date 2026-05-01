import { Card } from "@/components/ui/card";

interface PhotoCardProps {
  title?: string;
  date?: string;
  tags?: string[];
}

export function PhotoCard({ title = "照片", date, tags = [] }: PhotoCardProps) {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-square bg-muted" />
      <div className="p-4">
        <h3 className="text-sm font-medium">{title}</h3>
        {date && <p className="mt-1 text-xs text-muted-foreground">{date}</p>}
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
