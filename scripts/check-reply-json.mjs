// A reply read as JSON, or told precisely why not (lib/ai readJson).
//
// "Luke returned invalid JSON. Try rephrasing" left the repair blind: a
// packing screen asked for twice spent half its attempts there and was
// never built. Now a screen's raw line breaks inside a string are escaped
// and read, a reply cut off at the cap says so, and anything else says
// what the parser said and where. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-reply-json.mjs

import { readJson } from "../src/lib/ai.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const sound = readJson('{"type":"answer","message":"Hi"}');
check("sound JSON reads as it always did", sound.ok && sound.value.message === "Hi");

const screen = '{"type":"blueprint","html":"<div>\n  <b>Scan</b>\n\t</div>"}';
const raw = readJson(screen);
check(
  "a screen's raw line breaks inside a string are escaped and read",
  raw.ok && raw.value.html.includes("\n  <b>Scan</b>")
);

const escapedQuote = readJson('{"html":"<p class=\\"x\\">\nhi</p>"}');
check(
  "an escaped quote does not end the string early",
  escapedQuote.ok && escapedQuote.value.html === '<p class="x">\nhi</p>'
);

const cut = readJson('{"type":"blueprint","blueprint":{"plans":[{"html":"<div>unfinish');
check("a reply that stops inside a string was cut off, and says so", !cut.ok && /cut off/.test(cut.error));
const open = readJson('{"type":"blueprint","blueprint":{"plans":[]');
check("and so does one with brackets still open", !open.ok && /cut off/.test(open.error));

const broken = readJson('{"type":"answer" "message":"Hi"}');
check(
  "anything else says what the parser said, and where",
  !broken.ok && /not valid JSON/.test(broken.error) && /near/.test(broken.error) && !/cut off/.test(broken.error)
);

const outside = readJson('{\n  "type": "answer",\n  "message": "Hi"\n}');
check("line breaks between keys are left as they are", outside.ok && outside.value.type === "answer");

// A quote inside the words, sent bare: Luke's own reply on 3 Oct, which
// paid for the whole answer twice. A closing quote is followed by , } ]
// or :; this one by a word, so it is the words' own.
const badges = readJson(
  '{"type":"answer","kind":"product_help","message":"It fills in **repeat_reason** — one of three badges: "Same day" (both placed today), "Previous unfulfilled" or "Previous in transit"."}'
);
check(
  "a quote inside the words, sent unescaped, is read as the words'",
  badges.ok && badges.value.message.includes('badges: "Same day" (both placed today), "Previous unfulfilled"')
);
const keyed = readJson('{"type":"answer","message":"Say "hi" to them","next":[]}');
check("and the quotes that end strings and keys still end them", keyed.ok && Array.isArray(keyed.value.next));
const unsure = readJson('{"message":"he said "yes", then left"}');
check("a stray quote before a comma cannot be told apart, so it is sent back, not guessed", !unsure.ok);

console.log(fails.length === 0 ? "\na reply is read, or told exactly why not" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
