import { QcReview } from "@/components/scientific/qc-review";
export default async function QcReviewPage({ params }: { params: Promise<{ runId: string }> }) {
  return (
    <main className="container mx-auto max-w-6xl px-4 py-8">
      <QcReview runId={(await params).runId} />
    </main>
  );
}
