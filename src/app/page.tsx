import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function HomePage() {
  return (
    <div className="container mx-auto py-12 px-4 max-w-4xl">
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">CellWeave</h1>
            <Badge variant="secondary">Phase 0 Foundations</Badge>
          </div>
          <p className="text-muted-foreground">
            SaaS and Web boundary placeholder service for downstream single-cell RNA-seq analysis.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>System Status: Foundations Established</CardTitle>
            <CardDescription>
              Architectural boundaries, generated contracts, and integration abstractions verified.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-3 rounded border bg-muted/30">
                <div className="font-semibold mb-1">Architecture Boundaries</div>
                <div className="text-muted-foreground text-xs">
                  Web & Business • Orchestration Client • Storage Abstraction • Billing Provider
                </div>
              </div>
              <div className="p-3 rounded border bg-muted/30">
                <div className="font-semibold mb-1">Contract System</div>
                <div className="text-muted-foreground text-xs">
                  @cellweave/contracts generated types • Branded IDs • Zero handwritten contract
                  duplication
                </div>
              </div>
              <div className="p-3 rounded border bg-muted/30">
                <div className="font-semibold mb-1">Data Storage & Isolation</div>
                <div className="text-muted-foreground text-xs">
                  Neon PostgreSQL + Drizzle ORM • Multi-tenant TenantContext enforcement
                </div>
              </div>
              <div className="p-3 rounded border bg-muted/30">
                <div className="font-semibold mb-1">Operational Regulatory Boundary</div>
                <div className="text-muted-foreground text-xs">
                  Research Use Only (RUO) • Non-diagnostic • No PHI
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
