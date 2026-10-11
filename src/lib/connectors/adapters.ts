// Each provider's adapter, by its id in lib/connectors (0204).
// Server only: an adapter reaches its provider and holds its login.
//
// Callers: src/app/api/connectors/route.ts, src/app/api/connectors/worker/route.ts,
// src/app/api/connectors/[provider]/hook/[token]/route.ts.
import * as goswift from "@/lib/connectors/goswift";
import * as shiprocket from "@/lib/connectors/shiprocket";

export const ADAPTERS = { shiprocket, goswift } as const;
