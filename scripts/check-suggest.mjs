// What Luke's empty panel offers to ask, read off the store itself
// (lib/suggest.ts, 5 Oct): only what the store's own numbers show, never
// a need a section already meets, a few at most, strongest first. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-suggest.mjs

import { asksFromStore } from "../src/lib/suggest.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const none = {
  orders30: 0,
  cod30: 0,
  failedDeliveries: 0,
  refunds60: 0,
  lowStock: 0,
  repeatCustomers: 0,
  lateUnshipped: 0,
  abandoned30: 0,
};
const busy = {
  orders30: 40,
  cod30: 16,
  failedDeliveries: 3,
  refunds60: 5,
  lowStock: 2,
  repeatCustomers: 6,
  lateUnshipped: 4,
  abandoned30: 7,
};

check("a store that shows nothing is offered nothing", asksFromStore(none, []).length === 0);
const asks = asksFromStore(busy, []);
check("a few at most", asks.length === 3);
check("strongest first: COD at 40%", asks[0].label === "40% of orders are COD: confirm them first");
check("then the failed deliveries", asks[1].label.startsWith("3 deliveries failed"));
check(
  "each label fits one row of the panel",
  asksFromStore({ ...busy, failedDeliveries: 20, refunds60: 20, lowStock: 20 }, []).every((a) => a.label.length <= 42)
);
check(
  "each is a message to send, in plain words",
  asks.every((a) => a.prompt.length > 40 && !/_/.test(a.prompt))
);
check(
  "a need a section already meets is not offered again",
  !asksFromStore(busy, ["COD Confirmation", "RTO tracker"]).some((a) => /COD|deliver/.test(a.label))
);
check(
  "and the next ones come up in their place",
  asksFromStore(busy, ["COD Confirmation", "RTO tracker"])[0].label.startsWith("5 refunds")
);
check(
  "a little COD is not a COD store",
  !asksFromStore({ ...none, orders30: 100, cod30: 5 }, []).some((a) => /COD/.test(a.label))
);
check(
  "one failed delivery reads as one",
  asksFromStore({ ...none, failedDeliveries: 1 }, [])[0]?.label === "1 delivery failed: follow them up"
);

console.log(fails.length === 0 ? "\nthe panel offers what this store shows" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
