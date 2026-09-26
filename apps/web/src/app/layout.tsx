import type { Metadata, Viewport } from "next";
import { Fraunces, Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";

const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap" });
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], display: "swap" });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], display: "swap" });

const description = "Your cards stay in the vault. Their value moves. Shard real Magic cards, sell them to verified humans, buy out at 80%.";

// Icons and share images come from the files next to this layout (icon.png, apple-icon.png, opengraph-image.png,
// twitter-image.png); metadataBase makes their URLs absolute for link previews.
export const metadata: Metadata = {
  metadataBase: new URL("https://www.kuravault.xyz"),
  title: "Kura · a storehouse for the cards you love",
  description,
  applicationName: "Kura",
  openGraph: { type: "website", siteName: "Kura", title: "Kura · a storehouse for the cards you love", description, url: "/" },
  twitter: { card: "summary_large_image", title: "Kura · a storehouse for the cards you love", description },
};

export const viewport: Viewport = { themeColor: "#111112", colorScheme: "dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${fraunces.variable} ${interTight.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
