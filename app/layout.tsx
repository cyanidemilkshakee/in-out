import type { Metadata } from "next";
import { Urbanist } from "next/font/google";
import { AppProviders } from "../components/AppProviders";
import "./globals.css";

const urbanist = Urbanist({
  subsets: ["latin"],
  variable: "--font-urbanist",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: "IN / OUT Management System",
  description: "Mock frontend for inbound-outbound checkpoint operations"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={urbanist.variable}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
