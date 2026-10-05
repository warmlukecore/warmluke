// The seeds of the example library (4b, 5 Oct): designs that worked, on
// problems none of the evals ask about, so an eval still measures
// designing and not remembering. On their own, with nothing imported, so
// the console can show them beside the kept ones (lib/examples.ts reads
// them for Luke).

export interface DesignExample {
  id: string;
  /** What an owner said, in their words. */
  ask: string;
  /** What was built, in words a designer reads: which rows, what is recorded, what they press, what runs by itself. */
  design: string;
  /** Why this shape and not a bigger one, in a line. */
  why: string;
  tags: string[];
}

export const SEED_EXAMPLES: DesignExample[] = [
  {
    id: "seed-packing-desk",
    ask: "packing ke time galat item chala jaata hai, ya ek item kam. packer ko pata hi nahi chalta",
    design:
      "Over the store's own order items, no copy list: a packing screen where the packer scans the order's label, then each item's barcode; each scan ticks that line's packed count up, a wrong item says so on the spot, and when every line of the order is packed it moves to the next order by itself. One field on the store's items: packed (a number). A stat above: orders packed today.",
    why: "The scan is the real work here, so a written screen earns its place; the rows stay the store's.",
    tags: ["packing", "scan", "scanner", "barcode", "pack", "box", "wrong item", "dispatch", "check"],
  },
  {
    id: "seed-cod-remittance",
    ask: "courier COD ka paisa bhejta hai par match nahi hota kaunse order ka aaya kaunsa reh gaya",
    design:
      "On the store's own orders, filtered to COD and delivered: two fields of theirs, remitted on (a date) and remittance ref (text). A filter Remitted / Not remitted from the blank date, a stat of the money still owed (the total of delivered COD orders with no date), and a daily rule that raises an alert for any delivered COD order with no remittance after 10 days.",
    why: "A blank date already reads as not paid: no status to keep in step, and no second list of orders.",
    tags: ["cod", "remittance", "courier", "payment", "reconcile", "settlement", "paisa"],
  },
  {
    id: "seed-influencer-collabs",
    ask: "influencers ko free product bhejte hain, yaad nahi rehta kisne post kiya kisne nahi",
    design:
      "A Collabs section of their own: creator (text), handle (url), product sent (a link to the store's products), sent on (date), status (Sent, Posted, Ghosted), post link (url). A Posted button on a row that sets the status, a board by status, and a rule that turns a row Ghosted 21 days after it was sent with no post link.",
    why: "One status carries the whole story; the product is linked, not retyped.",
    tags: [
      "influencer",
      "creator",
      "collab",
      "barter",
      "gift",
      "reel",
      "content",
      "post",
      "posted",
      "sent",
      "instagram",
    ],
  },
  {
    id: "seed-supplier-restock",
    ask: "supplier ko order dete hain, kitna aaya kab aaya track nahi hota, aadha maal aata hai",
    design:
      "A Purchase orders section: supplier (dropdown of theirs), product (a link to the store's products), ordered qty, received qty (numbers), ordered on, expected on (dates), and a worked-out Short (ordered minus received). Status Ordered, Part received, Received, set by a rule from the two quantities. A filter by supplier and a stat of units still awaited.",
    why: "Part received is worked out from the counts, so nobody has to remember to change it.",
    tags: ["supplier", "purchase", "restock", "vendor", "inward", "stock", "maal"],
  },
  {
    id: "seed-whatsapp-complaints",
    ask: "WhatsApp pe complaints aati hain, follow up chhoot jaata hai, customer gussa ho jaata hai",
    design:
      "A Complaints section: order (a link to the store's orders, which fills the customer and phone), issue (dropdown: Late, Damaged, Wrong item, Other), notes (long text), status (Open, Waiting on courier, Resolved), opened on (date). A Resolved button, Open first, and a rule that alerts on any complaint open for more than 2 days.",
    why: "Picking the order fills who and where; the alert is the follow-up nobody remembers.",
    tags: ["complaint", "support", "whatsapp", "ticket", "follow up", "customer", "issue"],
  },
  {
    id: "seed-wholesale-part-payments",
    ask: "bulk orders aate hain retailers se, advance lete hain baaki baad mein, hisaab gadbad ho jaata hai",
    design:
      "A Wholesale orders section: retailer (text), phone, order value, advance paid, balance paid (currency), due on (date), and a worked-out Balance due. A filter Paid in full / Balance due from that figure, a stat of total balance due, and a daily alert for orders past due with a balance.",
    why: "The balance is worked out every time it is read, so it can never disagree with what was paid.",
    tags: ["wholesale", "b2b", "bulk", "retailer", "advance", "balance", "payment", "hisaab"],
  },
  {
    id: "seed-launch-plan",
    ask: "naye products launch karte hain toh photoshoot listing ads sab bikhra hua rehta hai",
    design:
      "A Launches section: product name, launch date, and one status that walks the steps (Planned, Shoot done, Listed, Ads live, Launched), with a button on each row for the next step. A calendar by launch date and a board by status.",
    why: "One status walked by buttons instead of a tick per step; the calendar is the plan they asked for.",
    tags: ["launch", "photoshoot", "listing", "ads", "calendar", "new product", "plan"],
  },
  {
    id: "seed-review-requests",
    ask: "delivered orders ke customers se review maangna bhool jaate hain",
    design:
      "On the store's own orders, delivered ones: one field of theirs, review asked on (a date), and a Review asked button that sets it to today. A filter Asked / Not asked from the blank date, newest delivered first, and a stat of delivered orders not yet asked this week.",
    why: "A field on the store's rows and a button; no copy list and no schedule rewriting every row.",
    tags: ["review", "feedback", "rating", "delivered", "follow up", "customer"],
  },
];
