import type { Metadata } from "next";
import { Bricolage_Grotesque, Instrument_Serif, Inter, Manrope } from "next/font/google";
import "./globals.css";

// The product's two faces. Twenty-one files reach for font-display,
// fifteen of them inside the app itself, so these stay exactly as
// they were: the pages a customer is sold on changed, the software
// they bought did not.
const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

// And the two the landing and the way in are set in. Added beside the
// others rather than swapped for them, so nothing in the app moves.
const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  // Italic is not a flourish here: one word of every headline is set
  // in it, so both styles have to be loaded or that word falls back
  // to a slanted sans and the whole line looks like a mistake.
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Warmluke",
  description:
    "Schema-driven business apps, generated in real-time through natural language.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${bricolage.variable} ${instrument.variable} ${inter.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
