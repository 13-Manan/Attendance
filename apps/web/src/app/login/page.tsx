import { redirect } from "next/navigation";
import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 p-8">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-neutral-900">Sign in</h1>
        <p className="mb-6 text-sm text-neutral-500">Attendance Platform</p>
        <LoginForm />
      </div>
    </main>
  );
}
