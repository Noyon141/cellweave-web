import Link from "next/link";
import { Button } from "@/components/ui/button";
export default function AnalysesPage() {
  return (
    <div className="container mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold">Analysis Runs</h1>
      <p className="text-muted-foreground text-sm mt-1">
        Review quality metrics and explicitly confirm cell filtering.
      </p>
      <Button asChild>
        <Link href="/analyses/qc">Start quality control</Link>
      </Button>
    </div>
  );
}
