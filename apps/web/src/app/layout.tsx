import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegistrar } from "@/components/offline/service-worker-registrar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Attendance Platform",
  description: "Face recognition attendance management for schools and colleges",
  manifest: "/manifest.webmanifest",
  // iOS ignores the web manifest's icons; this is the only way an installed
  // home-screen shortcut gets a real icon there.
  appleWebApp: {
    capable: true,
    title: "Attendance",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

/**
 * Next sets `width=device-width, initial-scale=1` on its own; the only thing
 * worth adding is the theme colour, matching the manifest so an installed
 * window is not a different shade from the app inside it.
 *
 * Deliberately absent: `maximumScale` / `userScalable: false`. Pinch-zoom is
 * how somebody reads a roster on a phone they are holding at arm's length.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#171717" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Renders no markup — it only registers the app-shell worker, and
            only in production builds. The layout is otherwise unchanged. */}
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
