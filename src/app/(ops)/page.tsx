export default function OperationsConsolePage() {
  return (
    <div className="container mx-auto py-8 px-4">
      <div className="border border-red-500/20 bg-red-500/5 p-4 rounded-md mb-6">
        <h1 className="text-xl font-bold text-red-700 dark:text-red-400">
          Internal Operations Console
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Staff authorization boundary. Never accessible via customer credentials.
        </p>
      </div>
      <p className="text-muted-foreground text-sm">
        Operations diagnostics and tenant administration placeholder.
      </p>
    </div>
  );
}
