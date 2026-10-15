// Each provider's adapter, by its id in lib/connectors (0204).
// Server only: an adapter reaches its provider and holds its login.
//
// Callers: src/app/api/connectors/route.ts, src/app/api/connectors/worker/route.ts,
// src/app/api/connectors/[provider]/hook/[token]/route.ts.
import * as brevo from "@/lib/connectors/brevo";
import * as delhivery from "@/lib/connectors/delhivery";
import * as googleAds from "@/lib/connectors/google-ads";
import * as googleAnalytics from "@/lib/connectors/google-analytics";
import * as goswift from "@/lib/connectors/goswift";
import * as hubspot from "@/lib/connectors/hubspot";
import * as klaviyo from "@/lib/connectors/klaviyo";
import * as mailchimp from "@/lib/connectors/mailchimp";
import * as metaAds from "@/lib/connectors/meta-ads";
import * as metaSocial from "@/lib/connectors/meta-social";
import * as razorpay from "@/lib/connectors/razorpay";
import * as shiprocket from "@/lib/connectors/shiprocket";
import * as whatsapp from "@/lib/connectors/whatsapp";
import * as zendesk from "@/lib/connectors/zendesk";

export const ADAPTERS = {
  shiprocket,
  goswift,
  meta_ads: metaAds,
  google_ads: googleAds,
  google_analytics: googleAnalytics,
  mailchimp,
  brevo,
  zendesk,
  hubspot,
  meta_social: metaSocial,
  klaviyo,
  whatsapp,
  razorpay,
  delhivery,
} as const;
