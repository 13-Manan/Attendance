"use server";

import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginService, logoutService } from "./service";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "./session";

export interface LoginState {
  error?: string;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function requestContext() {
  const headerStore = await headers();
  return {
    ipAddress: headerStore.get("x-forwarded-for"),
    userAgent: headerStore.get("user-agent"),
  };
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const result = await loginService(parsed.data.email, parsed.data.password, await requestContext());
  if (!result.ok) {
    return {
      error:
        result.reason === "account_inactive"
          ? "This account is inactive. Contact your administrator."
          : "Incorrect email or password.",
    };
  }

  (await cookies()).set(SESSION_COOKIE_NAME, result.rawToken, SESSION_COOKIE_OPTIONS);
  redirect("/");
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (rawToken) await logoutService(rawToken);
  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect("/login");
}
