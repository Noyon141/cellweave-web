"use client";

import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const handleGoogleSignIn = async () => {
    await signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
  };

  return (
    <div className="container mx-auto py-12 px-4 max-w-md">
      <h1 className="text-2xl font-bold">Sign In</h1>
      <p className="text-muted-foreground text-sm mt-1">
        Sign in to your CellWeave workspace using Google OAuth.
      </p>
      <div className="mt-6">
        <Button onClick={handleGoogleSignIn} className="w-full">
          Sign in with Google
        </Button>
      </div>
    </div>
  );
}

