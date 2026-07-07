import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
