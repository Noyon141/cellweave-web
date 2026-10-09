import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CellWeave — Single-Cell RNA-seq Analysis Platform",
  description:
    "Production-grade downstream single-cell RNA-seq analysis platform. Research Use Only (RUO).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased text-foreground">
        <header className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground flex justify-between items-center">
          <div>
            <span className="font-semibold text-foreground">CellWeave</span> — Phase 0 Placeholder
            Service
          </div>
          <div className="font-medium bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded border border-amber-500/20">
            Research Use Only • Non-Diagnostic • PHI Prohibited
          </div>
        </header>
        <main className="min-h-[calc(100vh-41px)]">{children}</main>
      </body>
    </html>
  );
}
