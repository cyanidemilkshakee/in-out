import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const urbanist = localFont({
  src: "./fonts/urbanist-latin.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-urbanist",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: "IN / OUT Management System",
  description: "Database-backed prototype for inbound-outbound checkpoint operations"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={urbanist.variable}>
      <body>{children}</body>
    </html>
  );
}
