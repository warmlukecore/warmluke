// Seven kinds of business for the Luke evals, each a few lines of data that
// business-shop.ts turns into a Shopify-shaped shop (evals/README.md).
//
// Each one is built for its cases. Windows are kept clear of rows: no order
// sits 6–8, 13–15 or 28–32 days back where a case asks about that window, so
// "last 7 days" and "last 30 days" read the same however they are counted. No
// count sits on a threshold a case names. Where a window matters, an older row
// would win if the window were ignored, so ignoring it shows.
//
// Nobody's real data: made-up names, example.com addresses, and phone numbers
// in a range no network hands out.

import type { BusinessShop } from "./business-shop.ts";

const COD = "Cash on Delivery (COD)";
const CARD = "razorpay";
const person = (name: string, n: number, city: string, zip: string, tags: string[] = []) => ({
  name,
  email: `${name.split(" ")[0].toLowerCase()}@example.com`,
  phone: `+9198200000${String(n).padStart(2, "0")}`,
  city,
  zip,
  tags,
});
const one = (price: number, cost: number, stock: number, sku?: string) => [
  { title: "Default Title", price, cost, stock, ...(sku ? { sku } : {}) },
];

/** Phone cases: a blank and the designs printed on it, one SKU on two listings, accessories. */
const cases: BusinessShop = {
  name: "cases",
  products: [
    {
      title: "Clear Case Blank - iPhone 17 Pro Max",
      type: "Blank",
      vendor: "Polyform Works",
      variants: one(199, 60, 120, "CASE-17PM-CLR"),
    },
    {
      title: "Cherry Heart Printed Case - iPhone 17 Pro Max",
      type: "Printed",
      vendor: "Studio Print",
      variants: one(599, 90, 0, "PRT-CHERRY-17PM"),
    },
    {
      title: "Cherry Heart Printed Case - iPhone 18 Pro Max",
      type: "Printed",
      vendor: "Studio Print",
      variants: one(599, 90, 7, "PRT-CHERRY-17PM"),
    },
    {
      title: "Retro Queen Printed Case - iPhone 17 Pro Max",
      type: "Printed",
      vendor: "Studio Print",
      variants: one(599, 90, 0, "PRT-RETRO-17PM"),
    },
    {
      title: "Spidey Vibes Printed Case - iPhone 17 Pro Max",
      type: "Printed",
      vendor: "Studio Print",
      variants: one(649, 95, 4, "PRT-SPIDEY-17PM"),
    },
    { title: "MagSafe Ring Holder", type: "Accessory", vendor: "Gripline", variants: one(399, 110, 0, "ACC-RING") },
    {
      title: "Lens Protector - iPhone 17 Pro",
      type: "Accessory",
      vendor: "Gripline",
      variants: one(249, 40, 35, "ACC-LENS-17P"),
    },
    {
      title: "Butterfly Phone Charm",
      type: "Accessory",
      vendor: "Charm Co",
      variants: [
        { title: "Pink", price: 199, cost: 30, stock: 0, sku: "ACC-CHARM-PNK" },
        { title: "Blue", price: 199, cost: 30, stock: 3, sku: "ACC-CHARM-BLU" },
      ],
    },
  ],
  customers: [
    person("Riya Kapoor", 1, "Delhi", "110001"),
    person("Aman Verma", 2, "Lucknow", "226001"),
    person("Sara Khan", 3, "Hyderabad", "500001"),
    person("Neel Joshi", 4, "Pune", "411001"),
  ],
  orders: [
    { daysBack: 1, customer: 0, lines: [[1, 1]], pay: "PENDING", gateway: COD, shipped: null },
    {
      daysBack: 3,
      customer: 1,
      lines: [
        [4, 1],
        [6, 1],
      ],
      pay: "PENDING",
      gateway: COD,
      shipped: null,
    },
    { daysBack: 5, customer: 2, lines: [[3, 1]], pay: "PAID", gateway: CARD, shipped: "IN_TRANSIT" },
    { daysBack: 10, customer: 3, lines: [[2, 2]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    {
      daysBack: 17,
      customer: 0,
      lines: [
        [5, 1],
        [7, 1],
      ],
      pay: "PAID",
      gateway: CARD,
      shipped: "DELIVERED",
    },
    { daysBack: 24, customer: 1, lines: [[1, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
  ],
};

/** Clothes in sizes: a tee's sizes, an unshipped backlog, older sales that would mislead without a window. */
const fashion: BusinessShop = {
  name: "fashion",
  products: [
    {
      title: "Classic Crew Tee",
      type: "Tee",
      vendor: "Loomline",
      variants: [
        { title: "S", price: 499, cost: 180, stock: 12, sku: "FAS-CRW-S" },
        { title: "M", price: 499, cost: 180, stock: 3, sku: "FAS-CRW-M" },
        { title: "L", price: 499, cost: 180, stock: 0, sku: "FAS-CRW-L" },
        { title: "XL", price: 499, cost: 180, stock: 8, sku: "FAS-CRW-XL" },
      ],
    },
    {
      title: "Oversized Graphic Tee",
      type: "Tee",
      vendor: "Loomline",
      variants: [
        { title: "S", price: 699, cost: 240, stock: 2, sku: "FAS-GRF-S" },
        { title: "M", price: 699, cost: 240, stock: 15, sku: "FAS-GRF-M" },
        { title: "L", price: 699, cost: 240, stock: 4, sku: "FAS-GRF-L" },
      ],
    },
    {
      title: "Slim Fit Jeans",
      type: "Jeans",
      vendor: "Denimcraft",
      variants: [
        { title: "30", price: 1199, cost: 520, stock: 6, sku: "FAS-JNS-30" },
        { title: "32", price: 1199, cost: 520, stock: 1, sku: "FAS-JNS-32" },
        { title: "34", price: 1199, cost: 520, stock: 9, sku: "FAS-JNS-34" },
      ],
    },
    {
      title: "Linen Shirt",
      type: "Shirt",
      vendor: "Loomline",
      variants: [
        { title: "M", price: 899, cost: 380, stock: 6, sku: "FAS-LIN-M" },
        { title: "L", price: 899, cost: 380, stock: 7, sku: "FAS-LIN-L" },
      ],
    },
  ],
  customers: [
    person("Ishaan Mehra", 11, "Delhi", "110001"),
    person("Kavya Rao", 12, "Bengaluru", "560001"),
    person("Arjun Das", 13, "Kolkata", "700001"),
    person("Tara Pillai", 14, "Kochi", "682001"),
    person("Rahul Sethi", 15, "Jaipur", "302001"),
  ],
  orders: [
    { daysBack: 1, customer: 0, lines: [[1, 2]], pay: "PAID", gateway: CARD, shipped: null },
    {
      daysBack: 3,
      customer: 1,
      lines: [
        [5, 1],
        [7, 1],
      ],
      pay: "PENDING",
      gateway: COD,
      shipped: null,
    },
    { daysBack: 5, customer: 2, lines: [[0, 1]], pay: "PAID", gateway: CARD, shipped: null },
    { daysBack: 9, customer: 3, lines: [[5, 2]], pay: "PAID", gateway: CARD, shipped: null },
    {
      daysBack: 12,
      customer: 4,
      lines: [
        [1, 1],
        [10, 1],
      ],
      pay: "PAID",
      gateway: CARD,
      shipped: "DELIVERED",
    },
    { daysBack: 16, customer: 0, lines: [[3, 1]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    {
      daysBack: 20,
      customer: 1,
      lines: [
        [6, 1],
        [2, 1],
      ],
      pay: "PAID",
      gateway: CARD,
      shipped: "DELIVERED",
    },
    { daysBack: 0, customer: 2, lines: [[4, 1]], pay: "PAID", gateway: CARD, shipped: null },
    { daysBack: 25, customer: 3, lines: [[5, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 10, customer: 4, lines: [[0, 1]], pay: "PAID", gateway: CARD, shipped: null, cancelled: true },
    { daysBack: 40, customer: 0, lines: [[0, 4]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 45, customer: 1, lines: [[4, 3]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 50, customer: 2, lines: [[0, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
  ],
  returns: [{ order: 4, line: 0, reason: "Size was too small", daysBack: 9 }],
};

/** Skincare: a week against the week before, and batches with an expiry kept in the app (the case's `before`). */
const cosmetics: BusinessShop = {
  name: "cosmetics",
  products: [
    { title: "Vitamin C Serum", type: "Serum", vendor: "Glowlab", variants: one(899, 260, 40) },
    { title: "Hyaluronic Moisturiser", type: "Moisturiser", vendor: "Glowlab", variants: one(699, 210, 25) },
    { title: "SPF 50 Sunscreen", type: "Sunscreen", vendor: "Glowlab", variants: one(549, 150, 60) },
    { title: "Niacinamide Toner", type: "Toner", vendor: "Glowlab", variants: one(449, 120, 18) },
    { title: "Matte Lip Tint", type: "Lip", vendor: "Glowlab", variants: one(299, 70, 80) },
  ],
  customers: [
    person("Nisha Arora", 21, "Mumbai", "400001"),
    person("Pooja Menon", 22, "Chennai", "600001"),
    person("Simran Gill", 23, "Chandigarh", "160001"),
    person("Ritu Bansal", 24, "Indore", "452001"),
  ],
  orders: [
    { daysBack: 0, customer: 0, lines: [[0, 1]], pay: "PAID", gateway: CARD, shipped: null },
    { daysBack: 2, customer: 1, lines: [[2, 2]], pay: "PAID", gateway: CARD, shipped: "IN_TRANSIT" },
    {
      daysBack: 4,
      customer: 2,
      lines: [
        [1, 1],
        [4, 1],
      ],
      pay: "PAID",
      gateway: CARD,
      shipped: "DELIVERED",
    },
    { daysBack: 5, customer: 3, lines: [[3, 1]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    { daysBack: 9, customer: 0, lines: [[0, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 11, customer: 1, lines: [[4, 3]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 12, customer: 2, lines: [[2, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 20, customer: 3, lines: [[0, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 24, customer: 0, lines: [[1, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
  ],
};

/** Gadgets: high-value COD, some shipped, one cancelled, one outside the month. */
const gadgets: BusinessShop = {
  name: "gadgets",
  products: [
    { title: "Wireless Earbuds Pro", type: "Audio", vendor: "Sonix", variants: one(2999, 1400, 30) },
    { title: "Smartwatch Fit", type: "Wearable", vendor: "Pulse", variants: one(5999, 3100, 12) },
    { title: "Bluetooth Speaker", type: "Audio", vendor: "Sonix", variants: one(3499, 1700, 20) },
    { title: "65W GaN Charger", type: "Charging", vendor: "Voltix", variants: one(1999, 900, 40) },
    { title: "Noise-cancelling Headphones", type: "Audio", vendor: "Sonix", variants: one(8999, 4600, 6) },
    { title: "USB-C Cable", type: "Charging", vendor: "Voltix", variants: one(299, 60, 100) },
  ],
  customers: [
    person("Karan Malhotra", 31, "Delhi", "110001"),
    person("Divya Shetty", 32, "Mangaluru", "575001"),
    person("Rohit Yadav", 33, "Patna", "800001"),
    person("Meghna Paul", 34, "Kolkata", "700001"),
    person("Sameer Qureshi", 35, "Bhopal", "462001"),
  ],
  orders: [
    { daysBack: 1, customer: 0, lines: [[1, 1]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 3, customer: 1, lines: [[4, 1]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    { daysBack: 5, customer: 2, lines: [[0, 1]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 10, customer: 3, lines: [[0, 2]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 12, customer: 4, lines: [[1, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 18, customer: 0, lines: [[2, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 21, customer: 1, lines: [[4, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 45, customer: 2, lines: [[1, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 8, customer: 3, lines: [[3, 1]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 16, customer: 4, lines: [[4, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 2, customer: 0, lines: [[1, 1]], pay: "PENDING", gateway: COD, shipped: null, cancelled: true },
  ],
};

/** Snacks: repeat buyers, some paying cash on delivery, one guest. */
const snacks: BusinessShop = {
  name: "snacks",
  products: [
    { title: "Masala Makhana", type: "Snack", vendor: "Crunch Kitchen", variants: one(199, 70, 50) },
    { title: "Peri Peri Chips", type: "Snack", vendor: "Crunch Kitchen", variants: one(149, 50, 80) },
    { title: "Jaggery Cookies", type: "Bakery", vendor: "Crunch Kitchen", variants: one(249, 90, 9) },
    { title: "Trail Mix", type: "Snack", vendor: "Crunch Kitchen", variants: one(349, 140, 30) },
    { title: "Dark Chocolate Bites", type: "Sweet", vendor: "Crunch Kitchen", variants: one(299, 120, 0) },
  ],
  customers: [
    person("Meera Iyer", 41, "Chennai", "600001"),
    person("Arjun Nair", 42, "Kochi", "682001"),
    person("Zoya Ali", 43, "Lucknow", "226001"),
    person("Vikram Rathore", 44, "Jodhpur", "342001"),
    person("Ananya Bose", 45, "Kolkata", "700001"),
    person("Dev Patel", 46, "Ahmedabad", "380001"),
  ],
  orders: [
    { daysBack: 40, customer: 0, lines: [[0, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 33, customer: 1, lines: [[1, 3]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 26, customer: 0, lines: [[2, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 21, customer: 2, lines: [[3, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 18, customer: 1, lines: [[0, 1]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 15, customer: 3, lines: [[1, 2]], pay: "PAID", gateway: COD, shipped: "DELIVERED" },
    { daysBack: 12, customer: 0, lines: [[4, 1]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 9, customer: 4, lines: [[0, 1]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    { daysBack: 6, customer: 2, lines: [[2, 2]], pay: "PENDING", gateway: COD, shipped: "IN_TRANSIT" },
    { daysBack: 4, customer: 5, lines: [[3, 1]], pay: "PAID", gateway: CARD, shipped: null },
    { daysBack: 3, customer: 0, lines: [[1, 1]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 2, customer: 3, lines: [[0, 1]], pay: "PAID", gateway: CARD, shipped: null },
    { daysBack: 1, customer: null, lines: [[1, 1]], pay: "PENDING", gateway: COD, shipped: null },
    { daysBack: 0, customer: 1, lines: [[3, 1]], pay: "PAID", gateway: CARD, shipped: null },
  ],
};

/** Wholesale: shops buying in bulk on 30-day terms, an old big order outside the quarter. */
const wholesale: BusinessShop = {
  name: "wholesale",
  products: [
    { title: "Basmati Rice 25kg", type: "Grain", vendor: "Annapurna Mills", variants: one(2450, 2000, 200) },
    { title: "Sunflower Oil 15L", type: "Oil", vendor: "Sunrise Agro", variants: one(2100, 1750, 150) },
    { title: "Toor Dal 30kg", type: "Pulses", vendor: "Annapurna Mills", variants: one(3600, 3000, 90) },
    { title: "Sugar 50kg", type: "Sugar", vendor: "Sweetfield", variants: one(2250, 1900, 120) },
  ],
  customers: [
    { ...person("Sharma Traders", 51, "Delhi", "110006", ["b2b"]), email: "orders@sharmatraders.example.com" },
    { ...person("Gupta Retail", 52, "Agra", "282001", ["b2b"]), email: "buy@guptaretail.example.com" },
    { ...person("Mehta Stores", 53, "Surat", "395001", ["b2b"]), email: "mehta@stores.example.com" },
    { ...person("Iyer Supermart", 54, "Madurai", "625001", ["b2b"]), email: "iyer@supermart.example.com" },
    { ...person("Khan and Sons", 55, "Aligarh", "202001", ["b2b"]), email: "khan@sons.example.com" },
  ],
  orders: [
    { daysBack: 120, customer: 3, lines: [[2, 10]], pay: "PAID", gateway: "Bank transfer", shipped: "DELIVERED" },
    { daysBack: 75, customer: 0, lines: [[0, 4]], pay: "PAID", gateway: "Net 30", shipped: "DELIVERED" },
    { daysBack: 60, customer: 1, lines: [[1, 5]], pay: "PENDING", gateway: "Net 30", shipped: "DELIVERED" },
    { daysBack: 45, customer: 0, lines: [[2, 3]], pay: "PENDING", gateway: "Net 30", shipped: "DELIVERED" },
    { daysBack: 38, customer: 2, lines: [[3, 2]], pay: "PENDING", gateway: "Net 30", shipped: "DELIVERED" },
    { daysBack: 20, customer: 1, lines: [[0, 2]], pay: "PENDING", gateway: "Net 30", shipped: "DELIVERED" },
    { daysBack: 12, customer: 0, lines: [[1, 3]], pay: "PAID", gateway: "Bank transfer", shipped: "DELIVERED" },
    { daysBack: 9, customer: 4, lines: [[2, 1]], pay: "PENDING", gateway: "Net 30", shipped: "IN_TRANSIT" },
    { daysBack: 4, customer: 1, lines: [[3, 4]], pay: "PENDING", gateway: "Net 30", shipped: null },
    { daysBack: 2, customer: 2, lines: [[0, 1]], pay: "PAID", gateway: "Bank transfer", shipped: null },
  ],
};

/**
 * Ethnic wear with its connections (the sprint's investigations, Days 9–11):
 * a courier's shipments where RTO rose from 10% to 30% over the last two
 * weeks, all of it on COD (50% against prepaid's 10%) and on both couriers
 * alike; two kurta sizes that run out before the 14-day restock; and an ad
 * export where the Diwali campaign's own orders buy exactly those sizes,
 * Retarget's buy a dupatta with plenty left, and Brand awareness has none.
 */
const ethnic: BusinessShop = {
  name: "ethnic",
  products: [
    {
      title: "Cotton Kurta Set",
      type: "Kurta",
      vendor: "Rangsutra",
      variants: [
        { title: "S", price: 1299, cost: 520, stock: 3, sku: "ETH-KRT-S" },
        { title: "M", price: 1299, cost: 520, stock: 40, sku: "ETH-KRT-M" },
        { title: "L", price: 1299, cost: 520, stock: 2, sku: "ETH-KRT-L" },
      ],
    },
    { title: "Printed Dupatta", type: "Dupatta", vendor: "Rangsutra", variants: one(499, 160, 120, "ETH-DUP") },
    { title: "Silk Saree", type: "Saree", vendor: "Kanchi Looms", variants: one(4999, 2400, 15, "ETH-SAR") },
  ],
  customers: [
    person("Meera Iyer", 61, "Chennai", "600001"),
    person("Sana Qureshi", 62, "Lucknow", "226001"),
    person("Pooja Bansal", 63, "Indore", "452001"),
    person("Nisha Thomas", 64, "Kochi", "682001"),
  ],
  orders: [
    // Diwali's own orders this week, named three ways: its name, in lower case, and its id.
    {
      daysBack: 1,
      customer: 0,
      lines: [
        [0, 1],
        [2, 1],
      ],
      pay: "PENDING",
      gateway: COD,
      shipped: null,
      campaign: "Diwali",
    },
    { daysBack: 2, customer: 1, lines: [[0, 2]], pay: "PENDING", gateway: COD, shipped: null, campaign: "Diwali" },
    {
      daysBack: 3,
      customer: 2,
      lines: [[2, 2]],
      pay: "PAID",
      gateway: CARD,
      shipped: "IN_TRANSIT",
      campaign: "diwali",
    },
    {
      daysBack: 4,
      customer: 3,
      lines: [[1, 1]],
      pay: "PAID",
      gateway: CARD,
      shipped: "IN_TRANSIT",
      campaign: "120201",
    },
    {
      daysBack: 5,
      customer: 0,
      lines: [
        [0, 1],
        [2, 1],
      ],
      pay: "PENDING",
      gateway: COD,
      shipped: "IN_TRANSIT",
      campaign: "Diwali",
    },
    // Cancelled: not one of Diwali's sales.
    {
      daysBack: 3,
      customer: 1,
      lines: [[0, 5]],
      pay: "PENDING",
      gateway: COD,
      shipped: null,
      cancelled: true,
      campaign: "Diwali",
    },
    // Retarget sells the dupatta.
    { daysBack: 2, customer: 2, lines: [[3, 3]], pay: "PAID", gateway: CARD, shipped: null, campaign: "Retarget" },
    {
      daysBack: 4,
      customer: 3,
      lines: [[3, 2]],
      pay: "PENDING",
      gateway: COD,
      shipped: "IN_TRANSIT",
      campaign: "Retarget",
    },
    // Earlier sales with no campaign: the pace each size sells at.
    { daysBack: 10, customer: 0, lines: [[0, 3]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 11, customer: 1, lines: [[2, 3]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    {
      daysBack: 18,
      customer: 2,
      lines: [
        [1, 1],
        [3, 5],
      ],
      pay: "PAID",
      gateway: CARD,
      shipped: "DELIVERED",
    },
    { daysBack: 20, customer: 3, lines: [[4, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
    { daysBack: 24, customer: 0, lines: [[4, 2]], pay: "PAID", gateway: CARD, shipped: "DELIVERED" },
  ],
  // Sent in the last two weeks: COD 10 of 20 settled back, prepaid 2 of 20; five COD still moving.
  // The two weeks before: 4 of 40 back. Each courier carries half of each, so payment is what moved.
  shipments: [
    { courier: "Delhivery", payment: "COD", daysBack: 5, n: 13, rto: 5, moving: 3 },
    { courier: "Bluedart", payment: "COD", daysBack: 6, n: 12, rto: 5, moving: 2 },
    { courier: "Delhivery", payment: "Prepaid", daysBack: 9, n: 10, rto: 1 },
    { courier: "Bluedart", payment: "Prepaid", daysBack: 10, n: 10, rto: 1 },
    { courier: "Delhivery", payment: "COD", daysBack: 18, n: 10, rto: 1 },
    { courier: "Bluedart", payment: "COD", daysBack: 19, n: 10, rto: 1 },
    { courier: "Delhivery", payment: "Prepaid", daysBack: 21, n: 10, rto: 1 },
    { courier: "Bluedart", payment: "Prepaid", daysBack: 23, n: 10, rto: 1 },
  ],
  ads: [
    { id: "120201", name: "Diwali", perDay: 1500, days: 7 },
    { id: "120202", name: "Retarget", perDay: 500, days: 7 },
    { id: "120203", name: "Brand awareness", perDay: 300, days: 7 },
  ],
  restockDays: 14,
};

export const SHOPS: Record<string, BusinessShop> = { cases, fashion, cosmetics, gadgets, snacks, wholesale, ethnic };
