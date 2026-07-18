import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Wallet } from "lucide-react";
import "./globals.css";

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "newbudget",
  description: "Self-hosted envelope budgeting",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="flex min-h-screen">
          <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-sidebar">
            <div className="px-4 py-4 text-sm font-semibold tracking-tight">newbudget</div>
            <nav className="px-2">
              <Link
                href={`/budget/${currentMonthKey()}`}
                className="flex items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-sm font-medium"
              >
                <Wallet className="size-4" />
                Budget
              </Link>
            </nav>
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
      </body>
    </html>
  );
}
