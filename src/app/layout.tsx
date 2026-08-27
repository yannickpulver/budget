import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { MobileTopBar } from "@/components/mobile-top-bar";
import { Sidebar } from "@/components/sidebar";
import { UndoShortcuts } from "@/components/undo-buttons";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSidebarData } from "@/lib/queries";
import { undoState } from "@/lib/undo";
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
  title: "budget",
  description: "Self-hosted envelope budgeting",
};

// `viewportFit: "cover"` lets the layout paint under the notch/home bar; the
// `pt-safe` / `pb-safe` utilities keep the chrome that sits there clear of it.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const sidebarData = getSidebarData();
  const undo = undoState();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <TooltipProvider delay={200}>
          {/* Mounted once here, not per UndoButtons — the buttons render both
              in the sidebar and in the mobile top bar. */}
          <UndoShortcuts state={undo} />
          <div className="flex min-h-screen">
            <Sidebar data={sidebarData} undo={undo} />
            <main className="flex min-w-0 flex-1 flex-col">
              <MobileTopBar data={sidebarData} undo={undo} />
              {children}
            </main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
